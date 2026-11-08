// Database-level tests: permissions (RLS), validation, idempotency, concurrency,
// no-delete / immutability guarantees. Runs against the local stack
// (tests/local/env.sh up). Each user call is executed exactly the way PostgREST
// executes it: `set local role authenticated` + `request.jwt.claims`.
//   node tests/db.test.mjs
import pg from 'pg';
import { randomUUID as uuid } from 'node:crypto';
import { execSync } from 'node:child_process';

execSync('tests/local/env.sh reset', { cwd: new URL('..', import.meta.url).pathname, stdio: 'inherit' });
const cfg = { host: 'localhost', port: 54329, user: 'postgres', database: 'eatatnest' };
const admin = new pg.Client(cfg); await admin.connect();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const U = { owner: uuid(), mgr: uuid(), staffK: uuid(), outsider: uuid() };
await admin.query(`insert into auth.users(id,email) values ($1,'owner@x.in'),($2,'mgr@x.in'),($3,'staffk@x.in'),($4,'out@x.in')`, [U.owner, U.mgr, U.staffK, U.outsider]);
await admin.query(`insert into staff(user_id,email,name,role) values ($1,'owner@x.in','Owner','owner'),($2,'mgr@x.in','Manager A','manager'),($3,'staffk@x.in','Staff K','staff')`, [U.owner, U.mgr, U.staffK]);
await admin.query(`insert into staff_outlets values ($1,'Areekode'),($2,'Kondotty')`, [U.mgr, U.staffK]);

