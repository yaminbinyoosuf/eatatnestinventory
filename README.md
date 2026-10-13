# eat@nest — Inventory & Food Cost

A single-file, offline, mobile-first inventory and food-cost tracker for the Nest Café outlets
(**Areekode** and **Kondotty**).

The whole app is `public/index.html` — no build step, no server, no framework. Open it directly,
or deploy the `public/` folder as a static site. The logo is embedded in the file as a base64 data
URI, so the app stays genuinely single-file with no image request.

## What it does

Six tabs, bottom navigation, mobile viewport first.

| Tab | What's in it |
|---|---|
| **Today** | Data checks, "what to look at", and the top cost issues ranked for the day. |
| **Sales** | Upload POS sales from **Excel (.xlsx) or CSV**, review the imported rows for the day, then confirm the import. POS item names are remembered as aliases, so the same name matches the same menu item on later imports. |
| **Stock** | Daily closing stock per outlet (Areekode / Kondotty) and wastage entries with quantity and responsible person. A day can be closed (🔒) once it is finalised. |
| **Buy** | Purchases from a bill, per outlet and date, with a running total. Lines can be typed by hand, or read from a photo/screenshot of the bill when the app is opened from the Claude link. Saving a purchase adds to that material's price history, which feeds the *Now vs Before* column and the price-change analysis on **Today**. |
| **Items** | Raw materials (price per unit, minimum stock level) and menu items with recipes — ingredient quantities in `g / ml / pc`, costing, and **cost now vs 30 days earlier**. Existing **raw materials** can be renamed, re-priced (or have their unit changed) or **deleted**. Deleting one that is still in use cascades: the app warns you first, then removes it from every menu and prep recipe, stock row, wastage record and purchase line at the same moment, so nothing is ever left pointing at a material that is gone. (Earlier builds refused the delete instead; both policies keep the same invariant — `verify-edit.mjs` asserts the cascade leaves nothing dangling.) Recipes are versioned: *Save as new version* keeps the price history for the comparison. A separate **Sauces & prep items** section lists the raw materials flagged as prep, with their own recipe and cost. |
| **Settings** | Outlet setup, and demo-data controls (*Clear demo data*, *Reset to demo*). |

Money is shown in ₹ (Indian formatting). Units are `kg → g`, `l → ml`, and `pc`.

## Where the data lives

On the device, in `localStorage` under the key **`nest2`**. Nothing is uploaded anywhere: no
account, no server round-trip, works offline.

That also means **an audit lives in the browser that created it** — opening the app from
`file://`, from one deployed URL, and from another URL are **three separate stores**. The app
ships with seeded demo data so it is explorable before you put real numbers in; use **Settings →
Clear demo data** to start clean.

> Because the store is browser-local and the app has **no export or backup**, clearing site data,
> switching device, or switching browser loses every entry. Keep each outlet on one URL/device and
> treat the browser store as the only copy of the numbers.

## Deploy

The repo is static-only, so both hosts below work with **no build command**.

**GitHub Pages** — already the live link for this repo:

```
https://yaminbinyoosuf.github.io/eatatnestinventory/
```

Published by the Actions workflow in `.github/workflows/pages.yml`, which uploads `public/`
verbatim as the Pages artifact on every push to `main` (branch-based Pages can only serve the repo
root or `/docs`, which is why the app is not published from the `public/` folder directly).

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
| `public/.nojekyll` | keeps Jekyll away from the folder if it is ever served from a branch root |
| `.github/workflows/pages.yml` | uploads `public/` to GitHub Pages on every push to `main` |
| `wrangler.jsonc` | optional Cloudflare Workers static-assets config (`assets.directory = ./public`) |
| `verify-browser.mjs` | real-browser verification over CDP (21 assertions) — console/exception capture, every tab, a real mutation, reload persistence, a blocked-CDN outage, screenshots |
| `verify-edit.mjs` | edit/delete/robustness verification (37 assertions) — material and recipe editing, the delete-vs-usage rules, the two data-lockout scenarios, range chips, real xlsx/PDF exports |
| `verified-*.png` | screenshots written by the verifiers (gitignored) |

## Verify it works

Both scripts need Google Chrome installed. They serve `public/` over a real `http://` URL, drive
the app with the DevTools Protocol, and exit non-zero if any assertion fails:

