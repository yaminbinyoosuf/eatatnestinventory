// End-to-end: real Chrome → the real app (public/index.html) → supabase-js → PostgREST → PostgreSQL.
// Separate browser contexts act as separate devices. Every UI claim is checked against the database.
//   tests/local/env.sh up && node tests/e2e.test.mjs
import puppeteer from 'puppeteer-core';
import pg from 'pg';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID as uuid } from 'node:crypto';
import { startGateway } from './local/gateway.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
execSync('tests/local/env.sh reset', { cwd: ROOT, stdio: 'ignore' });
const PGENV = { ...process.env, PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH}` };
const cfg = { host: 'localhost', port: 54329, user: 'postgres', database: 'eatatnest' };
let db = new pg.Client(cfg); await db.connect();
const Q = async (sql, p = []) => (await db.query(sql, p)).rows;
const N = async (sql, p = []) => +(await Q(sql, p))[0].count;

const users = [
  { id: uuid(), email: 'owner@eatatnest.test', password: 'owner-pass-1', name: 'Owner', role: 'owner', outlets: [] },
  { id: uuid(), email: 'areekode@eatatnest.test', password: 'mgr-pass-1', name: 'Areekode Manager', role: 'manager', outlets: ['Areekode'] },
  { id: uuid(), email: 'kondotty@eatatnest.test', password: 'staff-pass-1', name: 'Kondotty Staff', role: 'staff', outlets: ['Kondotty'] },
];
for (const u of users) {
  await db.query(`insert into auth.users(id,email) values ($1,$2)`, [u.id, u.email]);
  await db.query(`insert into staff(user_id,email,name,role) values ($1,$2,$3,$4)`, [u.id, u.email, u.name, u.role]);
  for (const o of u.outlets) await db.query(`insert into staff_outlets values ($1,$2)`, [u.id, o]);
}
const gw = await startGateway({ publicDir: path.join(ROOT, 'public'), users });
const APP = `http://localhost:${gw.port}/eatatnestinventory/`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launch = () => puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const consoleErrors = [];
let CUR = null;
process.on('uncaughtException', async (e) => { console.log('CRASH', e.message, '\nerrors:', consoleErrors, '\nscreen:', CUR ? (await CUR.evaluate(() => document.body.innerText).catch(() => '?')).slice(0, 600) : ''); process.exit(2); });

async function device(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.dialogs = [];
  page.on('dialog', async (d) => { page.dialogs.push(d.message()); await d.accept(); });
  page.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) consoleErrors.push(`${label}: ${m.text()}`); });
  await page.goto(APP, { waitUntil: 'networkidle0' });
  CUR = page;
  return page;
}
async function login(page, u) {
  await page.waitForSelector('#le');
  await page.type('#le', u.email); await page.type('#lp', u.password);
  await page.click('#lb');
  await page.waitForSelector('#nav button', { timeout: 15000 });
}
const tab = (page, name) => page.evaluate((n) => [...document.querySelectorAll('#nav button')].find((b) => b.textContent.includes(n)).click(), name);
const set = (page, sel, v) => page.$eval(sel, (e, v) => { e.value = v; }, String(v));
const goDate = (page, d) => page.evaluate((d) => { V.date = d; draw(); }, d);
// click a button and wait for the save cycle to finish; returns the status banner
async function save(page, sel) {
  await page.$eval(sel, (b) => b.click()); // DOM click: the fixed bottom nav can cover buttons at screen coordinates
  await page.waitForFunction(() => { const s = document.getElementById('st'); return !BUSY && s && s.className && s.className !== 'saving'; }, { timeout: 40000 });
  return page.evaluate(() => ({ kind: document.getElementById('st').className, text: document.getElementById('st').textContent }));
}
const S = (page, expr) => page.evaluate(new Function(`return (${expr})`));

let browser = await launch();
const A = await device(browser, 'A');

// ---------- login & empty start
await A.screenshot({ path: path.join(ROOT, 'verified-login.png') });
ok('signed-out app shows sign-in, not data', await A.$('#le') !== null && await A.$('#nav button') === null);
await A.type('#le', users[1].email); await A.type('#lp', 'wrong'); await A.click('#lb');
await A.waitForFunction(() => /Sign in failed/.test(document.body.innerText));
ok('wrong password refused', true);
await A.goto(APP, { waitUntil: 'networkidle0' });
await login(A, users[1]);
ok('starts with a clean database (no demo data)', await S(A, 'S.rm.length+S.menu.length+S.sales.length') === 0);
ok('manager sees only Areekode', JSON.stringify(await S(A, 'OUT')) === '["Areekode"]');

