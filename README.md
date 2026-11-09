# eat@nest — Inventory & Food Cost

Mobile-first inventory and food-cost app for the Nest Café outlets (**Areekode** and **Kondotty**).

- **Frontend:** the single file `public/index.html`, hosted on GitHub Pages. No build step.
- **Data:** one central **Supabase PostgreSQL** database. The browser stores no business
  data, so records survive clearing the browser, switching phones and using several devices at once.
- **Backups:** encrypted nightly, each one restored and verified automatically (`docs/RECOVERY.md`).

To connect a new Supabase project, follow **`docs/SETUP.md`**.

## What it does

| Tab | |
|---|---|
| **Today** | Food cost vs target, variance, top cost issues, price changes; Day / 7 / 30 days / custom range; Excel and PDF reports. |
| **Sales** | Import POS sales from Excel or CSV. Unknown POS names can be mapped once and are remembered. Re-importing a day replaces it and never double counts. |
| **Stock** | Daily opening / bought / in / out / closing per outlet, wastage with reason and person, close and reopen a day. |
| **Buy** | Purchases from a bill (typed, or read from a photo when opened from the Claude link). Updates Bought and price history. |
| **Items** | Raw materials and price history, sauces/prep items with batch recipes, menu items with versioned recipes. |
| **Settings** | Food-cost targets, account, download a copy of all data. |

## How data is kept safe

| Risk | What prevents it |
|---|---|
| A save fails silently | The app shows **Saving… → Saved ✓** only after the database confirms the write. Any failure shows **Not saved** with the reason, and the typed entries stay on screen. |
| The connection drops during a save (the database may or may not have saved it) | Every write carries a request ID. Tapping Save again is answered "Already saved" instead of saving twice. This works even after a page reload. |
| Double tap / two devices enter the same bill | The screen locks while saving. The database rejects a repeated request ID and a repeated supplier invoice number at the same outlet. |
| Two people edit the same thing | Materials, menu items, settings and each outlet-day's stock carry a version number. A save based on stale data is refused ("changed by someone else, Reload"), never silently overwritten. |
| Bad data | Every write goes through a database function that validates it inside one transaction. Constraints and foreign keys back it up. A failed save writes nothing. |
| Deleting history | Rows are never deleted. "Delete" voids a sale, purchase, stock entry, wastage entry, price or recipe, and archives a material or menu item. `DELETE`/`TRUNCATE` are blocked by triggers for everyone, including the service key and the database administrator in normal use. Someone with full database access could still deliberately disable the triggers or drop tables; that is what the backups are for. Transaction rows cannot be edited in place. |
| Who changed what | Every insert and change to every business table is written to an append-only `audit_log` (owner-readable). |
| Unauthorised access | Supabase Auth login with no public sign-up. Row Level Security: browsers can only *read*, and only their own outlet's records. Only an owner or manager can change materials, menu, recipes and settings, or set prices for dates more than 7 days back (staff can record today's bill prices). The service key has read-only table rights. No secret is in the repository. |
| Losing the database | Nightly encrypted `pg_dump`, restored into a separate database and verified every night. Supabase platform backups on top. Runbook with RPO ≤ 24 h, RTO ≤ 2 h. |

Offline use: the app does **not** queue entries offline. Without a connection it clearly says
nothing can be saved and keeps what you typed, so nothing is ever pretended to be saved.

## Layout

| Path | Purpose |
|---|---|
| `public/index.html` | the app |
| `public/config.js` | Supabase project URL + publishable key (public values) |
| `public/vendor/` | supabase-js 2.119.0, SheetJS 0.20.3, jsPDF 4.2.1 + autotable 5.0.9, served from this site (no CDN; no known vulnerabilities as of 2026-11-08) |
| `supabase/migrations/20261108000000_init.sql` | the whole database: tables, constraints, triggers, RLS, write functions |
| `scripts/backup.sh` · `restore.sh` · `verify-restore.sh` | backup, the restore procedure, restore verification |
| `scripts/harden-privileges.sql` · `fingerprint.sql` | privileges re-applied after a restore · structure fingerprint compared on restore |
| `scripts/verify-production.sql` | read-only PASS/FAIL checks to run in the Supabase SQL Editor |
| `scripts/recreate-logins.mjs` | disaster recovery only: recreates staff logins with their original ids (see `docs/RECOVERY.md` §3) |
| `.github/workflows/backup.yml` | nightly encrypted backup + restore test |
| `.github/workflows/pages.yml` | publishes `public/` to GitHub Pages on push to `main` |
| `tests/` | database and browser test suites (below) |
| `docs/SETUP.md` · `docs/RECOVERY.md` · `docs/GO-LIVE.md` | setup steps · backup and recovery runbook · production-readiness checklist |

## Tests

They run against a local PostgreSQL 17 + PostgREST (the same REST layer Supabase uses) with a
small local stand-in for Supabase Auth. Needs Homebrew and Google Chrome:

```bash
brew install postgresql@17 postgrest
cd tests && npm install && cd ..
tests/local/env.sh up            # local database + REST API
node tests/db.test.mjs           # 79 checks: permissions, validation, idempotency, concurrency, no-delete
node tests/e2e.test.mjs          # 71 checks
node tests/dr-logins.test.mjs    # 27 checks: disaster-recovery login recreation + forced password change: real Chrome, two devices, offline, lost replies, DB down, conflicts, all tabs
tests/local/env.sh down
```

Against the real project (read-only, writes nothing): `cd tests && node prod-smoke.mjs` (see `docs/SETUP.md` step 5).

The backup → encrypt → restore → verify cycle can be run locally against the same stack
(see `docs/RECOVERY.md` §5).
