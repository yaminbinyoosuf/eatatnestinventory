// LOCAL TESTING ONLY — a stand-in for the Supabase API gateway:
//   /auth/v1/*   minimal Supabase-Auth-compatible password login (HS256 JWTs)
//   /rest/v1/*   proxied to the local PostgREST (same layer Supabase uses)
//   everything else: the static app from ./public, mounted at /eatatnestinventory/
//                    (config.js is replaced so the app points at this gateway)
// Fault injection for tests:  gw.mode = 'ok' | 'refuse' (drop before reaching the DB)
//                             | 'drop-reply' (DB runs + commits, reply is lost) | 'hang'
//                             | 'state-down' (writes work, reloading data fails)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SECRET = 'local-test-jwt-secret-at-least-32-chars-long';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
export function jwt(claims) {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(claims);
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
export const ANON_KEY = jwt({ role: 'anon', iss: 'local', iat: 1700000000, exp: 4100000000 });
export const SERVICE_KEY = jwt({ role: 'service_role', iss: 'local', iat: 1700000000, exp: 4100000000 }); // LOCAL ONLY
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

// users: [{ id, email, password, meta }]. Options mimic Supabase Auth settings / behaviour:
//   gw.disableSignup (default true), gw.minPassword (default 10, as recommended in docs/SETUP.md),
//   gw.ignoreAdminId (simulate an Auth server that ignores the requested id), onAdminCreate(user) hook.
export function startGateway({ publicDir, users, port = 0, onAdminCreate }) {
  const gw = { mode: 'ok', rpcLog: [], disableSignup: true, minPassword: 10, ignoreAdminId: false, users };
  const userObj = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email' }, user_metadata: u.meta || {}, created_at: u.created_at || new Date().toISOString() });
  const claims = (req) => { try { return JSON.parse(Buffer.from((req.headers.authorization || '').split(' ')[1].split('.')[1], 'base64url')); } catch { return null; } };
  const sessions = new Map(); // refresh token -> user
  const issue = (u) => {
    const now = Math.floor(Date.now() / 1000), refresh = crypto.randomUUID();
    sessions.set(refresh, u);
    const user = userObj(u);
    return { access_token: jwt({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, iat: now, exp: now + 3600 }),
             token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user };
  };
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/auth/v1/')) {
      if (gw.authDown) return req.socket.destroy();   // test switch: Auth unreachable / reply lost
      const b = await body(req); const j = b.length ? JSON.parse(b) : {};
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        const u = users.find((x) => x.email === j.email && x.password === j.password);
        return u ? send(res, 200, issue(u)) : send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' });
      }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const u = sessions.get(j.refresh_token); return u ? send(res, 200, issue(u)) : send(res, 400, { msg: 'Invalid Refresh Token' });
      }
      if (url.pathname === '/auth/v1/logout') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/auth/v1/settings') return send(res, 200, { disable_signup: gw.disableSignup, external: { email: true } });
      if (url.pathname === '/auth/v1/user' && req.method === 'PUT') {
        const c = claims(req), u = c && users.find((x) => x.id === c.sub);
        if (!u) return send(res, 401, { code: 'bad_jwt', msg: 'invalid JWT' });
        if (j.password !== undefined) {
          if (String(j.password).length < gw.minPassword) return send(res, 422, { code: 'weak_password', msg: `Password should be at least ${gw.minPassword} characters.` });
          if (j.password === u.password) return send(res, 422, { code: 'same_password', msg: 'New password should be different from the old password.' });
          u.password = j.password;
        }
        if (j.data) u.meta = { ...(u.meta || {}), ...j.data };
        return send(res, 200, userObj(u));
      }
      if (url.pathname.startsWith('/auth/v1/admin/')) {
        const c = claims(req);
        if (!c || c.role !== 'service_role') return send(res, 403, { code: 'not_admin', msg: 'User not allowed' });
        if (url.pathname === '/auth/v1/admin/users' && req.method === 'GET') {
          const page = +(url.searchParams.get('page') || 1), per = +(url.searchParams.get('per_page') || 50);
          res.setHeader('x-total-count', String(users.length));
          return send(res, 200, { users: users.slice((page - 1) * per, page * per).map(userObj), aud: 'authenticated' });
        }
        if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
          if (users.some((x) => x.email === j.email)) return send(res, 422, { code: 'email_exists', msg: 'A user with this email address has already been registered' });
          const id = gw.ignoreAdminId || !j.id ? crypto.randomUUID() : j.id;
          if (users.some((x) => x.id === id)) return send(res, 422, { code: 'user_already_exists', msg: 'User already exists' });
          const u = { id, email: j.email, password: j.password, meta: j.user_metadata || {} };
          users.push(u); if (onAdminCreate) await onAdminCreate(u);
          return send(res, 200, userObj(u));
        }
        const m = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
        if (m && req.method === 'GET') { const u = users.find((x) => x.id === m[1]); return u ? send(res, 200, userObj(u)) : send(res, 404, { code: 'user_not_found', msg: 'User not found' }); }
        if (m && req.method === 'DELETE') { const i = users.findIndex((x) => x.id === m[1]); if (i >= 0) users.splice(i, 1); return send(res, 200, {}); }
      }
      if (url.pathname === '/auth/v1/user') {
        const tok = (req.headers.authorization || '').split('.')[1];
        const c = tok && JSON.parse(Buffer.from(tok, 'base64url')); const u = c && users.find((x) => x.id === c.sub);
        return u ? send(res, 200, userObj(u)) : send(res, 401, { msg: 'invalid' });
      }
      return send(res, 404, { msg: 'not implemented in local stub' });
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      const b = await body(req);
      const fn = url.pathname.replace('/rest/v1/rpc/', '');
      if (fn !== 'app_state') gw.rpcLog.push({ fn, mode: gw.mode });
      if (gw.mode === 'refuse') return req.socket.destroy();
      if (gw.mode === 'state-down' && fn === 'app_state') return req.socket.destroy(); // writes work, refresh fails
      if (gw.mode === 'hang') return; // never answer
      const mode = gw.mode;
      const up = http.request({ host: '127.0.0.1', port: 54330, method: req.method, path: url.pathname.slice(8) + url.search,
        headers: { ...req.headers, host: '127.0.0.1:54330', 'content-length': b.length } }, (r) => {
        const chunks = []; r.on('data', (d) => chunks.push(d)); r.on('end', () => {
          if (mode === 'drop-reply' && fn !== 'app_state') return req.socket.destroy(); // committed, reply lost
          res.writeHead(r.statusCode, r.headers); res.end(Buffer.concat(chunks));
        });
      });
      up.on('error', () => send(res, 502, { message: 'gateway: PostgREST unreachable' }));
      return up.end(b);
    }
    // static app
    let p = url.pathname.replace(/^\/eatatnestinventory/, '') || '/';
    if (p === '/') p = '/index.html';
    if (p === '/config.js') {
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(`window.EAN_CONFIG={url:'http://localhost:${server.address().port}',key:'${ANON_KEY}'};`);
    }
    const abs = path.join(publicDir, path.normalize(p));
    if (!abs.startsWith(publicDir) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => { gw.server = server; gw.port = server.address().port; ok(gw); }));
}
