// Disaster-recovery login test (LOCAL stand-in for Supabase Auth; a real Supabase drill is still required).
// Starts from a "restored" database: staff rows exist, but NO logins. Then runs scripts/recreate-logins.mjs
// and drives the real app in Chrome through the forced "set your own password" flow.
//   tests/local/env.sh up && node tests/dr-logins.test.mjs
import puppeteer from 'puppeteer-core';
import pg from 'pg';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { randomUUID as uuid } from 'node:crypto';
import { startGateway, ANON_KEY, SERVICE_KEY } from './local/gateway.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
execSync('tests/local/env.sh reset', { cwd: ROOT, stdio: 'ignore' });
const db = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', database: 'eatatnest' }); await db.connect();
const N = async (sql, p = []) => +(await db.query(sql, p)).rows[0].count;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// the "restored backup": original ids + emails in public.staff, no auth users
const S = { owner: uuid(), mgr: uuid(), gone: uuid() };
await db.query(`insert into staff(user_id,email,name,role,active) values ($1,'yamin@example.test','Yamin','owner',true),($2,'mgr@example.test','Areekode Manager','manager',true),($3,'left@example.test','Former Staff','staff',false)`, [S.owner, S.mgr, S.gone]);
await db.query(`insert into staff_outlets values ($1,'Areekode'),($2,'Kondotty')`, [S.mgr, S.gone]);
// history written by the original ids before the disaster
await db.query(`begin; set local role authenticated; select set_config('request.jwt.claims', $1, true); select public.add_material(gen_random_uuid(),'Chicken','kg',260,0); commit;`.replace('$1', `'${JSON.stringify({ sub: S.owner })}'`));
await db.query(`grant select on public.staff to service_role`); // as on Supabase (service_role keeps SELECT)

const users = [];
const gw = await startGateway({ publicDir: path.join(ROOT, 'public'), users,
  onAdminCreate: (u) => db.query(`insert into auth.users(id,email) values ($1,$2)`, [u.id, u.email]) });
