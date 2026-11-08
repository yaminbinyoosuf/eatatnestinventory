#!/usr/bin/env node
// DISASTER RECOVERY ONLY: see docs/RECOVERY.md §3.
//
// After scripts/restore.sh has restored a backup into a NEW Supabase project, this recreates a
// Supabase Auth login for every ACTIVE staff member, with each person's ORIGINAL user id and email
// (read from the restored public.staff table). Because the ids are unchanged:
//   - no staff record needs re-linking, and outlet access is untouched;
//   - the audit log and every created_by / voided_by / updated_by field still name the right person.
// Each login gets a random temporary password and the flag must_change_password, so the app makes
// the person choose their own password before they can see any data.
//
// Run it yourself, in your own terminal, against the NEW project. It needs that project's SECRET key
// (or legacy service_role key). Type the key at the hidden prompt; never paste it into a file, chat
// or the app:
//
//   cd ~/Desktop/eatatnestinventory/scripts && npm ci && cd ..      # once (installs the locked supabase-js version)
//   read -r "EAN_RECOVERY_URL?New project URL: " && read -rs "EAN_RECOVERY_SECRET_KEY?New project secret key: " && echo
//   EAN_RECOVERY_URL="$EAN_RECOVERY_URL" EAN_RECOVERY_SECRET_KEY="$EAN_RECOVERY_SECRET_KEY" node scripts/recreate-logins.mjs           # dry run
//   EAN_RECOVERY_URL="$EAN_RECOVERY_URL" EAN_RECOVERY_SECRET_KEY="$EAN_RECOVERY_SECRET_KEY" node scripts/recreate-logins.mjs --apply
//   unset EAN_RECOVERY_SECRET_KEY
//
// It never prints the key, never writes any file, and never changes business tables.
// Temporary passwords are printed ONCE on your screen so you can hand them over in person.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const ORIGINAL_PRODUCTION_REF = 'mwhuehfwfmakecylmikt';
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply'), skipExisting = args.has('--skip-existing');
const handover = [];   // logins created by this run (and kept)
let strayLogin = false; // a wrongly-id'd login that could not be removed
const stop = (msg, code = 1) => {
  console.error(`\nSTOPPED: ${msg}`);
  console.error((handover.length ? `${handover.length} login(s) WERE created and kept; they are listed above. ` : strayLogin ? '' : 'No logins were kept. ')
    + (strayLogin ? 'One wrongly created login is STILL there (see above). ' : '') + 'Business data was not touched.');
  process.exit(code);
};

const url = (process.env.EAN_RECOVERY_URL || '').trim().replace(/\/+$/, '');
const key = (process.env.EAN_RECOVERY_SECRET_KEY || '').trim();
if (!url || !key) stop('set EAN_RECOVERY_URL and EAN_RECOVERY_SECRET_KEY (see the instructions at the top of this file).', 2);
if (!/^https?:\/\/[^/]+$/.test(url)) stop('EAN_RECOVERY_URL must look like https://<project-ref>.supabase.co', 2);
if (key.startsWith('sb_publishable_') || /"role":"anon"/.test(Buffer.from(key.split('.')[1] || '', 'base64url').toString()))
  stop('that is the PUBLIC (publishable/anon) key. This script needs the new project\'s SECRET key.', 2);
if (url.includes(ORIGINAL_PRODUCTION_REF) && !args.has('--target-is-original-project'))
  stop(`EAN_RECOVERY_URL is the ORIGINAL production project (${ORIGINAL_PRODUCTION_REF}). Logins there still exist; this script is only for a NEW project restored from backup.`, 2);

let createClient;
try { ({ createClient } = createRequire(new URL('./package.json', import.meta.url))('@supabase/supabase-js')); }
catch { stop('supabase-js not found. Run "cd scripts && npm ci" once, then try again.', 2); }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

console.log(`Project: ${url}\nMode: ${apply ? 'APPLY (will create logins)' : 'dry run (nothing will be created)'}\n`);

