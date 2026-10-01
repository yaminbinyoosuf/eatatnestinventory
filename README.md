# Eat at Nest — Inventory & Food Cost

A single-file, offline, mobile-first inventory and food-cost tracker for the Nest Café outlets
(**Areekode** and **Kondotty**).

The whole app is `public/index.html` — no build step, no server, no framework. Open it directly,
or deploy the `public/` folder as a static site.

## What it does

Five tabs, bottom navigation, mobile viewport first.

| Tab | What's in it |
|---|---|
| **Today** | Data checks, "what to look at", and the top cost issues ranked for the day. |
| **Sales** | Upload POS sales from **Excel (.xlsx) or CSV**, review the imported rows for the day, then confirm the import. |
| **Stock** | Daily closing stock per outlet (Areekode / Kondotty) and wastage entries with quantity and responsible person. |
| **Items** | Raw materials (price per unit, minimum stock level) and menu items with recipes — ingredient quantities in `g / ml / pc`, costing, and **cost now vs 30 days earlier**. Recipes are versioned: *Save as new version* keeps the price history for the comparison. |
| **Settings** | Outlet setup, and demo-data controls (*Clear demo data*, *Reset to demo*). |

Money is shown in ₹ (Indian formatting). Units are `kg → g`, `l → ml`, and `pc`.

## Where the data lives

On the device, in `localStorage` under the key **`nest2`**. Nothing is uploaded anywhere: no
account, no server round-trip, works offline.

That also means **an audit lives in the browser that created it** — opening the app from
`file://`, from one deployed URL, and from another URL are **three separate stores**. The app
ships with seeded demo data so it is explorable before you put real numbers in; use **Settings →
Clear demo data** to start clean.

> Because the store is browser-local, clearing site data or switching devices/browsers loses the
> entries. Keep the app on one URL per outlet device, and export rather than relying on a browser
> reset.

## Deploy

The repo is static-only, so both hosts below work with **no build command**.

**GitHub Pages** — already the live link for this repo:

```
https://yaminbinyoosuf.github.io/eatatnestinventory/
```

Served straight from the `main` branch root, with `.nojekyll` in `public/` so the folder is
served verbatim.

**Cloudflare Workers** (optional alternative) — the repo also ships a `wrangler.jsonc` pointing at
`./public`, so no build configuration is needed on the Cloudflare side:

| Setting | Value |
|---|---|
| Build command | *leave empty* |
| Deploy command | `npx wrangler deploy` (the default) |

Locally you can preview exactly what would be uploaded with:

```bash
npx wrangler deploy --dry-run
```

## Layout

| File | Purpose |
|---|---|
| `public/index.html` | the app — the only file that gets deployed |
| `public/.nojekyll` | keeps GitHub Pages from running Jekyll over the folder |
| `wrangler.jsonc` | optional Cloudflare Workers static-assets config (`assets.directory = ./public`) |
| `verify-browser.mjs` | real-browser verification over CDP — console/exception capture, every tab, a real mutation, reload persistence, screenshots |
| `verified-*.png` | screenshots written by the verifier (gitignored) |

## Verify it works

Needs Google Chrome installed. The script serves `public/` over a real `http://` URL, drives the
app with the DevTools Protocol, and exits non-zero if any assertion fails:

```bash
node verify-browser.mjs
```

It writes `verified-*.png` screenshots next to itself and cleans up its temporary Chrome profile.

## Note on the Excel export / POS import

SheetJS (`xlsx.full.min.js`) is loaded from cdnjs at runtime. Read-only browsing and everything
already stored in `localStorage` work offline, but **Excel/CSV import and Excel export need a
network connection** the first time so that library can load.