// run fn(client) as a user in one transaction, like a PostgREST request
async function as(user, sql, params = [], client) {
  const c = client || new pg.Client(cfg); if (!client) await c.connect();
  try {
    await c.query('begin');
    if (user === 'anon') await c.query(`set local role anon`);
    else { await c.query(`set local role authenticated`); await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })]); }
    const r = await c.query(sql, params);
    await c.query('commit');
    return { rows: r.rows, row: r.rows[0] };
  } catch (e) { await c.query('rollback').catch(() => {}); return { err: e, code: e.code, msg: e.message }; }
  finally { if (!client) await c.end(); }
}
const rpc = (user, fn, args) => {
  const keys = Object.keys(args);
  return as(user, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as r`,
    keys.map(k => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k])) || (Array.isArray(args[k]) && typeof args[k][0] === 'object') ? JSON.stringify(args[k]) : args[k]))
    .then(x => x.err ? x : { ...x, r: x.row.r });
};
const count = async (sql, p = []) => +(await admin.query(sql, p)).rows[0].count;
const state = async u => (await as(u, 'select public.app_state() s')).row?.s;

// ---- 1. anonymous & outsider access
let r = await as('anon', 'select * from materials'); ok('anon cannot read tables', r.code === '42501', r.msg);
r = await as('anon', 'select public.app_state()'); ok('anon cannot call app_state', r.code === '42501', r.msg);
r = await rpc('anon', 'add_menu', { p_req: uuid(), p_name: 'X', p_price: 10 }); ok('anon cannot call write RPCs', r.code === '42501', r.msg);
r = await as(U.outsider, 'select public.app_state()'); ok('signed-in non-staff gets NS403 from app_state', r.code === 'NS403', r.msg);
r = await rpc(U.outsider, 'add_wastage', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_rm: uuid(), p_qty: 1, p_why: '', p_who: '' });
ok('non-staff cannot write', r.code === 'NS403', r.msg);
r = await as(U.outsider, 'select count(*) from materials'); ok('non-staff reads zero rows (RLS)', r.row && +r.row.count === 0);

// ---- 2. direct table writes are impossible for app users
for (const [sql, label] of [[`insert into outlets values ('Hacked')`, 'insert'], [`update settings set target=1`, 'update'], [`delete from settings`, 'delete']]) {
  r = await as(U.owner, sql); ok(`even owner cannot ${label} tables directly (only via RPC)`, r.code === '42501', r.msg);
}

// ---- 3. role checks
r = await rpc(U.staffK, 'add_material', { p_req: uuid(), p_name: 'Salt', p_unit: 'kg', p_price: 20, p_min: 0 });
ok('staff cannot add materials (manager-only)', r.code === 'NS403', r.msg);

r = await rpc(U.mgr, 'add_menu', { p_req: uuid(), p_name: '<img src=x onerror=alert(1)>', p_price: 10 });
ok('HTML/script in a name is refused (stored XSS guard)', r.code === '23514' && await count(`select count(*) from menu_items`) === 0, r.msg);
// ---- 4. master data + idempotency
const req1 = uuid();
r = await rpc(U.mgr, 'add_material', { p_req: req1, p_name: 'Chicken', p_unit: 'kg', p_price: 260, p_min: 5 });
ok('manager adds material', r.r?.ok && !r.r.duplicate, JSON.stringify(r.r || r.msg));
const chicken = r.r.id;
r = await rpc(U.mgr, 'add_material', { p_req: req1, p_name: 'Chicken', p_unit: 'kg', p_price: 260, p_min: 5 });
ok('same request id retried → duplicate:true, not applied twice', r.r?.duplicate === true && await count(`select count(*) from materials where name='Chicken'`) === 1);
r = await rpc(U.mgr, 'add_material', { p_req: uuid(), p_name: ' chicken ', p_unit: 'kg', p_price: 1, p_min: 0 });
ok('duplicate material name rejected', r.code === 'NS400', r.msg);
r = await rpc(U.mgr, 'add_material', { p_req: req1, p_name: 'Other', p_unit: 'kg', p_price: 1, p_min: 0 });
ok('request id reused for different payload of same op is still treated as duplicate (no write)', r.r?.duplicate === true && await count(`select count(*) from materials where name='Other'`) === 0);
r = await rpc(U.mgr, 'add_menu', { p_req: req1, p_name: 'Y', p_price: 1 });
ok('request id reused for a different op is rejected', r.code === 'NS400', r.msg);
const oil = (await rpc(U.mgr, 'add_material', { p_req: uuid(), p_name: 'Oil', p_unit: 'l', p_price: 140, p_min: 2 })).r.id;
r = await rpc(U.mgr, 'add_wastage', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_rm: chicken, p_qty: 1, p_why: 'x', p_who: '<script>' });
ok('HTML in wastage text refused', r.code === '23514', r.msg);
const burger = (await rpc(U.mgr, 'add_menu', { p_req: uuid(), p_name: 'Zinger Burger', p_price: 120 })).r.id;
r = await rpc(U.mgr, 'save_recipe', { p_req: uuid(), p_kind: 'menu', p_owner: burger, p_version: 1, p_from: '2026-11-01', p_yield: null, p_items: [{ rm: chicken, q: 90 }, { rm: oil, q: 20 }] });
ok('recipe saved', r.r?.ok, r.msg);
r = await rpc(U.mgr, 'save_recipe', { p_req: uuid(), p_kind: 'menu', p_owner: burger, p_version: 1, p_from: '2026-11-02', p_yield: null, p_items: [{ rm: chicken, q: 95 }] });
ok('recipe save with stale version → NS409 conflict', r.code === 'NS409', r.msg);
r = await rpc(U.mgr, 'save_recipe', { p_req: uuid(), p_kind: 'menu', p_owner: burger, p_version: 2, p_from: '2026-11-02', p_yield: null, p_items: [{ rm: chicken, q: 0 }] });
ok('recipe with zero quantity rejected, nothing written', r.code === 'NS400' && await count(`select count(*) from recipe_versions`) === 1);

// ---- 5. purchases
const bill = { p_outlet: 'Areekode', p_day: '2026-11-01', p_supplier: 'Fresh Meats', p_invoice: 'INV-77', p_lines: [{ rm: chicken, qty: 10, rate: 285, amt: 2850, bn: 'Chkn' }, { rm: '', new_name: 'Buns', new_unit: 'pc', qty: 60, rate: 6, amt: 360, bn: 'Bun' }] };
const breq = uuid();
r = await rpc(U.mgr, 'save_purchase', { p_req: breq, ...bill }); ok('purchase saved', r.r?.ok && r.r.lines === 2, r.msg);
r = await rpc(U.mgr, 'save_purchase', { p_req: breq, ...bill }); ok('purchase retry with same request id → not doubled', r.r?.duplicate === true && await count(`select count(*) from purchase_lines`) === 2);
r = await rpc(U.mgr, 'save_purchase', { p_req: uuid(), ...bill }); ok('same supplier invoice entered again (new request) → refused', r.code === 'NS400' && /already saved/.test(r.msg), r.msg);
let e = (await admin.query(`select purchased, opening from stock_entries where material_id=$1 and voided_at is null`, [chicken])).rows;
ok('purchase adds to Bought in stock', e.length === 1 && +e[0].purchased === 10);
ok('bill price recorded in price history', await count(`select count(*) from material_prices where material_id=$1 and price=285 and effective_date='2026-11-01'`, [chicken]) === 1);
ok('supplier record created', await count(`select count(*) from suppliers where name='Fresh Meats'`) === 1);
r = await rpc(U.staffK, 'save_purchase', { p_req: uuid(), ...bill, p_invoice: 'Z' }); ok('Kondotty staff cannot buy for Areekode', r.code === 'NS403', r.msg);

// ---- 6. stock: validation, versions, concurrency, close/reopen
let s = await state(U.mgr); let v = s.days['2026-11-01|Areekode'].v;
const stockRows = (close) => [{ rm: chicken, open: 0, pur: 10, inn: 0, out: 0, close }, { rm: oil, open: 5, pur: 0, inn: 0, out: 0, close: 4 }, { rm: (s.rm.find(x => x.name === 'Buns')).id, open: 0, pur: 60, inn: 0, out: 0, close: 10 }];
const before = await count(`select count(*) from stock_entries`);
r = await rpc(U.mgr, 'save_stock', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v, p_close: false, p_rows: stockRows(50) });
ok('closing higher than available → rejected', r.code === 'NS400' && /higher/.test(r.msg), r.msg);
ok('…and the failed save wrote nothing (transaction rolled back)', await count(`select count(*) from stock_entries`) === before);
r = await rpc(U.mgr, 'save_stock', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v, p_close: false, p_rows: stockRows(-1) });
ok('negative stock rejected', r.code === 'NS400', r.msg);
// two devices saved concurrently from the same loaded version: exactly one wins
const c1 = new pg.Client(cfg), c2 = new pg.Client(cfg); await c1.connect(); await c2.connect();
const [a, b] = await Promise.all([
  rpc(U.mgr, 'save_stock', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v, p_close: false, p_rows: stockRows(3) }),
  rpc(U.owner, 'save_stock', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v, p_close: false, p_rows: stockRows(4) })]);
const wins = [a, b].filter(x => x.r?.ok).length, conflicts = [a, b].filter(x => x.code === 'NS409').length;
ok('concurrent stock saves from same version: one saved, other got NS409 (no silent overwrite)', wins === 1 && conflicts === 1, `${a.code || 'ok'} / ${b.code || 'ok'}`);
ok('exactly one active stock row per material', await count(`select count(*) from stock_entries where voided_at is null and day='2026-11-01'`) === 3);
// concurrent identical request id (double-tap reaching server twice)
const dreq = uuid();
const [d1, d2] = await Promise.all([1, 2].map(() => rpc(U.mgr, 'add_wastage', { p_req: dreq, p_outlet: 'Areekode', p_day: '2026-11-01', p_rm: chicken, p_qty: 0.4, p_why: 'Spoilage', p_who: 'Kitchen' })));
ok('same request sent twice concurrently → applied once', await count(`select count(*) from wastage`) === 1 && [d1, d2].some(x => x.r?.duplicate), `${JSON.stringify(d1.r)} ${JSON.stringify(d2.r)}`);
s = await state(U.mgr); v = s.days['2026-11-01|Areekode'].v;
r = await rpc(U.mgr, 'save_stock', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v, p_close: true, p_rows: stockRows(3) });
ok('close day', r.r?.ok, r.msg);
s = await state(U.mgr); v = s.days['2026-11-01|Areekode'].v;
r = await rpc(U.mgr, 'save_purchase', { p_req: uuid(), ...bill, p_invoice: 'NEW-1' }); ok('purchase on closed day refused', r.code === 'NS400', r.msg);
r = await rpc(U.mgr, 'save_stock', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v, p_close: false, p_rows: stockRows(3) });
ok('stock save on closed day refused', r.code === 'NS400', r.msg);
await admin.query(`insert into staff_outlets values ($1,'Areekode')`, [U.staffK]);
r = await rpc(U.staffK, 'reopen_day', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v }); ok('staff cannot reopen a closed day', r.code === 'NS403', r.msg);
await admin.query(`delete from staff_outlets where user_id=$1 and outlet='Areekode'`, [U.staffK]);
r = await rpc(U.mgr, 'reopen_day', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-11-01', p_version: v }); ok('manager reopens day', r.r?.ok, r.msg);

// ---- 7. void purchase line
s = await state(U.mgr);
const line = s.buy.find(x => x.rm === chicken);
r = await rpc(U.mgr, 'void_purchase_line', { p_req: uuid(), p_id: line.id }); ok('purchase line voided', r.r?.ok, r.msg);
e = (await admin.query(`select purchased from stock_entries where material_id=$1 and voided_at is null and day='2026-11-01'`, [chicken])).rows;
ok('voiding purchase reduces Bought', +e[0].purchased === 0);
ok('voided purchase still exists as history', await count(`select count(*) from purchase_lines where id=$1 and voided_at is not null`, [line.id]) === 1);

// ---- 8. sales import replace semantics
const rows = [{ d: '2026-11-01', mid: burger, qty: 50, amt: 6000 }];
r = await rpc(U.mgr, 'import_sales', { p_req: uuid(), p_outlet: 'Areekode', p_file: 'pos.xlsx', p_rows: rows }); ok('sales imported', r.r?.rows === 1, r.msg);
r = await rpc(U.mgr, 'import_sales', { p_req: uuid(), p_outlet: 'Areekode', p_file: 'pos2.xlsx', p_rows: [{ ...rows[0], qty: 55, amt: 6600 }] });
ok('re-import replaces, no double counting', r.r?.replaced === 1 && await count(`select count(*) from sales where voided_at is null`) === 1 && await count(`select count(*) from sales`) === 2);
r = await as(U.staffK, 'select count(*) from sales'); ok('Kondotty staff cannot see Areekode sales (RLS)', +r.row.count === 0);
r = await rpc(U.mgr, 'import_sales', { p_req: uuid(), p_outlet: 'Areekode', p_file: 'x', p_rows: [{ ...rows[0], amt: -5 }] }); ok('negative sales amount rejected', r.code === 'NS400', r.msg);

// ---- 9. archive rules keep history
r = await rpc(U.mgr, 'archive_material', { p_req: uuid(), p_id: oil, p_version: (await state(U.mgr)).rm.find(x => x.id === oil).version });
ok('material in current recipe cannot be deleted', r.code === 'NS400' && /current recipe/.test(r.msg), r.msg);
s = await state(U.mgr);
r = await rpc(U.mgr, 'archive_menu', { p_req: uuid(), p_id: burger, p_version: s.menu[0].version }); ok('menu item archived', r.r?.ok, r.msg);
s = await state(U.mgr);
ok('sales of archived menu item kept', s.sales.length === 1 && s.menu[0].archived === true);
r = await rpc(U.mgr, 'archive_material', { p_req: uuid(), p_id: oil, p_version: s.rm.find(x => x.id === oil).version });
ok('material archivable once only archived items use it', r.r?.ok, r.msg);
s = await state(U.mgr);
ok('archived material + its stock history still returned', s.rm.find(x => x.id === oil)?.archived === true && s.inv.some(x => x.rm === oil));

// ---- 9b. review fixes
await admin.query(`insert into staff_outlets values ($1,'Areekode')`, [U.staffK]);
const today = new Date().toISOString().slice(0, 10);
s = await state(U.mgr);
const bunsId = s.rm.find(x => x.name === 'Buns').id;
r = await rpc(U.staffK, 'save_stock', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2000-01-01', p_version: 0, p_close: false, p_rows: [{ rm: bunsId, open: 0, close: 0, pp: 0.0001 }] });
ok('staff cannot back-date a price through stock "price paid"', r.code === 'NS403' && await count(`select count(*) from material_prices where price=0.0001`) === 0, r.msg);
r = await rpc(U.staffK, 'save_purchase', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2000-01-02', p_supplier: '', p_invoice: '', p_lines: [{ rm: bunsId, qty: 1, rate: 0.01, amt: 0.01 }] });
ok('staff cannot back-date a price through an old bill', r.code === 'NS403', r.msg);
r = await rpc(U.staffK, 'save_purchase', { p_req: uuid(), p_outlet: 'Areekode', p_day: today, p_supplier: '', p_invoice: '', p_lines: [{ rm: bunsId, qty: 10, rate: 6.5, amt: 65 }] });
ok('staff can still record today\'s bill price', r.r?.ok, r.msg);
r = await rpc(U.mgr, 'save_purchase', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2026-10-01', p_supplier: '', p_invoice: '', p_lines: [{ rm: bunsId, qty: 1, rate: 5.5, amt: 5.5 }] });
ok('manager can record an older bill price', r.r?.ok, r.msg);
await admin.query(`delete from staff_outlets where user_id=$1 and outlet='Areekode'`, [U.staffK]);
r = await rpc(U.owner, 'save_settings', { p_req: uuid(), p_version: (await state(U.owner)).set.version, p_target: 40, p_t1: 0, p_t2: 'NaN', p_t3: 'NaN' });
ok('NaN can never be stored', r.code === '23514', r.msg);
r = await rpc(U.mgr, 'add_material', { p_req: uuid(), p_name: 'Inf', p_unit: 'kg', p_price: 'Infinity', p_min: 0 });
ok('Infinity can never be stored', !!r.code && await count(`select count(*) from materials where name='Inf'`) === 0, r.msg);
s = await state(U.mgr);
const ch = s.rm.find(x => x.id === chicken);
r = await rpc(U.mgr, 'update_material', { p_req: uuid(), p_id: chicken, p_version: ch.version, p_name: 'Chicken', p_unit: 'g', p_min: 0, p_price: null, p_price_mode: 'new', p_day: today });
ok('unit of a material with history cannot change', r.code === 'NS400' && /cannot change/.test(r.msg), r.msg);
const fresh = (await rpc(U.mgr, 'add_material', { p_req: uuid(), p_name: 'Salt', p_unit: 'kg', p_price: 20, p_min: 0 })).r.id;
r = await rpc(U.mgr, 'update_material', { p_req: uuid(), p_id: fresh, p_version: 1, p_name: 'Salt', p_unit: 'g', p_min: 0, p_price: null, p_price_mode: 'new', p_day: today });
ok('unit of an unused material can still be corrected', r.r?.ok, r.msg);
const inv = { p_outlet: 'Areekode', p_day: today, p_supplier: 'Oil Co', p_invoice: 'OC-5', p_lines: [{ rm: bunsId, qty: 2, rate: 6.5, amt: 13 }] };
await rpc(U.mgr, 'save_purchase', { p_req: uuid(), ...inv });
const lineId = (await admin.query(`select l.id from purchase_lines l join purchase_bills b on b.id=l.bill_id where b.invoice_no='OC-5'`)).rows[0].id;
await rpc(U.mgr, 'void_purchase_line', { p_req: uuid(), p_id: lineId });
ok('deleting the last line voids the bill', await count(`select count(*) from purchase_bills where invoice_no='OC-5' and voided_at is not null`) === 1);
r = await rpc(U.mgr, 'save_purchase', { p_req: uuid(), ...inv, p_lines: [{ rm: bunsId, qty: 3, rate: 6.5, amt: 19.5 }] });
ok('…so the corrected invoice can be re-entered', r.r?.ok, r.msg);
const rq = uuid(), never = uuid();
await rpc(U.mgr, 'add_wastage', { p_req: rq, p_outlet: 'Areekode', p_day: today, p_rm: bunsId, p_qty: 1, p_why: '', p_who: '' });
r = await as(U.mgr, `select public.applied_requests($1::uuid[]) a`, [[rq, never]]);
ok('applied_requests reports which unanswered saves were applied', JSON.stringify(r.row.a) === JSON.stringify([rq]));
r = await as(U.owner, `select public.applied_requests($1::uuid[]) a`, [[rq]]);
ok('applied_requests never reveals another user\'s requests', r.row.a.length === 0);


for (const t of ['sales', 'stock_entries', 'materials', 'purchase_lines', 'audit_log', 'material_prices']) {
  r = await admin.query(`delete from ${t}`).catch(e => e); ok(`DELETE from ${t} blocked even for superuser`, r.code === 'NS403', r.message);
}
r = await admin.query(`truncate sales cascade`).catch(e => e); ok('TRUNCATE blocked', r.code === 'NS403', r.message);
r = await admin.query(`update sales set amount = 1`).catch(e => e); ok('editing a sale in place blocked', r.code === 'NS403', r.message);
r = await admin.query(`update audit_log set action='x'`).catch(e => e); ok('audit log cannot be altered', r.code === 'NS403', r.message);

// ---- 11. settings conflict, audit, integrity
s = await state(U.owner);
r = await rpc(U.owner, 'save_settings', { p_req: uuid(), p_version: s.set.version, p_target: 40, p_t1: 3, p_t2: 5, p_t3: 10 }); ok('settings saved', r.r?.ok, r.msg);
r = await rpc(U.mgr, 'save_settings', { p_req: uuid(), p_version: s.set.version, p_target: 45, p_t1: 3, p_t2: 5, p_t3: 10 }); ok('stale settings save → NS409', r.code === 'NS409', r.msg);
ok('audit log records who changed what', await count(`select count(*) from audit_log where user_id=$1 and table_name='purchase_lines'`, [U.mgr]) >= 2);
r = await as(U.mgr, 'select count(*) from audit_log'); ok('only owner can read audit log', +r.row.count === 0);
r = await as(U.owner, 'select count(*) from audit_log'); ok('owner can read audit log', +r.row.count > 0);
s = await state(U.owner); ok('owner sees both outlets', JSON.stringify(s.me.outlets) === '["Areekode","Kondotty"]');
s = await state(U.staffK); ok('staff sees only own outlet', JSON.stringify(s.me.outlets) === '["Kondotty"]');
const ir = (await admin.query(`select * from private.integrity_report()`)).rows;
ok('integrity report clean', ir.every(x => +x.problems === 0), JSON.stringify(ir.filter(x => +x.problems)));

await c1.end(); await c2.end(); await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
