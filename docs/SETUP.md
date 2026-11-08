# Setup — connecting the app to Supabase

These are the steps that need your Supabase and GitHub accounts. Do them in order.
Nothing goes live until step 8. Allow about 45 minutes.

> **Never** put the database password, the `service_role` key or a Supabase "secret" key
> in any file in this repository. They go only into GitHub **Secrets** (step 6) and your
> password manager.

## 1. Create the Supabase project

1. <https://supabase.com/dashboard> → **New project**.
2. Name: `eatatnest`. Region: **Mumbai (ap-south-1)**, the closest to Areekode and Kondotty.
3. Generate a strong **database password** and save it in your password manager now.
4. **Plan:** the Pro plan is strongly recommended for business records. Free projects can be
   paused after a period of inactivity, and the platform's daily backups are a paid-plan
   feature. Check the current details on Supabase's pricing page before choosing.

## 2. Create the database schema

Dashboard → **SQL Editor** → New query → paste the whole of
`supabase/migrations/20261108000000_init.sql` → **Run**. It should finish with "Success. No rows returned".

(Or with the CLI: `supabase link --project-ref <ref>` then `supabase db push`.)

Check it: paste `scripts/verify-production.sql` into a new SQL Editor query and run it.
Every row must say **PASS**, except the three staff-related checks, which pass once step 3 is done.
Do **not** enable Realtime on any of these tables: it would break the nightly restore test. The database starts empty apart from the two outlets and the default
food-cost targets (42 %, with 3 / 5 / 10 % warning levels).

## 3. Lock down sign-in, then create staff logins

1. **Authentication → Sign In / Providers → Email**: keep Email enabled, and turn **OFF
   "Allow new users to sign up"**. Only the owner creates accounts. (Even if someone did
   sign up, they would see and change nothing, because they are not in the `staff` table.
   This is a second layer of protection.)
2. **Authentication → Users → Add user → Create new user** for each person: email + password,
   tick **Auto Confirm User**.
3. **SQL Editor**: give each login a name, a role and outlets. The owner (Yamin Bin Yoosuf) is
   already done. For each further person, edit the email and name, then run. Each statement
   must show **exactly one row** in the result. Zero rows means the email didn't match, and
   nothing was added.

```sql
-- manager: can change materials, prices, menu, recipes, settings and reopen closed days, at their outlet(s)
insert into public.staff (user_id, email, name, role)
select id, lower(email), 'Areekode manager', 'manager' from auth.users
where lower(email) = lower('areekode@example.com') and email_confirmed_at is not null
returning user_id, email, role;
insert into public.staff_outlets (user_id, outlet)
select id, 'Areekode' from auth.users where lower(email) = lower('areekode@example.com')
returning user_id, outlet;

-- staff: sales import, stock, wastage and purchases (today's bill prices only) at their outlet only
insert into public.staff (user_id, email, name, role)
select id, lower(email), 'Kondotty staff', 'staff' from auth.users
where lower(email) = lower('kondotty@example.com') and email_confirmed_at is not null
returning user_id, email, role;
insert into public.staff_outlets (user_id, outlet)
select id, 'Kondotty' from auth.users where lower(email) = lower('kondotty@example.com')
returning user_id, outlet;
```

Staff rows can never be deleted. A mistaken row can only be deactivated (below), so check
the email before running. Then re-run `scripts/verify-production.sql`.

To remove someone later: `update public.staff set active = false where email = '…';`
(staff rows are never deleted, so the audit history keeps their name). Also delete or ban
their login under Authentication → Users.

## 4. Point the app at the project

Dashboard → **Project Settings → API Keys**. Copy the **publishable** key (`sb_publishable_…`;
the legacy `anon` key also works). **Never** use a key labelled *secret* or `service_role`.
The production URL is already in `public/config.js`; replace only the key placeholder:

```js
window.EAN_CONFIG = {
  url: 'https://mwhuehfwfmakecylmikt.supabase.co',
  key: 'sb_publishable_...'
};
```

These two values are meant to be public: the key can only do what the database's security
rules allow.

