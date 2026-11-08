# Backup & recovery runbook

This runbook is for the Supabase-backed version of the app (the one with sign-in and
Settings → Change password). Commands assume a Mac with the repository at
`~/Desktop/eatatnestinventory`.

## Targets

| | Target | How it is met |
|---|---|---|
| **RPO** (data that could be lost) | **≤ 24 hours** with our nightly backup alone. **Minutes** if Supabase Point-in-Time Recovery is enabled. | Nightly encrypted dump at 02:00 IST, plus Supabase's own daily backups (Pro) or PITR (add-on). |
| **RTO** (time to be working again) | **≤ 2 hours** | Create a new Supabase project (~5 min), restore with one script (seconds to minutes; it took under a minute in the test drill), recreate logins, update `config.js` (~30 min). |

Everyday mistakes need no restore at all. Nothing is ever deleted: a "deleted" sale,
purchase, stock count, wastage entry, price or recipe is only marked void and stays in the
database, and every change is in `audit_log` with who made it and when. See §4.

## The backup layers

| Layer | Frequency | Kept for | Where | Independent of Supabase? |
|---|---|---|---|---|
| GitHub Actions dump (`.github/workflows/backup.yml`) | nightly 02:00 IST + on demand | 90 days | GitHub artifacts, AES-256 encrypted | **yes** |
| Supabase daily backups (Pro plan) | daily | 7 days (Pro) | Supabase | no |
| Supabase PITR (optional add-on) | continuous | per add-on | Supabase | no |
| Monthly off-platform copy (owner) | monthly | as long as you keep it | USB drive / Google Drive | **yes** (also independent of GitHub) |

Every nightly run **restores the dump into a separate empty PostgreSQL server and verifies
it** before the backup is kept. The restore runs as an ordinary non-superuser owner, the same way
`postgres` does on a new Supabase project, so a backup that only a superuser could restore fails
the night it is made, not on the day you need it. Checks:
- the row count of every table lies between the counts taken just before and just after the dump (rows are never deleted, so counts can only grow)
- the same number of tables, constraints, foreign keys, triggers, RLS policies, functions and indexes as production
- every foreign key is present and validated
- `private.integrity_report()` is clean
- there is an **active owner**, and `app_state()`, the call the app makes, works on the restored copy as that owner
- delete and truncate protection is present and enabled on all 19 protected tables, and really refuses a `truncate` and a `delete`

If any check fails, the run fails and GitHub emails the owner.

## 1. Download a backup

GitHub → **Actions** → "Nightly database backup + restore test" → pick a green run →
**Artifacts** → `eatatnest-db-<date>` (a zip containing one `.tar.gpg` file).

## 2. Decrypt it

You need the PostgreSQL **17** client tools (the same major version as the database) and GnuPG:

```bash
brew install postgresql@17 gnupg
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"     # in every terminal you use for recovery
pg_restore --version                                         # must say 17.x
```

Work in a folder **outside** the repository. The repository is public: a decrypted backup must
never end up in it.

```bash
mkdir -p ~/eatatnest-recovery && cd ~/eatatnest-recovery
unzip ~/Downloads/eatatnest-db-2026-11-08_2030.zip
gpg --decrypt eatatnest-db-2026-11-08_2030.tar.gpg > backup.tar   # asks for BACKUP_PASSPHRASE
mkdir backup && tar -C backup -xf backup.tar
cat backup/manifest.txt        # date, size, row count, checksum
```

When you no longer need the decrypted copy, delete it: `rm -rf ~/eatatnest-recovery/backup ~/eatatnest-recovery/backup.tar`.

## 3. Disaster: the Supabase project is gone or the data is corrupted

### Before any disaster: what recovery depends on

Recovery needs **your accounts**, not just the backup files. Keep these somewhere safe offline,
such as a password manager plus a sealed paper copy:

| You need | Why | Keep offline |
|---|---|---|
| Your **supabase.com** account (the dashboard login, not the app login) | to create the new project | password + **2FA recovery codes** |
| Your **GitHub** account | to download the encrypted backups | password + **2FA recovery codes** |
| `BACKUP_PASSPHRASE` | without it, no backup can be opened, by anyone | password manager **and** paper |