// ---------- set up master data through the UI
await tab(A, 'Items');
for (const [n, u, p, m] of [['Chicken', 'kg', 260, 6], ['Oil', 'l', 140, 5], ['Buns', 'pc', 6, 60]]) {
  await set(A, '#an', n); await A.select('#au', u); await set(A, '#ap', p); await set(A, '#am', m);
  const st = await save(A, 'button[onclick="addRM()"]');
  if (st.kind !== 'saved') ok(`add ${n}`, false, st.text);
}
ok('materials saved to database', await N(`select count(*) from materials`) === 3);
await set(A, '#mn', 'Zinger Burger'); await set(A, '#mp', 120);
let st = await save(A, 'button[onclick="addM()"]');
ok('menu item saved; "Saved" shown only after DB confirmed', st.kind === 'saved' && await N(`select count(*) from menu_items`) === 1, st.text);
const burger = await S(A, 'S.menu[0].id'), ids = Object.fromEntries(await S(A, 'S.rm.map(r=>[r.name,r.id])'));
await A.$eval(`button[onclick="editR('${burger}')"]`, (b) => b.click());
for (const [i, n, q] of [[0, 'Chicken', 90], [1, 'Buns', 1], [2, 'Oil', 20]]) {
  await A.evaluate(() => [...document.querySelectorAll('#ed button')].find((b) => b.textContent.includes('+ Ingredient')).click());
  await A.select(`#er${i}`, ids[n]); await set(A, `#eq${i}`, q);
}
await set(A, '#ef', '2026-11-01');
st = await save(A, 'button[onclick="saveR()"]');
ok('recipe saved', st.kind === 'saved' && await N(`select count(*) from recipe_items`) === 3, st.text);

// ---------- 1. save a purchase, reload
await goDate(A, '2026-11-05'); await tab(A, 'Buy');
await A.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add by hand').click());
await A.select('select[onchange^="syncB();B.rows[0].rm"]', ids.Chicken);
await set(A, '#bq0', 10); await set(A, '#br0', 285); await set(A, '#ba0', 2850);
await set(A, '#bs2', 'Fresh Meats'); await set(A, '#bi2', 'FM-1001');
st = await save(A, 'button[onclick="saveBill()"]');
ok('purchase saved', st.kind === 'saved' && await N(`select count(*) from purchase_lines`) === 1, st.text);
await A.reload({ waitUntil: 'networkidle0' }); await A.waitForSelector('#nav button');
await goDate(A, '2026-11-05'); await tab(A, 'Buy');
ok('1. purchase still there after reload', (await A.evaluate(() => document.body.innerText)).includes('₹2,850'));
const ls = await A.evaluate(() => Object.keys(localStorage));
ok('browser holds no business data (only login token / pending request ids)', !ls.includes('nest2') && ls.every((k) => /^sb-|ean_pending/.test(k)), ls.join(','));

// ---------- 2. close browser, reopen with a brand new profile (= browser data cleared)
await browser.close();
browser = await launch();
let A2 = await device(browser, 'A2');
ok('2. fresh browser has no session → sign-in screen', await A2.$('#le') !== null);
await login(A2, users[1]);
ok('2. records survive closing the browser / clearing site data', await S(A2, 'S.buy.length') === 1 && await S(A2, 'S.rm.length') === 3);

// ---------- 3/4. second device (owner) sees data and updates inventory; first device sees it
const B = await device(browser, 'B');
await login(B, users[0]);
ok('3. owner on another device sees both outlets + the purchase', JSON.stringify(await S(B, 'OUT')) === '["Areekode","Kondotty"]' && await S(B, 'S.buy.length') === 1);
await goDate(B, '2026-11-05'); await B.evaluate(() => { V.out = 'Areekode'; }); await tab(B, 'Stock');
ok('purchase flowed into Bought on Stock', await B.$eval(`#p_${ids.Chicken}`, (e) => e.value) === '10');
for (const [n, o, c] of [['Chicken', 2, 3], ['Oil', 5, 4], ['Buns', 60, 10]]) { await set(B, `#o_${ids[n]}`, o); await set(B, `#c_${ids[n]}`, c); }
st = await save(B, `button[onclick="saveStock('Areekode')"]`);
ok('4. stock saved from device B', st.kind === 'saved', st.text);
await goDate(A2, '2026-11-05'); await tab(A2, 'Stock');
await A2.evaluate(() => [...document.querySelectorAll('.who button')][0].click());
await A2.waitForFunction(() => document.getElementById(`c_${S.rm[0].id}`)?.value === '3');
ok('4. device A sees device B\'s stock after Reload', true);

