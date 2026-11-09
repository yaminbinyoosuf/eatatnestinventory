# Go-live checklist (status 2026-11-08)

"Verified" means it was run and observed; anything not run against the real Supabase or
GitHub is marked as such.

## Done

- [x] Supabase project `mwhuehfwfmakecylmikt` created, migration run, first owner (Yamin Bin Yoosuf) created. *(Reported by you.)*
- [x] `public/config.js` has the production URL. It still needs the **publishable key** (step 1 below). Until then the app shows "not connected" and refuses to save.
- [x] All saves go through the database functions (24 call sites cross-checked). There is no browser storage of business data, and no legacy local saving.
- [x] Every browser library is served from this site (no CDN), with 0 known vulnerabilities:
  - SheetJS 0.20.3 (was 0.18.5, known CVEs)
  - jsPDF 4.2.1 and autotable 5.0.9 (was 2.5.1 and 3.8.2, known CVEs)
  - supabase-js 2.119.0
- [x] POS import no longer depends on library guesswork. SheetJS 0.20.3 had silently turned the CSV date `05-11-2026` into 11 May; fixed and tested. Numbers like `1,250` and `₹4,800` are read correctly, and anything unreadable is flagged.
- [x] Local tests: 79 database checks, 66 browser checks. The browser checks run in real Chrome and cover:
  - login, outlets, materials, purchases, stock, sales (CSV and .xlsx), wastage, prices, recipes
  - two devices at once, conflicts
  - offline, lost replies, database down, stale screen
  - duplicates, history kept, persistence after reload and in a fresh browser
  - Excel and PDF reports
- [x] Mobile layout: no horizontal overflow on any tab at 360 / 375 / 390 px; every control can be tapped above the bottom bar; no JavaScript errors.
- [x] Backup cycle (local): dump, then restore into a separate server and verify, then AES-256 encrypt and decrypt, then restore into an isolated database. The content was identical. Corrupted or incomplete backups are rejected.
- [x] `tests/prod-smoke.mjs` (read-only production check) was proven correct against the local stack: 15/15 passed, 0 rows written.

## 1. Your actions in the dashboard (about 15 minutes)

1. **Supabase → Project Settings → API Keys** → copy the **publishable** key (`sb_publishable_…`) into `public/config.js` (replace `YOUR-PUBLISHABLE-OR-ANON-KEY`). Never use a *secret* / `service_role` key. The publishable key is designed to be public, so you can also paste it in chat and I'll put it in.
2. **Authentication → Sign In / Providers → Email**: confirm "Allow new users to sign up" is **OFF**. Set the minimum password length to 10 or more.
3. **Settings → Data API**: enabled; exposed schemas are `public` (and `graphql_public`), **not** `private`.
4. **SQL Editor**: run the **corrected** `scripts/verify-production.sql` (SHA-256 `323c7471…`, **24 rows**). The 18-row result you reported matches the earlier version. Every row must be PASS, except "private schema not exposed" which may say CHECK (confirmed by item 3).
5. In your own terminal: `cd tests && node prod-smoke.mjs`, then the owner variant with `EAN_EMAIL` / `EAN_PASSWORD` (see `docs/SETUP.md` step 5). All lines must PASS.

## 2. Production acceptance test (about 15 minutes, on a laptop + phone)

Records can never be deleted, so use clearly labelled test data and void or archive it at the end.
It stays in the audit history marked as voided, and is hidden from lists and reports.

Run locally with `npx serve public` (or after deploy). Sign in as the owner on **both** laptop and phone:

1. Items → add raw material `TEST material (ignore)`, kg, ₹100. Expect "Added … ✓".
2. Items → set a new price ₹110 for it. Expect a ✓, and "Before ₹100" shown.
3. Buy (Areekode) → Add by hand → TEST material, qty 1, rate 110, invoice `TEST-1` → save. Expect a ✓. Then **reload the page**: the purchase is still listed.
4. Phone: same outlet and date → Buy shows the purchase. Stock shows Bought = 1.
5. Stock (laptop and phone on the same day): phone saves closing 1; then the laptop saves a different closing. The laptop must say **"changed by someone else"** and keep the typed numbers.
6. Phone in airplane mode → add wastage → must say **Not saved** and keep the entry. Airplane mode off → tap again → ✓ once (check that only one entry is listed).
7. Double-tap Save on a wastage entry → only one entry appears.
8. Sign out, sign in again: everything is still there.
9. SQL Editor: `select at, table_name, action from audit_log order by at desc limit 20;` shows each step.
10. Clean up in the app: delete the wastage entries and the purchase (Buy ✕); Stock → Clear this day; Items → Edit TEST material → Delete.

Any failure: stop and send me the exact message shown.

## 3. GitHub (backups), required before relying on the app

GitHub only runs workflows that exist on `main`, so the backup files must reach `main` first.
That needs your approval. They do not touch `public/`, so the live site is unchanged.

1. GitHub → repository → **Settings → Secrets and variables → Actions** → New repository secret:
   - `SUPABASE_DB_URL`: Supabase → **Connect → Session pooler** URI, with the database password filled in
   - `BACKUP_PASSPHRASE`: at least 20 random characters (e.g. `openssl rand -base64 32`). Also keep it in your password manager **and** on paper.
2. With your approval I put exactly these files on `main`, and nothing in `public/`:
   - `.github/workflows/backup.yml`
   - `scripts/backup.sh`, `restore.sh`, `verify-restore.sh`, `fingerprint.sql`, `harden-privileges.sql`, `verify-production.sql`
   - `tests/local/bootstrap.sql`
   - `docs/RECOVERY.md`

   The push re-runs `pages.yml`, which republishes the unchanged current site.
3. **Actions → "Nightly database backup + restore test" → Run workflow**. It must be green, and the log must show `RESTORE VERIFIED`.
4. Download the artifact, then `gpg --decrypt` it with the passphrase on your computer. This proves the backup can be opened.
5. **Settings → Actions → General** → artifact retention 90 days. Enable failed-workflow email notifications. Turn on 2FA for GitHub and Supabase.

## 4. Deploy (only with your approval)

Commit `public/config.js` (with the publishable key), then merge `supabase-persistence` into `main`.
`pages.yml` publishes to <https://yaminbinyoosuf.github.io/eatatnestinventory/>.
The next morning, check that the 02:00 IST backup run is green.

## Remaining risks (accepted for launch, to do soon)

- The app re-downloads all data after each save: about 1.6 MB compressed per year of data. Implement a date-limited load within about 3 months.
- Up to 24 h of data loss if Supabase loses the database (nightly backup). Supabase Pro daily backups and PITR reduce this.
- A save that lost its reply, retried from a *different* device or after clearing the browser, can be duplicated. Bills with an invoice number are protected.
- Policy decisions to confirm: closed days do not freeze sales or wastage; staff can create materials from a bill; POS name mappings are shared by both outlets.
- Someone with full database access (Supabase dashboard, or the DB password in the GitHub secret) could disable protections. Mitigated by 2FA, few admins and backups.