```bash
node verify-browser.mjs   # 21 assertions
node verify-edit.mjs      # 37 assertions
```

They write `verified-*.png` screenshots next to themselves and clean up their temporary Chrome
profiles. Run both before publishing a regenerated build.

## Notes on the import and the exports (SheetJS + jsPDF)

Three libraries load from cdnjs at runtime: SheetJS (`xlsx.full.min.js`) to read a POS file or a
bill, and jsPDF + `jspdf-autotable` to write a PDF. All of them need a network connection the first
time. If one is missing the app still opens and the action needing it says so and stops — `Import
problem: ReferenceError: XLSX is not defined` on import, or *"Excel tool did not load. Check your
internet and reload."* / *"PDF tool did not load. …"* on export. Everything already stored in
`localStorage` keeps working offline.

**Reports and exports** (Today tab): the range chips switch between **Day**, **7 days**, **30 days**
and a **Custom** range (up to 3 months), and the two export buttons write that report —
`Nest-FoodCost_<from>_to_<to>_<outlet>.xlsx` and `.pdf`. Inside the Claude environment the file is
handed to the downloads integration; in a plain browser it is a normal download.

## Robustness of the stored state

This matters more than it sounds on GitHub Pages: **every `*.github.io` project page shares one
origin**, so another app that writes the same `nest2` key can collide with this one.

> ⚠ **Open finding — there is no boot-time validation.** `verify-browser.mjs` (`h4`) stores a
> *valid but partial* state (for example `{}`, or an object without `sales`/`rm`/`menu`) and reports
> that the app then **hard-crashes on every load**: blank `#app`, no `#nav`, and since Settings is
> the only in-app reset there is no way back except clearing site data. An earlier version of this
> README claimed the state was validated and fell back to demo data; that code is not in the app,
> here or in the previous build. A guard before the first `draw()` would close it, e.g.
> `if (!S || !['sales','rm','menu','inv','waste'].every(k => Array.isArray(S[k]))) S = demo();`
> (unparseable JSON is already handled by the `try/catch` around `JSON.parse`).

### Dangling ingredient references (fixed)

**Settings → Clear demo data** used to delete the demo raw materials while keeping any non-demo
menu item whose recipe referenced them. That left a dangling ingredient id, `price()` dereferenced
the missing material, and the resulting `TypeError` aborted `draw()` — so `#nav` never rendered.
After a reload the app was a **blank page with no navigation**, and because Settings is the only
in-app reset, the user's records were unreachable with no way back. The same class of failure could
blank the default Today tab outright.

Two changes close it:

- **Clear demo data now prunes references** to the records it removes — ingredient rows in surviving
  menu and prep recipes, plus stock and wastage rows pointing at deleted materials — so it cannot
  leave a dangling id behind.
- **A missing material is no longer fatal.** `rmOf()` returns a placeholder (`"(missing)"`, unit
  `pc`, no prices, no recipe) instead of `undefined`, so any dangling reference renders as a missing
  ingredient rather than throwing. This is defence in depth: it also covers hand-edited storage and
  any future import path.

Both are covered by `verify-edit.mjs` (32 assertions), which reproduces the original lockout —
including the blank-screen-after-reload case — and asserts it no longer occurs.

These guards have now been dropped by **two** regenerated builds (the Buy-tab build and the
reports/export build) and were restored each time:

- `rmOf()` again returns the `{name:'(missing)'}` placeholder for an unresolved id, so a dangling
  ingredient renders instead of throwing.
- **Settings → Clear demo data** again prunes references to the records it deletes — ingredient rows
  in surviving menu and prep recipes, plus stock, wastage and purchase rows pointing at removed
  materials. Without the prune the dangling ids persisted in `localStorage` and survived reload.

If the app is regenerated upstream again, re-apply those two edits before publishing —
`verify-edit.mjs` fails loudly (`X2`/`X3`/`X4`, `Y3`/`Y4`) without them.

`verify-edit.mjs` (37 assertions) also follows deliberate changes in the newer builds: the sixth
(Buy) tab, the cascade delete policy described above, and — for the reports build — the range chips
and both exports (`Z1`–`Z5`, asserting a real `.xlsx` zip and a real `%PDF` file come out).
`verify-browser.mjs` (21 assertions) adds `h4`, which blocks the CDN and asserts both exports report
the missing library instead of writing a broken file.