// ---------- 7. concurrent modification
await goDate(B, '2026-11-05'); await tab(B, 'Stock');   // B loaded version v
await set(A2, `#c_${ids.Chicken}`, 4);
st = await save(A2, `button[onclick="saveStock('Areekode')"]`);
ok('A saves stock (closing 4)', st.kind === 'saved', st.text);
await set(B, `#c_${ids.Chicken}`, 1);
st = await save(B, `button[onclick="saveStock('Areekode')"]`);
await B.screenshot({ path: path.join(ROOT, 'verified-conflict.png') });
ok('7. stale save on device B is refused, not silently overwriting A', st.kind === 'fail' && /changed by someone else/.test(st.text), st.text);
ok('7. database still has A\'s value', +(await Q(`select closing from stock_entries where material_id=$1 and voided_at is null and day='2026-11-05'`, [ids.Chicken]))[0].closing === 4);
ok('7. B\'s typed numbers are still on screen + Reload offered', await B.$eval(`#c_${ids.Chicken}`, (e) => e.value) === '1' && await B.$('#st button[onclick="reload()"]') !== null);

// ---------- 5. internet disconnects during save
await tab(A2, 'Stock');
const wasteBefore = await N(`select count(*) from wastage`);
await A2.setOfflineMode(true); await A2.evaluate(() => dispatchEvent(new Event('offline')));
await set(A2, '#wq', 1.5); await set(A2, '#wh', 'Ravi');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5. offline: clear "Not saved" message', st.kind === 'fail' && /offline/i.test(st.text), st.text);
ok('5. offline: nothing written, nothing pretended', await N(`select count(*) from wastage`) === wasteBefore);
ok('5. offline: entry still on screen', await A2.$eval('#wq', (e) => e.value) === '1.5');
await A2.setOfflineMode(false); await A2.evaluate(() => dispatchEvent(new Event('online')));
// 5b. connection drops before the request reaches the database
gw.mode = 'refuse';
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
await A2.screenshot({ path: path.join(ROOT, 'verified-not-saved.png') });
ok('5b. dropped connection → "Not saved — no reply"', st.kind === 'fail' && /no reply/.test(st.text), st.text);
ok('5b. nothing written', await N(`select count(*) from wastage`) === wasteBefore);
// 5c. the worst case: DB commits, then the reply is lost. Retrying must NOT duplicate.
gw.mode = 'drop-reply';
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5c. reply lost after commit → app does not claim success', st.kind === 'fail', st.text);
ok('5c. (database did commit once)', await N(`select count(*) from wastage`) === wasteBefore + 1);
gw.mode = 'ok';
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
await A2.screenshot({ path: path.join(ROOT, 'verified-already-saved.png') });
ok('5c. user taps Save again → "Already saved", no duplicate row', st.kind === 'saved' && /Already saved/.test(st.text) && await N(`select count(*) from wastage`) === wasteBefore + 1, st.text);
// 5d. pending request id survives a page reload (retry after reload still de-duplicated)
gw.mode = 'drop-reply';
await set(A2, '#wq', 0.7); await set(A2, '#wh', 'Anu');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
gw.mode = 'ok';
await A2.reload({ waitUntil: 'networkidle0' }); await A2.waitForSelector('#nav button');
await goDate(A2, '2026-11-05'); await tab(A2, 'Stock');
await set(A2, '#wq', 0.7); await set(A2, '#wh', 'Anu');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5d. retry after page reload still not duplicated', /Already saved/.test(st.text) && await N(`select count(*) from wastage where qty=0.7`) === 1, st.text);