If both 2FA devices and the recovery codes are lost, Supabase and GitHub support can take days,
or may not be able to help at all.

### What the backup contains about people

The backup has every **staff record**: the original login id (`user_id`), email, name, role,
outlets and whether the person is active. It does **not** contain the logins themselves
(Supabase Auth, including passwords). Logins are recreated, with their **original ids**, so
everything still lines up. That means staff records, outlet access, the audit log, and every
"created by" / "voided by" field.

### Steps

1. Create a **new** Supabase project (dashboard → New project, region Mumbai `ap-south-1`, a new
   strong database password saved in your password manager). **Do not run the migration**:
   the backup contains the full schema.
2. In the new project, **first** turn off public sign-up (Authentication → Sign In / Providers →
   Email → "Allow new users to sign up" OFF), so nobody can pre-register a staff email. Set the
   minimum password length to 10 or more.
3. Restore the backup. Use the new project's **session pooler** URI (dashboard → Connect →
   Session pooler), with the database password filled in. Characters such as `@ : / ? # % &` in the
   password must be URL-encoded (`@` → `%40`, `#` → `%23`, `%` → `%25`), or use a letters-and-digits password.
   ```bash
   cd ~/eatatnest-recovery
   ~/Desktop/eatatnestinventory/scripts/restore.sh backup/db.dump 'postgresql://postgres.<newref>:<pw>@<pooler-host>:5432/postgres'
   ```
   The script:
   - refuses a database that already has the eat@nest tables, so it cannot overwrite live data;
   - refuses a dump whose checksum does not match `manifest.txt` (keep the two files together, as extracted);
   - re-applies the intended privileges afterwards, because a new Supabase project would otherwise give everyone access to the restored tables.
4. **Recreate the logins with their original ids**, in your own terminal. The secret key is
   typed at a hidden prompt and never saved:
   ```bash
   cd ~/Desktop/eatatnestinventory/scripts && npm ci && cd ..          # once: installs the locked supabase-js version
   read -r "EAN_RECOVERY_URL?New project URL: " && read -rs "EAN_RECOVERY_SECRET_KEY?New project SECRET key: " && echo
   EAN_RECOVERY_URL="$EAN_RECOVERY_URL" EAN_RECOVERY_SECRET_KEY="$EAN_RECOVERY_SECRET_KEY" node scripts/recreate-logins.mjs           # dry run: shows who
   EAN_RECOVERY_URL="$EAN_RECOVERY_URL" EAN_RECOVERY_SECRET_KEY="$EAN_RECOVERY_SECRET_KEY" node scripts/recreate-logins.mjs --apply
   unset EAN_RECOVERY_SECRET_KEY
   ```
   The secret key is under Project Settings → API Keys (*secret*, or legacy `service_role`).
   It is the most powerful key, so use it **only** in this terminal. Never put it in `config.js`, a file, a chat or an email.
   (The `read` lines are for the Mac's default shell, zsh.)

   It creates a login for every **active** staff member, with the original id and email, and the
   flag `must_change_password`. It **refuses** to run if:
   - the URL is the original production project;
   - you gave it the public key;
   - sign-up is still on;
   - the restored data has no active owner;
   - logins already exist (it is safe to re-run with `--skip-existing` after an interruption);
   - an email is taken by a login with a different id.

   It checks that Supabase really kept each original id. If not, it removes the wrong login and stops: use the fallback below.
5. **Temporary passwords.** The script prints one random password per person, **once**, on your
   screen. It saves them nowhere.
   - Tell each person their password **in person or by phone call**. Never by WhatsApp, SMS or email.
   - Clear the terminal afterwards (Cmd+K).
   - When someone signs in with a temporary password, the app shows **only** "Set your own
     password". They cannot see any data until they choose their own password (at least 10
     characters). After that, nobody else knows it.
6. Put the new project URL and **publishable** key (`sb_publishable_…`, or the legacy `anon` key;
   **never** a *secret* / `service_role` key) in `public/config.js`, deploy, and update the
   `SUPABASE_DB_URL` GitHub secret to the new project's session-pooler URI so the nightly backups
   follow the new project.
7. Run `scripts/verify-production.sql` in the SQL Editor: every row PASS. "every ACTIVE staff
   member has a matching login" proves step 4. Deactivated staff do not need logins.