## 5. Try it before going live

First, the automatic read-only check against production. It writes nothing, and it refuses to run if
`config.js` contains a secret key:

```bash
cd tests && npm install          # first time only
node prod-smoke.mjs              # anonymous checks: nothing must be readable or writable
EAN_EMAIL='your-login-email' EAN_PASSWORD='your-password' node prod-smoke.mjs   # + owner checks
```

Type the second command only in your own terminal. Every line must say PASS.

Then try the app itself:

Serve the folder locally and sign in as each person:

```bash
npx serve public     # then open the URL it prints
```

Check that the owner sees both outlets, each manager or staff member sees only their own outlet, and
that adding a purchase shows "Saving…" and then "Saved ✓". Then run `scripts/verify-production.sql`
again: all rows must say PASS. Full checklist: `docs/GO-LIVE.md`.

## 6. Turn on the nightly backups

1. Generate a backup passphrase (at least 20 characters, e.g. `openssl rand -base64 32`).
   Store it in your password manager **and** on paper somewhere safe. **Without it the
   backups cannot be opened, by anyone.**
2. Dashboard → **Connect** → **Session pooler** → copy the URI. It looks like
   `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`.
   Put the database password in it. Use the *session pooler*, because GitHub's machines cannot reach the
   IPv6-only direct connection.
   If the password contains characters like `@ : / ? # % &`, they must be URL-encoded in the
   URI (`@` → `%40`, `#` → `%23`, `%` → `%25`, `/` → `%2F`, `:` → `%3A`), or the job cannot connect.
   Simplest fix: reset the database password to a long letters-and-digits-only value under
   Settings → Database, which doesn't break the app (the app never uses the database password).
3. GitHub → repository → **Settings → Secrets and variables → Actions → New repository secret**:
   - `SUPABASE_DB_URL` = the URI from step 2
   - `BACKUP_PASSPHRASE` = the passphrase from step 1
4. GitHub only runs (or lets you trigger) a workflow that exists on the **default branch
   (`main`)**. To prove backups work *before* the app goes live, first merge only the backup
   files into `main`: `.github/workflows/backup.yml`, `scripts/` and `tests/local/bootstrap.sql`
   (see `docs/GO-LIVE.md`). They do not touch `public/`, so the live site does not change. Then
   **Actions → "Nightly database backup + restore test" → Run workflow.** It must finish
   green. Open the run: the "Restore into a separate empty database and verify it" step
   prints `RESTORE VERIFIED: … rows across 20 tables`. An encrypted artifact
   `eatatnest-db-<date>.tar.gpg` appears at the bottom of the run page.
5. Make sure GitHub emails you about failed runs. For scheduled workflows, GitHub notifies the
   person who **last edited the `cron:` line** in `backup.yml`, so the owner should make that
   commit, or edit the line once. Also: GitHub → your avatar → **Settings → Notifications →
   Actions** → turn on failed-workflow emails. Check **Settings → Actions → General → Artifact
   and log retention** is 90 days. The workflow cannot keep artifacts longer than that setting.

## 7. Turn on Supabase's own backups (second, independent layer)

On the Pro plan, **Database → Backups** shows the daily backups Supabase keeps. Optionally
enable **Point-in-Time Recovery** (paid add-on) to shrink possible data loss from a day to
minutes. See `docs/RECOVERY.md` for how both layers are used.

## 8. Go live

Commit `public/config.js` and merge the branch into `main`. The existing Pages workflow
publishes `public/` to <https://yaminbinyoosuf.github.io/eatatnestinventory/>.
Each staff member opens that link and signs in. Nothing is kept on the phone except the login.

## 9. Monthly 5-minute check (put it in a calendar)

- Actions → the backup workflow shows green runs every night.
- Download last night's artifact, decrypt it (see `docs/RECOVERY.md` §2) and keep the file
  somewhere outside GitHub and Supabase (a USB drive, or Google Drive). This is your
  off-platform copy.
- Settings in the app → **Download a copy of all data (JSON)** is also a quick human-readable export.
