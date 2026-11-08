# Backup & recovery runbook

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
- `app_state()`, the call the app makes, works on the restored copy as the owner
- deletes are still blocked

If any check fails, the run fails and GitHub emails the owner.

## 1. Download a backup

GitHub → **Actions** → "Nightly database backup + restore test" → pick a green run →
**Artifacts** → `eatatnest-db-<date>` (a zip containing one `.tar.gpg` file).

## 2. Decrypt it

You need PostgreSQL 17 client tools and GnuPG (`brew install libpq gnupg` on a Mac).

```bash
unzip eatatnest-db-2026-11-08_2030.zip
gpg --decrypt eatatnest-db-2026-11-08_2030.tar.gpg > backup.tar   # asks for BACKUP_PASSPHRASE
mkdir backup && tar -C backup -xf backup.tar
cat backup/manifest.txt        # date, size, row count, checksum
```

## 3. Disaster: the Supabase project is gone or the data is corrupted

1. Create a **new** Supabase project (`docs/SETUP.md` step 1). **Do not run the migration**:
   the backup contains the full schema.
2. Copy its session-pooler connection URI (SETUP step 6.2).
3. Restore:
   ```bash
   scripts/restore.sh backup/db.dump 'postgresql://postgres.<newref>:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'
   ```
   The script refuses to run against a database that already has the eat@nest tables, so it
   cannot overwrite live data by mistake. It also refuses a dump whose checksum does not match
   `manifest.txt` (keep the two files together, as extracted). After restoring it re-applies
   the intended privileges, because a new Supabase project would otherwise grant everyone
   access to the restored tables. When it finishes, run `scripts/verify-production.sql` in the SQL
   Editor. Until step 4 is done, "every staff row matches a login" fails, because logins are
   not part of the backup.
4. Logins live in Supabase Auth, not in the backup. **First** turn off sign-ups (SETUP step
   3.1), so nobody can pre-register a staff email. Then recreate each person under
   Authentication → Users (same email, Auto Confirm), and re-link the restored staff records
   to the new logins:
   ```sql
   update public.staff s set user_id = u.id
     from auth.users u where lower(u.email) = s.email and u.email_confirmed_at is not null;
   ```
   Outlet access (`staff_outlets`) follows automatically.
5. Put the new project URL and key in `public/config.js` (SETUP step 4), deploy, and update the
   `SUPABASE_DB_URL` secret so the nightly backups follow the new project.
6. Run the backup workflow manually and confirm it is green.

If Supabase still exists and only needs rolling back, Supabase's own **Database → Backups**
(Pro) or PITR restore is faster than the above. Note that a platform restore replaces the
whole project database. Take a fresh manual run of our backup first if the current state
might still be useful.

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

Anyone with Docker or a local PostgreSQL can repeat the nightly check on a downloaded
backup without touching production:

```bash
# any empty scratch PostgreSQL 17 server
RESTORE_ADMIN_URL=postgresql://postgres@localhost:5432/postgres scripts/verify-restore.sh backup
```

`verify-restore.sh` refuses to run against a Supabase host.

## Known limits

- **GitHub disables scheduled workflows in public repositories after 60 days without any
  commit.** GitHub emails a warning first. When it does, open Actions and click "Enable
  workflow", or push any small commit. The monthly check (SETUP step 9) also catches this.
- GitHub artifacts last at most 90 days, or less if the repository's retention setting is lower.
  Older history relies on your monthly off-platform copies.
- GitHub can start scheduled runs late, and under heavy load may occasionally skip one. A
  missing night is visible in the Actions list. The next night's backup is complete, because
  every backup is a full copy.
- Enabling Supabase Realtime on any eat@nest table would make the restore test fail every night.
  It fails loudly, so you would know; `scripts/verify-production.sql` checks for it.
- `SUPABASE_DB_URL` holds the database password in a GitHub secret. Anyone with admin
  rights on the GitHub repository can use it in a workflow. Keep repository admin access to the owner.