8. Run the backup workflow manually and confirm it is green.

### Fallback: if the original ids cannot be used

If `recreate-logins.mjs` reports that Supabase did not keep the original id:
- Recreate each active person in the dashboard instead (Authentication → Users → Add user, Auto Confirm,
  a temporary password). In **User metadata**, add `{"must_change_password": true}` if the dashboard offers it.
  Otherwise ask them to change it in Settings → Change password.
- Re-link the restored staff records by email (sign-up must already be off):
  ```sql
  update public.staff s set user_id = u.id
    from auth.users u where lower(u.email) = s.email and u.email_confirmed_at is not null and s.active;
  ```
  Outlet access follows automatically.

**Trade-off:** the new logins have **new ids**. Everything still works, but history written before
the disaster (the `audit_log`, and the "created by" / "voided by" fields, which can never be edited)
still carries the **old** ids. "Who did this" for older entries then has to be looked up in the
restored backup's `staff` table, which keeps the old id next to each email. Before running the
update, save that mapping:
```sql
select user_id as old_id, email, name from public.staff order by name;
```

## 4. Undo a mistake (no restore needed)

All history is in the database. Examples, run in the SQL Editor:

```sql
-- what changed today, and who did it
select a.at, s.name, a.table_name, a.action, a.old_row, a.new_row
from audit_log a left join staff s on s.user_id = a.user_id
where a.at > now() - interval '1 day' order by a.at desc;

-- voided ("deleted") sales for a day
select * from sales where day = '2026-11-05' and voided_at is not null;
```

To bring a voided row back, re-enter it in the app. That keeps the audit trail honest.

## 5. Test a restore yourself (every few months)

Anyone with Docker can repeat the nightly check on a downloaded, decrypted backup (§2) without
touching production:

```bash
docker run -d --name ean-scratch -e POSTGRES_PASSWORD=scratch -p 55432:5432 postgres:17
sleep 5
RESTORE_ADMIN_URL=postgresql://postgres:scratch@localhost:55432/postgres \
  ~/Desktop/eatatnestinventory/scripts/verify-restore.sh ~/eatatnest-recovery/backup
docker rm -f ean-scratch
```

It must end with `RESTORE VERIFIED`. `verify-restore.sh` refuses to run against a Supabase host.

## Known limits

- **GitHub disables scheduled workflows in public repositories after 60 days without any
  commit.** GitHub emails a warning first. When it does, open Actions and click "Enable
  workflow", or push any small commit. The monthly check below also catches this.
- GitHub artifacts last at most 90 days, or less if the repository's retention setting is lower.
  Older history relies on your monthly off-platform copies.
- GitHub can start scheduled runs late, and under heavy load may occasionally skip one. A
  missing night is visible in the Actions list. The next night's backup is complete, because
  every backup is a full copy.
- Enabling Supabase Realtime on any eat@nest table would make the restore test fail every night.
  It fails loudly, so you would know; `scripts/verify-production.sql` checks for it.
- **Logins are not in the backup.** They are recreated (§3). Authentication recovery is proven only by
  a drill into a separate, temporary Supabase project; the local tests use a stand-in for Supabase Auth.
- **The repository is public.** Anyone signed in to GitHub can download the backup artifacts and
  read the workflow logs. The artifacts are AES-256 encrypted, so their safety rests entirely on
  `BACKUP_PASSPHRASE` being long and random (the workflow refuses anything under 20 characters;
  `openssl rand -base64 32` is better). The logs show row counts and table names, not data.
- **PostgreSQL major version.** The backup uses PostgreSQL 17 tools. If Supabase upgrades the project
  to a newer major version, the dump step fails loudly until `container: postgres:17` and
  `image: postgres:17` in `backup.yml` are raised to match.
- `SUPABASE_DB_URL` holds the database password in a GitHub secret. Anyone with admin
  rights on the GitHub repository can use it in a workflow. Keep repository admin access to the owner.

## Monthly 5-minute check

- Actions → the backup workflow shows a green run for every night.
- Download last night's artifact, decrypt it (§2) and keep the encrypted `.tar.gpg` file somewhere
  outside GitHub and Supabase (a USB drive, or Google Drive). This is your off-platform copy.
- Every few months, run §5 on that copy.