// 5e. reply lost, user then CHANGES the entry before retrying → app finds the first one was saved and stops
gw.mode = 'drop-reply';
await set(A2, '#wq', 0.9); await set(A2, '#wh', 'Edited retry');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
gw.mode = 'ok';
await set(A2, '#wq', 1.9);
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5e. edited retry after lost reply → stopped, "WAS saved after all", no second entry', /WAS saved after all/.test(st.text) && await N(`select count(*) from wastage where responsible='Edited retry'`) === 1, st.text);
// 5f. save succeeds but the refresh fails → further saves blocked until Reload
gw.mode = 'state-down';
await set(A2, '#wq', 0.3); await set(A2, '#wh', 'Stale test');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5f. saved but refresh failed → says so and offers Reload', st.kind === 'warn' && /could not refresh/.test(st.text), st.text);
await set(A2, '#wq', 0.3); await set(A2, '#wh', 'Stale test 2');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5f. next save on the stale screen is blocked (no duplicate)', st.kind === 'fail' && /out of date/.test(st.text) && await N(`select count(*) from wastage where responsible='Stale test'`) === 1, st.text);
gw.mode = 'ok';
await A2.evaluate(() => reload()); await A2.waitForFunction(() => !BUSY && !MSG);
await set(A2, '#wq', 0.4); await set(A2, '#wh', 'After reload');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5f. after Reload, saving works again', st.kind === 'saved', st.text);
// 5g. typed-but-unsaved stock counts survive saving a wastage entry on the same screen
await set(A2, `#c_${ids.Oil}`, 2.25);
await set(A2, '#wq', 0.1); await set(A2, '#wh', 'Keep typed');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('5g. typed closing count kept after saving wastage', st.kind === 'saved' && await A2.$eval(`#c_${ids.Oil}`, (e) => e.value) === '2.25' && await A2.$eval('#wq', (e) => e.value) === '', st.text);
A2.dialogs.length = 0;
await A2.evaluate(() => reload()); await new Promise((r) => setTimeout(r, 500));
ok('5g. Reload asks before discarding typed counts', A2.dialogs.some((d) => /clears the stock numbers/.test(d)));
await A2.waitForFunction(() => !BUSY);

// ---------- 6. database failure
db.on('error', () => {}); // this client dies with the server below
execSync(`pg_ctl -D .localdb/data stop -m fast`, { cwd: ROOT, env: PGENV, stdio: 'ignore' });
await set(A2, '#wq', 2.2); await set(A2, '#wh', 'DB down test');
st = await save(A2, `button[onclick="saveWaste('Areekode')"]`);
ok('6. database down → clear failure, no success shown', st.kind === 'fail', st.text);
execSync(`pg_ctl -D .localdb/data -o "-p 54329 -k /tmp" -l .localdb/pg.log -w start`, { cwd: ROOT, env: PGENV, stdio: 'ignore' });
db = new pg.Client(cfg); await db.connect();
await new Promise((r) => setTimeout(r, 1500));
let retryOk = false;
for (let i = 0; i < 10 && !retryOk; i++) { st = await save(A2, `button[onclick="saveWaste('Areekode')"]`); retryOk = st.kind === 'saved'; if (!retryOk) await new Promise((r) => setTimeout(r, 1000)); }
ok('6. after DB recovers, retry saves exactly once', retryOk && await N(`select count(*) from wastage where responsible='DB down test'`) === 1, st.text);

// ---------- 8. duplicate submissions (double / triple tap)
await tab(A2, 'Items');
await set(A2, '#mn', 'Cheese Fries'); await set(A2, '#mp', 90);
await A2.evaluate(() => { const b = document.querySelector('button[onclick="addM()"]'); b.click(); b.click(); b.click(); });
await A2.waitForFunction(() => !BUSY && document.getElementById('st').className !== 'saving');
ok('8. triple-tap Add → one menu item', await N(`select count(*) from menu_items where name='Cheese Fries'`) === 1);
await goDate(A2, '2026-11-06'); await tab(A2, 'Buy');
await A2.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add by hand').click());
await A2.select('select[onchange^="syncB();B.rows[0].rm"]', ids.Oil);
await set(A2, '#bq0', 15); await set(A2, '#br0', 140); await set(A2, '#ba0', 2100); await set(A2, '#bi2', 'OIL-9');
await A2.evaluate(() => { const b = document.querySelector('button[onclick="saveBill()"]'); b.click(); b.click(); });
await A2.waitForFunction(() => !BUSY && document.getElementById('st').className !== 'saving');
ok('8. double-tap Save purchase → one purchase', await N(`select count(*) from purchase_lines where day='2026-11-06'`) === 1);
// same bill entered again on another device
await goDate(B, '2026-11-06'); await B.evaluate(() => { V.out = 'Areekode'; B = null; }); await tab(B, 'Buy');
await B.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add by hand').click());
await B.select('select[onchange^="syncB();B.rows[0].rm"]', ids.Oil);
await set(B, '#bq0', 15); await set(B, '#br0', 140); await set(B, '#ba0', 2100); await set(B, '#bi2', 'OIL-9');
st = await save(B, 'button[onclick="saveBill()"]');
ok('8. same invoice from a second device is refused', st.kind === 'fail' && /already saved/.test(st.text) && await N(`select count(*) from purchase_lines where day='2026-11-06'`) === 1, st.text);