const URL_ = `http://localhost:${gw.port}`;
const run = (env, ...a) => new Promise((done) => {
  const p = spawn('node', ['scripts/recreate-logins.mjs', ...a], { cwd: ROOT, env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => out += d); p.on('close', (code) => done({ code, out }));
});
const E = { EAN_RECOVERY_URL: URL_, EAN_RECOVERY_SECRET_KEY: SERVICE_KEY };

// ---- guards
let r = await run({});
ok('refuses without URL/key', r.code === 2 && /set EAN_RECOVERY_URL/.test(r.out));
r = await run({ ...E, EAN_RECOVERY_SECRET_KEY: ANON_KEY });
ok('refuses the public (anon/publishable) key', r.code === 2 && /PUBLIC/.test(r.out));
r = await run({ ...E, EAN_RECOVERY_SECRET_KEY: 'sb_publishable_abc' });
ok('refuses an sb_publishable_ key', r.code === 2 && /PUBLIC/.test(r.out));
r = await run({ ...E, EAN_RECOVERY_URL: 'https://mwhuehfwfmakecylmikt.supabase.co' });
ok('refuses the ORIGINAL production project (before any network call)', r.code === 2 && /ORIGINAL production/.test(r.out));
gw.disableSignup = false;
r = await run(E, '--apply');
ok('refuses while public sign-up is on', r.code === 1 && /sign-up is ON/.test(r.out) && /No logins were kept/.test(r.out) && users.length === 0);
gw.disableSignup = true;
const out = r.out;
ok('never prints the secret key', !out.includes(SERVICE_KEY));

// ---- dry run
r = await run(E);
ok('dry run lists the 2 active staff, skips the deactivated one, creates nothing',
   r.code === 0 && /2 login\(s\) would be created/.test(r.out) && !/left@example/.test(r.out) && users.length === 0, r.out.split('\n').slice(-2).join(' '));

// ---- "Supabase ignored the id" safety net (on a throwaway copy of the state)
gw.ignoreAdminId = true;
r = await run(E, '--apply');
ok('if the original id is not kept: stops, removes the wrong login, says so honestly, points to the fallback',
   r.code === 1 && /did not keep the original id/.test(r.out) && /was removed again/.test(r.out) && /No logins were kept/.test(r.out) && users.length === 0, r.out.trim().split('\n').slice(-2).join(' / '));
gw.ignoreAdminId = false;
await db.query(`delete from auth.users`);

// ---- apply
r = await run(E, '--apply');
const pw = Object.fromEntries([...r.out.matchAll(/<([^>]+)>\s+\(\w+\)\s+(\S+)/g)].map((m) => [m[1], m[2]]));
ok('creates both logins', r.code === 0 && users.length === 2, `exit ${r.code}`);
ok('logins have the ORIGINAL ids', users.find((u) => u.email === 'yamin@example.test')?.id === S.owner && users.find((u) => u.email === 'mgr@example.test')?.id === S.mgr);
ok('logins are flagged must_change_password', users.every((u) => u.meta?.must_change_password === true));
ok('temporary passwords are random 16-character values shown once', Object.values(pw).length === 2 && Object.values(pw).every((p) => /^[A-Za-z0-9_-]{16}$/.test(p)));
ok('deactivated staff member gets no login', !users.some((u) => u.email === 'left@example.test'));
ok('business tables untouched (still 1 material, staff unchanged)', await N(`select count(*) from materials`) === 1 && await N(`select count(*) from staff`) === 3);
r = await run(E, '--apply');
ok('a second run is refused (no duplicate logins)', r.code === 1 && /already exist/.test(r.out) && users.length === 2);
r = await run(E, '--apply', '--skip-existing');
ok('--skip-existing resumes safely (nothing to create)', r.code === 0 && /Nothing to create/.test(r.out) && users.length === 2);

// ---- the person signs in with the temporary password and must set their own
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await (await browser.createBrowserContext()).newPage();
const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${URL_}/eatatnestinventory/`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#le');
const signIn = async (email, password) => { await page.$eval('#le', (e, v) => { e.value = v; }, email); await page.$eval('#lp', (e, v) => { e.value = v; }, password); await page.$eval('#lb', (b) => b.click()); };
await signIn('mgr@example.test', pw['mgr@example.test']);
await page.waitForFunction(() => /Set your own password/.test(document.body.innerText) || document.querySelector('#nav button'), { timeout: 15000 });
ok('temporary-password login shows ONLY the "Set your own password" screen (no data, no tabs)',
   await page.evaluate(() => /Set your own password/.test(document.body.innerText) && !document.querySelector('#nav button') && !/Chicken/.test(document.body.innerText)));
const setPw = async (a, b) => { await page.$eval('#np1', (e, v) => { e.value = v; }, a); await page.$eval('#np2', (e, v) => { e.value = v; }, b); await page.$eval('#npb', (x) => x.click()); await page.waitForFunction(() => !BUSY); await new Promise((z) => setTimeout(z, 300)); };
await setPw('short', 'short');
ok('too-short password refused, nothing changed', dialogs.some((d) => /at least 10/.test(d)) && users.find((u) => u.id === S.mgr).password === pw['mgr@example.test']);
await setPw('a-good-new-password', 'a-different-one!!');
ok('mismatched repeat refused, nothing changed', dialogs.some((d) => /do not match/.test(d)) && users.find((u) => u.id === S.mgr).password === pw['mgr@example.test']);
await setPw('manager-own-pass-1', 'manager-own-pass-1');
await page.waitForSelector('#nav button', { timeout: 10000 });
ok('after setting own password the app opens with the manager\'s data (app_state)',
   await page.evaluate(() => JSON.stringify(OUT) === '["Areekode"]' && S.rm.some((r) => r.name === 'Chicken') && /Password changed/.test(document.body.innerText)));
ok('password changed and flag cleared on the server', users.find((u) => u.id === S.mgr).password === 'manager-own-pass-1' && users.find((u) => u.id === S.mgr).meta.must_change_password === false);
await page.evaluate(() => signOut()); await page.waitForSelector('#le');
await signIn('mgr@example.test', pw['mgr@example.test']);
await page.waitForFunction(() => /Sign in failed/.test(document.body.innerText));
ok('old temporary password no longer works', true);
await page.goto(`${URL_}/eatatnestinventory/`, { waitUntil: 'networkidle0' }); await page.waitForSelector('#le');
await signIn('mgr@example.test', 'manager-own-pass-1');
await page.waitForSelector('#nav button', { timeout: 10000 });
ok('new password works and goes straight to the app (no forced screen)', await page.evaluate(() => !/Set your own password/.test(document.body.innerText)));
ok('history still attributed: material created before the disaster by the owner id', await N(`select count(*) from materials m join staff s on s.user_id = m.created_by where s.email='yamin@example.test'`) === 1);
ok('no JavaScript errors', errs.length === 0, errs.join(' | '));
await browser.close();

// ---- verify-production: active staff matched, deactivated staff ignored
const vp = (await db.query((await import('node:fs')).readFileSync(path.join(ROOT, 'scripts/verify-production.sql'), 'utf8'))).rows;
const row = (n) => vp.find((x) => x.name.startsWith(n));
ok('verify-production: every ACTIVE staff member has a matching login → PASS (deactivated one not required)', row('every ACTIVE staff member')?.result === 'PASS', JSON.stringify(row('every ACTIVE staff member')));
ok('verify-production: exactly one active owner → PASS', row('exactly one active owner')?.result === 'PASS');

gw.server.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
