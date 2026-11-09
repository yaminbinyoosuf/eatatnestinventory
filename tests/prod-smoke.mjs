// READ-ONLY smoke test against the real Supabase project in public/config.js.
// It never creates, changes or deletes anything.
//
//   cd tests && node prod-smoke.mjs                      # anonymous checks only
//   EAN_EMAIL=you@example.com EAN_PASSWORD='…' node prod-smoke.mjs   # + owner login checks
//
// Type the password only in your own terminal. The script never prints it.
// Every "cannot write" probe uses a value the database would reject anyway (an outlet
// name that violates its check constraint, an unknown material), so even a
// misconfigured database could not end up with a stray row.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import { randomUUID as uuid } from 'node:crypto';

const cfgText = fs.readFileSync(new URL('../public/config.js', import.meta.url), 'utf8');
// EAN_URL / EAN_KEY override the config only for testing this script against the local stack
const url = process.env.EAN_URL || cfgText.match(/url:\s*'([^']+)'/)[1], key = process.env.EAN_KEY || cfgText.match(/key:\s*'([^']+)'/)[1];
if (/YOUR-/.test(url + key)) { console.error('public/config.js still has a placeholder (URL or publishable key).'); process.exit(2); }
if (/^sb_secret_/.test(key) || /service_role/.test(Buffer.from((key.split('.')[1] || ''), 'base64url').toString())) {
  console.error('STOP: public/config.js contains a SECRET / service_role key. Replace it with the publishable key.'); process.exit(2);
}
console.log(`project: ${url}\nkey type: ${key.startsWith('sb_publishable_') ? 'publishable' : 'legacy anon JWT'}\n`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const denied = (r) => !!r.error && !r.data?.length && r.status !== 200 && r.status !== 201;
const TABLES = ['outlets','staff','staff_outlets','settings','materials','material_prices','menu_items','recipe_versions','recipe_items',
  'pos_aliases','suppliers','stock_days','stock_entries','wastage','sales_imports','sales','purchase_bills','purchase_lines','client_requests','audit_log'];
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

// ---------- anonymous (anyone on the internet with the public key)
const anon = createClient(url, key, opts);
let r = await anon.rpc('app_state');
ok('anonymous: app_state refused', denied(r), r.error?.code || `HTTP ${r.status}`);
const readable = [];
for (const t of TABLES) { const q = await anon.from(t).select('*').limit(1); if (!q.error) readable.push(t); }
ok('anonymous: no table readable (20 tables probed)', readable.length === 0, readable.join(', '));
r = await anon.from('outlets').insert({ name: '!! smoke-test (invalid name, never stored)' });
ok('anonymous: direct table insert refused by permissions', r.error?.code === '42501' || r.status === 401, r.error?.code || `HTTP ${r.status}`);
r = await anon.rpc('add_wastage', { p_req: uuid(), p_outlet: 'Areekode', p_day: '2000-01-01', p_rm: uuid(), p_qty: 1, p_why: '', p_who: '' });
ok('anonymous: write function refused', denied(r), r.error?.code || `HTTP ${r.status}`);
// (sign-up is NOT probed: if it were still enabled the probe would create a login. verify-production.sql checks for stray logins.)

// ---------- signed in as you (optional)
if (process.env.EAN_EMAIL && process.env.EAN_PASSWORD) {
  const sb = createClient(url, key, opts);
  const li = await sb.auth.signInWithPassword({ email: process.env.EAN_EMAIL, password: process.env.EAN_PASSWORD });
  ok('owner login', !li.error && !!li.data.session, li.error?.message);
  if (!li.error) {
    r = await sb.rpc('app_state');
    const me = r.data?.me;
    ok('app_state works for the owner', !r.error && !!me, r.error?.message);
    ok('role is owner', me?.role === 'owner', me?.role);
    ok('owner sees Areekode and Kondotty', JSON.stringify(me?.outlets) === '["Areekode","Kondotty"]', JSON.stringify(me?.outlets));
    ok('settings and data arrays present', !!r.data?.set && Array.isArray(r.data?.rm) && Array.isArray(r.data?.sales),
       r.data ? `materials ${r.data.rm.length}, menu ${r.data.menu.length}, sales ${r.data.sales.length}, purchases ${r.data.buy.length}` : '');
    r = await sb.from('materials').select('id').limit(1);
    ok('owner can read tables (RLS select)', !r.error, r.error?.message);
    r = await sb.from('client_requests').select('id').limit(1);
    ok('request ledger stays hidden even from the owner', denied(r), r.error?.code);
    r = await sb.from('outlets').insert({ name: '!! smoke-test (invalid name, never stored)' });
    ok('even the owner cannot write tables directly (only via functions)', r.error?.code === '42501', r.error?.code || `HTTP ${r.status}`);
    r = await sb.rpc('applied_requests', { p_ids: [uuid()] });
    ok('read-only function call works (applied_requests)', !r.error && Array.isArray(r.data) && r.data.length === 0, r.error?.message);
    const ref = await sb.auth.refreshSession();
    r = await sb.rpc('app_state');
    ok('session refresh works and the new token is accepted', !ref.error && !r.error, ref.error?.message || r.error?.message);
    await sb.auth.signOut();
    r = await sb.rpc('app_state');
    ok('after sign-out, data is refused', denied(r), r.error?.code || `HTTP ${r.status}`);
  }
} else {
  console.log('\n(owner checks skipped: set EAN_EMAIL and EAN_PASSWORD in your own terminal to include them)');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