// ---------- history is never destroyed through the UI
await tab(A2, 'Buy');
await A2.evaluate(() => document.querySelector('button[onclick^="delBuy("]').click());
await A2.waitForFunction(() => !BUSY && document.getElementById('st').className === 'saved');
ok('deleting a purchase voids it (kept as history) and removes its Bought', await N(`select count(*) from purchase_lines where day='2026-11-06' and voided_at is not null`) === 1 &&
   +(await Q(`select purchased from stock_entries where day='2026-11-06' and material_id=$1 and voided_at is null`, [ids.Oil]))[0].purchased === 0);

// ---------- outlet separation in the UI
const K = await device(browser, 'K');
await login(K, users[2]);
ok('Kondotty staff sees only Kondotty and no Areekode records', JSON.stringify(await S(K, 'OUT')) === '["Kondotty"]' && await S(K, 'S.buy.length+S.inv.length+S.waste.length') === 0);
await tab(K, 'Items');
await set(K, '#an', 'Sneaky'); await set(K, '#ap', 1);
st = await save(K, 'button[onclick="addRM()"]');
ok('staff cannot change master data (clear refusal)', st.kind === 'fail' && /Only a manager/.test(st.text), st.text);

// ---------- existing features still work end-to-end (regression coverage)
const csv = path.join(ROOT, '.localdb', 'pos.csv');
fs.writeFileSync(csv, 'Date,Menu Item,Quantity Sold,Selling Price,Total Sales\n05-11-2026,Zinger Burger,40,120,\"4,800\"\n05-11-2026,ZINGER BRGR,5,120,600\n');
const evil = path.join(ROOT, '.localdb', 'evil.csv');
fs.writeFileSync(evil, 'Menu Item,Quantity Sold\n"<img src=x onerror=window.__pwned=1>\'"",3\n');
await goDate(A2, '2026-11-05'); await tab(A2, 'Sales');
await (await A2.$('input[type=file]')).uploadFile(evil);
await A2.waitForFunction(() => document.body.innerText.includes('is not in your menu'), { timeout: 20000 });
await new Promise((r) => setTimeout(r, 300));
ok('script in a POS file item name is shown as text, never executed', await A2.evaluate(() => window.__pwned === undefined && document.body.innerText.includes('<img src=x')));
await A2.evaluate(() => { P = null; draw(); });
await (await A2.$('input[type=file]')).uploadFile(csv);
await A2.waitForFunction(() => P && P.rows && document.body.innerText.includes('is not in your menu'), { timeout: 20000 });
ok('POS file parsed; unknown POS name flagged', true);
await A2.select('select[onchange^="mapN("]', burger);
await A2.waitForFunction(() => !BUSY && document.getElementById('st').className === 'saved');
ok('POS alias saved to database', await N(`select count(*) from pos_aliases where alias='zinger brgr'`) === 1);
st = await save(A2, 'button[onclick="confirmImp()"]');
const rowsNow = (await Q(`select day::text d, qty, amount from sales where voided_at is null`)).map((r) => r.d + ' ' + +r.qty + '/' + +r.amount).join();
ok('sales import confirmed: day-first date kept as 5 Nov (not 11 May), "4,800" read as 4800, aggregated 45 / ₹5,400', st.kind === 'saved' && rowsNow === '2026-11-05 45/5400', rowsNow);
await (await A2.$('input[type=file]')).uploadFile(csv);
await A2.waitForFunction(() => P && P.rows);
st = await save(A2, 'button[onclick="confirmImp()"]');
ok('re-importing the same file replaces, never double counts', st.kind === 'saved' && await N(`select count(*) from sales where voided_at is null`) === 1);
// a real .xlsx file (built with the same vendored SheetJS the app uses), dated the next day
{ const require = (await import('node:module')).createRequire(import.meta.url);
  const XLSX = require(path.join(ROOT, 'public/vendor/xlsx.full.min.js'));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'Menu Item', 'Quantity Sold', 'Total Sales'], ['06-11-2026', 'Zinger Burger', 12, 1440]]), 'Sales');
  fs.writeFileSync(path.join(ROOT, '.localdb', 'pos.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); }
await (await A2.$('input[type=file]')).uploadFile(path.join(ROOT, '.localdb', 'pos.xlsx'));
await A2.waitForFunction(() => P && P.rows && P.rows.length === 1, { timeout: 20000 });
st = await save(A2, 'button[onclick="confirmImp()"]');
ok('real .xlsx POS file imports with the vendored SheetJS 0.20.3', st.kind === 'saved' && await N(`select count(*) from sales where voided_at is null and day='2026-11-06' and qty=12 and amount=1440`) === 1, st.text);
await A2.evaluate(() => { V.date = '2026-11-05'; draw(); });
await tab(A2, 'Today');
const today = await A2.evaluate(() => document.body.innerText);
ok('Today report renders from database data (sales ₹5,400, food cost lines)', today.includes('₹5,400') && today.includes('Expected food cost'), today.replace(/\s+/g, ' ').slice(0, 260));
await A2.evaluate(() => { V.per = '7'; draw(); });
ok('7-day range report renders', (await A2.evaluate(() => document.body.innerText)).includes('days with data'));
A2.dialogs.length = 0;
await A2.evaluate(() => doExport('xlsx')); await new Promise((r) => setTimeout(r, 1500));
ok('Excel export runs without error', !A2.dialogs.some((d) => /did not load|Could not/.test(d)), A2.dialogs.join(' | '));
const pdf = await A2.evaluate(async () => { const R = repData(); const blob = pdfBuild(R); const t = await blob.text();
  return { head: t.slice(0, 5), size: blob.size, summary: t.includes('Food Cost Report'), table: /Ingredient/.test(t), lib: window.jspdf && window.jspdf.jsPDF.version }; });
ok('PDF report builds a real PDF with title and tables', pdf.head === '%PDF-' && pdf.size > 3000 && pdf.summary && pdf.table, JSON.stringify(pdf));
A2.dialogs.length = 0;
await A2.evaluate(() => doExport('pdf')); await new Promise((r) => setTimeout(r, 1500));
ok('PDF export runs without error', !A2.dialogs.some((d) => /did not load|Could not/.test(d)), A2.dialogs.join(' | '));
await A2.evaluate(() => { V.per = 'day'; V.date = '2026-11-05'; V.tab = 'items'; draw(); });
// edit material: fix a typing mistake in price → old row voided, history kept
await A2.$eval(`button[onclick="editM('${ids.Buns}')"]`, (b) => b.click());
await set(A2, '#ep', 6.5); await A2.select('#et', 'fix');
st = await save(A2, 'button[onclick="saveM()"]');
ok('price typo fixed; previous price kept as voided history', st.kind === 'saved' && await N(`select count(*) from material_prices where material_id=$1 and voided_at is not null`, [ids.Buns]) === 1 && await N(`select count(*) from material_prices where material_id=$1 and price=6.5 and voided_at is null`, [ids.Buns]) === 1, st.text);
// new price from a date via the table input
await A2.$eval(`#np_${ids.Oil}`, (e) => { e.value = '150'; e.dispatchEvent(new Event('change')); });
await A2.waitForFunction(() => !BUSY && document.getElementById('st').className === 'saved');
ok('new price recorded with date as history', await N(`select count(*) from material_prices where material_id=$1 and voided_at is null`, [ids.Oil]) >= 2);
// prep item + its recipe
await set(A2, '#pn', 'Mayo sauce'); await A2.select('#pu', 'g');
st = await save(A2, 'button[onclick="addP()"]');
const mayo = await S(A2, "S.rm.find(r=>r.name=='Mayo sauce').id");
await A2.$eval(`button[onclick="editR('${mayo}',1)"]`, (b) => b.click());
await set(A2, '#ey', 1000);
await A2.evaluate(() => [...document.querySelectorAll('#ed button')].find((b) => b.textContent.includes('+ Ingredient')).click());
await A2.select('#er0', ids.Oil); await set(A2, '#eq0', 800);
st = await save(A2, 'button[onclick="saveR()"]');
ok('prep item and batch recipe saved; cost computed', st.kind === 'saved' && (await A2.evaluate(() => document.body.innerText)).includes('Batch of 1000 g'), st.text);
// deleting a material used in a current recipe is refused with a clear reason
await A2.$eval(`button[onclick="editM('${ids.Chicken}')"]`, (b) => b.click());
st = await save(A2, 'button[onclick="delM()"]');
ok('cannot delete a material in a current recipe (clear message)', st.kind === 'fail' && /current recipe of: Zinger Burger/.test(st.text), st.text);
// delete a menu item → archived; its sales stay in reports
const cf = await S(A2, "S.menu.find(m=>m.name=='Cheese Fries').id");
st = await save(A2, `button[onclick="delMenu('${cf}')"]`);
ok('menu item deleted from the menu list but kept in the database', st.kind === 'saved' && await N(`select count(*) from menu_items where name='Cheese Fries' and archived_at is not null`) === 1);
// close day at Areekode needs every material; then reopen
await A2.evaluate(() => { V.tab = 'stock'; V.date = '2026-11-07'; draw(); });
st = await save(A2, `button[onclick="saveStock('Areekode',1)"]`);
ok('close day without counts refused before saving', st.kind !== 'saving' && A2.dialogs.some((d) => /closing (stock )?missing/.test(d)) && await N(`select count(*) from stock_days where day='2026-11-07' and closed`) === 0);
for (const n of ['Chicken', 'Oil', 'Buns']) await set(A2, `#c_${ids[n]}`, 0);
st = await save(A2, `button[onclick="saveStock('Areekode',1)"]`);
ok('day closed with all counts', st.kind === 'saved' && await N(`select count(*) from stock_days where day='2026-11-07' and closed`) === 1, st.text);
await A2.evaluate(() => { V.date = '2026-11-07'; draw(); });
st = await save(A2, `button[onclick="reopenDay('Areekode')"]`);
ok('manager reopens the day', st.kind === 'saved' && await N(`select count(*) from stock_days where day='2026-11-07' and closed`) === 0, st.text);
// settings: staff cannot change, manager can
await K.evaluate(() => { V.tab = 'set'; draw(); });
ok('staff sees settings read-only', await K.$eval('#st1', (e) => e.disabled));
await A2.evaluate(() => { V.tab = 'set'; draw(); });
await set(A2, '#st1', 38);
st = await save(A2, 'button[onclick="saveSet()"]');
ok('manager saves settings', st.kind === 'saved' && +(await Q(`select target from settings`))[0].target === 38, st.text);

// ---------- self-service password change (Settings)
await K.evaluate(() => { V.tab = 'set'; draw(); });
await set(K, '#np1', 'staff-pass-1'); await set(K, '#np2', 'staff-pass-1');
st = await save(K, '#npb');
ok('password change refused by the server is reported as NOT changed', st.kind === 'fail' && /NOT changed/.test(st.text) && users[2].password === 'staff-pass-1', st.text);
gw.authDown = true;
await set(K, '#np1', 'kondotty-new-pass-1'); await set(K, '#np2', 'kondotty-new-pass-1');
st = await save(K, '#npb');
gw.authDown = false;
ok('no reply from Auth: app does not claim success or failure, explains what to try', st.kind === 'fail' && /Could not confirm/.test(st.text), st.text);
await K.evaluate(() => { V.tab = 'set'; draw(); });
await set(K, '#np1', 'kondotty-new-pass-1'); await set(K, '#np2', 'kondotty-new-pass-1');
st = await save(K, '#npb');
ok('staff changes own password in Settings, confirmed by Auth', st.kind === 'saved' && /Password changed/.test(st.text) && users[2].password === 'kondotty-new-pass-1', st.text);
await K.evaluate(() => signOut()); await K.waitForSelector('#le');
await K.type('#le', users[2].email); await K.type('#lp', 'staff-pass-1'); await K.click('#lb');
await K.waitForFunction(() => /Sign in failed/.test(document.body.innerText));
ok('old password rejected after the change', true);
await K.goto(APP, { waitUntil: 'networkidle0' });
await login(K, { ...users[2], password: 'kondotty-new-pass-1' });
ok('new password signs in and loads the outlet data', JSON.stringify(await S(K, 'OUT')) === '["Kondotty"]');

ok('no JavaScript errors in any device', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
const ir = await Q(`select * from private.integrity_report()`);
ok('integrity report clean after the whole session', ir.every((x) => +x.problems === 0));
console.log('rpc calls seen by gateway:', gw.rpcLog.length);
await browser.close(); gw.server.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