// 1. Public sign-up must be OFF first, so nobody can pre-register a staff email.
let settings;
try { settings = await (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })).json(); }
catch (e) { stop(`could not reach ${url} (${e.message}).`); }
if (settings?.disable_signup !== true)
  stop('public sign-up is ON in the new project. Authentication → Sign In / Providers → Email → turn OFF "Allow new users to sign up", then run again.');

// 2. Active staff from the restored database.
const { data: staff, error: staffErr } = await sb.from('staff').select('user_id,email,name,role,active').eq('active', true).order('role');
if (staffErr) stop(`could not read public.staff (${staffErr.message}). Restore the backup first with scripts/restore.sh.`);
if (!staff.length) stop('the restored database has no active staff.');
if (!staff.some((s) => s.role === 'owner')) stop('the restored database has no active owner.');

// 3. Logins that already exist in the new project.
const existing = new Map();
for (let page = 1; ; page++) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) stop(`could not list existing logins (${error.message}). Is this the SECRET key of the new project?`);
  for (const u of data.users) existing.set(u.id, u);
  if (data.users.length < 1000) break;
}
const byEmail = new Map([...existing.values()].map((u) => [String(u.email || '').toLowerCase(), u]));

const plan = staff.map((s) => {
  const same = existing.get(s.user_id), other = byEmail.get(s.email);
  if (same) return { ...s, action: String(same.email).toLowerCase() === s.email ? 'exists' : 'conflict-id' };
  if (other) return { ...s, action: 'conflict-email' };
  return { ...s, action: 'create' };
});
console.log('Active staff in the restored database:');
for (const p of plan) console.log(`  ${p.role.padEnd(7)} ${p.name} <${p.email}>  →  ${p.action}`);

const conflicts = plan.filter((p) => p.action.startsWith('conflict'));
if (conflicts.length) stop(`${conflicts.length} login(s) already exist with a different id or email (${conflicts.map((c) => c.email).join(', ')}). ` +
  'Logins created in the dashboard get new ids. Delete those logins in Authentication → Users and run again, or use the fallback re-link in docs/RECOVERY.md.');
const exists = plan.filter((p) => p.action === 'exists');
if (exists.length && !skipExisting) stop(`${exists.length} of these logins already exist. If you are resuming an interrupted run, add --skip-existing.`);
const toCreate = plan.filter((p) => p.action === 'create');
if (!toCreate.length) { console.log('\nNothing to create: every active staff member already has a login.'); process.exit(0); }
if (!apply) { console.log(`\nDry run only: ${toCreate.length} login(s) would be created. Re-run with --apply to create them.`); process.exit(0); }

// 4. Create the logins with their original ids.
for (const s of toCreate) {
  const password = crypto.randomBytes(12).toString('base64url');   // 16 random characters
  const { data, error } = await sb.auth.admin.createUser({ id: s.user_id, email: s.email, password, email_confirm: true,
                                                           user_metadata: { must_change_password: true } });
  if (error) { report(); stop(`creating the login for ${s.email} failed: ${error.message}. Logins created so far are listed above; fix the problem and re-run with --apply --skip-existing.`); }
  if (data.user.id !== s.user_id) {
    const del = await sb.auth.admin.deleteUser(data.user.id);
    strayLogin = !!del.error;
    report();
    stop(`Supabase did not keep the original id for ${s.email}. ` + (del.error
      ? `The wrongly created login could NOT be removed (${del.error.message}): delete ${s.email} by hand in Authentication → Users. `
      : 'The wrongly created login was removed again. ') + 'Use the fallback in docs/RECOVERY.md (dashboard logins + re-link by email).');
  }
  handover.push({ ...s, password });
}
report();
console.log('\nDone. Next: unset EAN_RECOVERY_SECRET_KEY, clear this terminal (Cmd+K), then run scripts/verify-production.sql.');

function report() {
  if (!handover.length) return;
  console.log('\nTemporary passwords. Shown ONCE and saved nowhere. Give each one to that person in person or by');
  console.log('phone call, never by chat, SMS or email. The app makes them choose their own password at first sign-in.\n');
  for (const h of handover) console.log(`  ${h.name} <${h.email}>  (${h.role})   ${h.password}`);
}
