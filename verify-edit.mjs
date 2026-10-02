#!/usr/bin/env node
/**
 * verify-edit.mjs
 *
 * Adversarial CDP harness for the NEW edit/delete feature of the single-file app
 * "eat@nest Inventory & Food Cost" (public/index.html).
 *
 * It boots the app exactly like verify-browser.mjs does (real http server on ./public,
 * real headless Chrome, raw CDP over the `ws` module), then drives the REAL UI to
 * edit and delete records, checks S + localStorage + a full page reload, and
 * deliberately probes the highest-risk case: deleting a material that a menu recipe
 * still points at.
 *
 * Re-run:  node verify-edit.mjs
 * Exit 0 = every assertion passed; 1 = at least one FAIL; 2 = harness error.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_URL_PATH = '/index.html';
const SHOT_NAME = 'verified-4-edit.png';

/* ------------------------------------------------------------------ *
 * tiny test harness
 * ------------------------------------------------------------------ */
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${detail}`);
}
function warn(name, detail) {
  console.log(`WARN  ${name}\n        observed: ${detail}`);
}
function info(msg) { console.log(`      ${msg}`); }
function section(title) { console.log(`\n=== ${title} ===`); }

/* ------------------------------------------------------------------ *
 * ws resolution (no network installs; reuse an existing copy if present)
 * ------------------------------------------------------------------ */
function loadWs() {
  const require = createRequire(import.meta.url);
  const candidates = [
    'ws',
    '/Users/yamin/Downloads/floraweb-main/node_modules/ws',
    '/Users/yamin/Downloads/kanakamahal-jewellery (2)/node_modules/ws',
    '/Users/yamin/Downloads/km web/node_modules/ws',
  ];
  for (const c of candidates) {
    try {
      const m = require(c);
      const WS = m.WebSocket || m;
      if (typeof WS === 'function') return { WS, from: c };
    } catch { /* try next */ }
  }
  throw new Error('No usable `ws` package found locally.');
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */
const getFreePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, interval = 150, label = 'condition' } = {}) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

/* ------------------------------------------------------------------ *
 * static file server for ./public
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};
function startStaticServer() {
  const requestLog = [];
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = rawPath === '/' || rawPath === '' ? '/index.html' : rawPath;
    const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!abs.startsWith(PUBLIC_DIR)) { requestLog.push({ url: rawPath, status: 403 }); res.writeHead(403); res.end('forbidden'); return; }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { requestLog.push({ url: rawPath, status: 404 }); res.writeHead(404); res.end('not found'); return; }
    requestLog.push({ url: rawPath, status: 200 });
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requestLog }));
  });
}

/* ------------------------------------------------------------------ *
 * minimal CDP client
 * ------------------------------------------------------------------ */
class CDP {
  constructor(WS, url) { this.WS = WS; this.url = url; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new this.WS(this.url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`)); else res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
          for (const h of this.handlers.get(msg.method) || []) { try { h(msg.params); } catch { /* ignore */ } }
        }
      });
    });
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000);
    });
  }
  async eval(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue, awaitPromise, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      const err = new Error(`EVAL EXCEPTION: ${desc}`);
      err.cdp = d;
      throw err;
    }
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws && this.ws.close(); } catch { /* ignore */ } }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
let chromeProc = null, profileDir = null, staticSrv = null, cdp = null;

async function cleanup() {
  try { if (cdp) cdp.close(); } catch { /* ignore */ }
  try {
    if (chromeProc && !chromeProc.killed) {
      chromeProc.kill('SIGTERM');
      await sleep(600);
      if (!chromeProc.killed) chromeProc.kill('SIGKILL');
    }
  } catch { /* ignore */ }
  try { if (staticSrv) await new Promise((r) => staticSrv.close(r)); } catch { /* ignore */ }
  try { if (profileDir && fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main() {
  if (!fs.existsSync(CHROME_BIN)) throw new Error(`Chrome not found at ${CHROME_BIN}`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) throw new Error('public/index.html missing');

  const { WS, from } = loadWs();
  info(`WebSocket impl: ws from ${from}`);

  const { server, port: httpPort, requestLog } = await startStaticServer();
  staticSrv = server;
  const appUrl = `http://127.0.0.1:${httpPort}${APP_URL_PATH}`;
  info(`Serving ${PUBLIC_DIR} at http://127.0.0.1:${httpPort}/  (app: ${appUrl})`);

  const debugPort = await getFreePort();
  profileDir = fs.mkdtempSync(path.join(ROOT, '.verify-edit-profile-'));
  info(`Chrome profile: ${profileDir}`);

  const flags = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
    '--window-size=390,844', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*', '--disable-background-networking', '--no-default-browser-check',
    '--disable-extensions', 'about:blank',
  ];
  chromeProc = spawn(CHROME_BIN, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeStderr = '';
  chromeProc.stderr.on('data', (d) => { chromeStderr += d.toString(); });
  chromeProc.on('error', (e) => { chromeStderr += `\nspawn error: ${e.message}`; });

  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return r.ok ? r.json() : null;
  }, { label: 'Chrome /json/version', timeout: 25000 });
  info(`Chrome: ${version.Browser}`);

  let targetInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    targetInfo = await r.json();
  } catch {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`);
    targetInfo = await r.json();
  }
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((t) => t.id === targetInfo.id) || targetInfo;
  if (!target.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl for new target');

  cdp = new CDP(WS, target.webSocketDebuggerUrl);
  await cdp.connect();

  const consoleMsgs = [], exceptions = [], logEntries = [], dialogs = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    consoleMsgs.push({
      type: p.type,
      text: (p.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' '),
      url: p.stackTrace?.callFrames?.[0]?.url, line: p.stackTrace?.callFrames?.[0]?.lineNumber,
    });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    exceptions.push({
      text: d.text,
      desc: d.exception?.description || d.exception?.value,
      url: d.url || d.stackTrace?.callFrames?.[0]?.url,
      line: (d.lineNumber ?? d.stackTrace?.callFrames?.[0]?.lineNumber),
      stack: d.stackTrace?.callFrames?.slice(0, 5).map((f) => `${f.functionName || '(anon)'} @ ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`),
    });
  });
  cdp.on('Log.entryAdded', (p) => {
    logEntries.push({ level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url, line: p.entry.lineNumber });
  });
  // CDP-level dialog handler: ACCEPT every dialog (belt and braces -- the page-side
  // stub installed below normally intercepts confirm()/alert() before a real dialog).
  cdp.on('Page.javascriptDialogOpening', async (p) => {
    dialogs.push({ type: p.type, message: p.message });
    try { await cdp.send('Page.handleJavaScriptDialog', { accept: true }); } catch { /* ignore */ }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__alerts = [];
      window.__confirms = [];
      window.__scriptErrors = [];
      window.alert = function (m) { window.__alerts.push(String(m)); };
      window.confirm = function (m) { window.__confirms.push(String(m)); return true; };
      window.addEventListener('error', function (e) {
        if (e && e.target && e.target.tagName === 'SCRIPT') {
          window.__scriptErrors.push('script load error: ' + (e.target.src || 'inline'));
        }
      }, true);
      window.addEventListener('unhandledrejection', function (e) {
        window.__scriptErrors.push('unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
      });
    `,
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }).catch(() => {});

  const loadFired = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 30000);
    cdp.on('Page.loadEventFired', () => { clearTimeout(t); resolve('fired'); });
  });
  await cdp.send('Page.navigate', { url: appUrl });
  info(`load event: ${await loadFired}`);
  await sleep(1500);

  /* ---------------- harness-side helpers ---------------- */
  const q = async (expr) => JSON.parse(await cdp.eval(`JSON.stringify(${expr})`));
  const evalSafe = async (expr) => { try { return { ok: true, value: await cdp.eval(expr) }; } catch (e) { return { ok: false, error: String(e.message || e) }; } };
  const clickExact = (onclick) => cdp.eval(`(()=>{const want=${JSON.stringify(onclick)};const b=[...document.querySelectorAll('#app button')].find(x=>(x.getAttribute('onclick')||'')===want);if(!b)return {found:false,want};b.click();return {found:true,want,label:b.textContent.trim()};})()`);
  const clickSub = (s) => cdp.eval(`(()=>{const want=${JSON.stringify(s)};const b=[...document.querySelectorAll('#app button')].find(x=>(x.getAttribute('onclick')||'').indexOf(want)>=0);if(!b)return {found:false,want};b.click();return {found:true,want,onclick:b.getAttribute('onclick'),label:b.textContent.trim()};})()`);
  const reloadPage = async () => {
    const fired = new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 30000);
      cdp.on('Page.loadEventFired', () => { clearTimeout(t); resolve('fired'); });
    });
    await cdp.send('Page.reload', { ignoreCache: false });
    const s = await fired;
    await sleep(1200);
    return s;
  };
  const appExceptions = (list) => list.filter((e) => {
    const blob = `${e.text || ''} ${e.desc || ''} ${e.url || ''}`;
    return !/xlsx|cdnjs/i.test(blob);
  });
  const fmtEx = (list) => list.map((e) => `${e.text} :: ${(e.desc || '').split('\n')[0]} @ ${e.url}:${(e.line ?? -1) + 1}`).join(' | ');
  const lsRM = `(()=>{try{const o=JSON.parse(localStorage.getItem('nest2'));return {ok:true,rm:o.rm,menu:o.menu,inv:o.inv,waste:o.waste,bytes:(localStorage.getItem('nest2')||'').length};}catch(e){return {ok:false,error:String(e)}}})()`;

  /* ================================================================== *
   * (a) controls + seeded state
   * ================================================================== */
  section('(a) Edit controls, table structure, seeded demo counts');

  await cdp.eval(`V.tab='items';draw();`); // the raw-materials table + menu list live on the Items tab

  const A = await q(`(()=>{
    const matTable=document.querySelector('#app table');
    const ths=matTable?[...matTable.querySelectorAll('tr')][0].querySelectorAll('th'):[];
    const thTexts=[...ths].map(h=>h.textContent.trim());
    const rows=matTable?[...matTable.querySelectorAll('tr')].slice(1):[];
    const matEditBtns=matTable?[...matTable.querySelectorAll('button')].filter(b=>(b.getAttribute('onclick')||'').indexOf('editM(')===0):[];
    const editTextBtns=[...document.querySelectorAll('#app button')].filter(b=>b.textContent.trim()==='Edit');
    const menuEditBtns=[...document.querySelectorAll('#app button')].filter(b=>(b.getAttribute('onclick')||'').indexOf('editR(')===0);
    const delBtns=[...document.querySelectorAll('#app button')].filter(b=>(b.getAttribute('onclick')||'').indexOf('delM(')===0);
    return {
      tab:V.tab, tableCount:document.querySelectorAll('#app table').length,
      thTexts, thCount:thTexts.length, emptyThCount:thTexts.filter(x=>x==='').length,
      matRowCount:rows.length, matEditBtnCount:matEditBtns.length,
      matEditOnclicks:matEditBtns.map(b=>b.getAttribute('onclick')),
      editTextBtnCount:editTextBtns.length,
      menuEditBtnCount:menuEditBtns.length,
      menuEditLabels:[...new Set(menuEditBtns.map(b=>b.textContent.trim()))],
      menuEditOnclicks:menuEditBtns.map(b=>b.getAttribute('onclick')),
      deleteBtnCount:delBtns.length,
      sRm:S.rm.length, sMenu:S.menu.length, prepCount:S.rm.filter(r=>r.prep).length,
      nonPrepCount:S.rm.filter(r=>!r.prep).length,
      rmIds:S.rm.map(r=>r.id), rmNames:S.rm.map(r=>r.name),
      menuIds:S.menu.map(m=>m.id), menuNames:S.menu.map(m=>m.name),
      Vdate:V.date, lsBytes:(localStorage.getItem('nest2')||'').length,
      title:document.title, readyState:document.readyState,
    };
  })()`);

  record('a1. Seeded demo state: S.rm=8 raw materials, S.menu=5 menu items',
    A.sRm === 8 && A.sMenu === 5,
    `S.rm.length=${A.sRm} (${A.nonPrepCount} non-prep rows + ${A.prepCount} prep), S.menu.length=${A.sMenu}; V.date=${A.Vdate}; localStorage['nest2']=${A.lsBytes} bytes`);

  record('a2. RAW MATERIALS table has the new empty 6th <th> column',
    A.thCount === 6 && A.emptyThCount === 1 && A.thTexts[5] === '',
    `#app tables=${A.tableCount}; raw-material th=[${A.thTexts.map((t) => JSON.stringify(t)).join(', ')}]; thCount=${A.thCount}, empty <th> count=${A.emptyThCount}, last th=${JSON.stringify(A.thTexts[5])}`);

  record('a3. RAW MATERIALS table renders one Edit button per material',
    A.matEditBtnCount === A.nonPrepCount && A.matEditBtnCount === 8 && A.matRowCount === 8,
    `${A.matRowCount} material rows, ${A.matEditBtnCount} Edit buttons in the raw-materials table (one per non-prep material; text==="Edit" buttons in whole tab=${A.editTextBtnCount}); onclicks=[${A.matEditOnclicks.join(', ')}]`);

  record('a4. MENU ITEMS list renders one Edit control per menu item (label "Edit recipe")',
    A.menuEditBtnCount === 5 && A.menuEditLabels.length === 1 && A.menuEditLabels[0] === 'Edit recipe',
    `${A.menuEditBtnCount} per-menu-item controls for ${A.sMenu} menu items; labels=[${A.menuEditLabels.map((l) => JSON.stringify(l)).join(', ')}]; onclicks=[${A.menuEditOnclicks.join(', ')}]; menu names=[${A.menuNames.join(', ')}]`);

  info(`NOTE: no button exists with the bare label "Edit" outside the raw-materials table; the per-menu-item control is "Edit recipe". Delete buttons (onclick delM()) currently rendered: ${A.deleteBtnCount} (they live inside the material editor card, not the table).`);

  /* usage map for the seeded state (which material is used where) */
  const USE = await q(`(()=>{
    const f=id=>({
      menuRecipe:S.menu.some(m=>m.rec.some(v=>v.items.some(i=>i.rm==id))),
      prepRecipe:S.rm.some(p=>p.prep&&p.rec.some(v=>v.items.some(i=>i.rm==id))),
      stock:S.inv.some(e=>e.rm==id),
      waste:S.waste.some(w=>w.rm==id),
      usedM:(typeof usedM==='function')?usedM(id):null,
    });
    const per={};S.rm.forEach(r=>per[r.id]=f(r.id));
    return {
      per,
      recipeUsed:S.rm.filter(r=>per[r.id].menuRecipe).map(r=>r.id),
      totallyUnused:S.rm.filter(r=>!per[r.id].menuRecipe&&!per[r.id].prepRecipe&&!per[r.id].stock&&!per[r.id].waste).map(r=>r.id),
      menuRecipeRefs:[...new Set(S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.map(i=>i.rm))))],
    };
  })()`);
  info(`seeded usage: materials referenced by menu recipes = [${USE.menuRecipeRefs.join(', ')}]; totally unused demo materials = [${USE.totallyUnused.join(', ')}]`);

  /* ================================================================== *
   * (b) EDIT a raw material end-to-end through the real UI
   * ================================================================== */
  section('(b) Edit a raw material through the real UI');

  const TARGET = 'r2';
  const beforeEdit = await q(`(()=>{const r=rmOf(${JSON.stringify(TARGET)});return {id:r.id,name:r.name,unit:r.unit,min:r.min,prices:r.prices,priceNow:price(r.id,V.date),Vdate:V.date,lsBytes:(localStorage.getItem('nest2')||'').length};})()`);
  info(`target material ${TARGET}: name=${JSON.stringify(beforeEdit.name)}, unit=${beforeEdit.unit}, price@${beforeEdit.Vdate}=${beforeEdit.priceNow}`);

  const editClick = await clickExact(`editM('${TARGET}')`);
  const editor = await q(`(()=>{const el=document.getElementById('em');return {
    clickFound:${editClick.found}, present:!!el, title:el?el.querySelector('h3').textContent:'',
    en:val('en'),eu:val('eu'),ep:val('ep'),emn:val('emn'),et:val('et'),
    EM:EM, editorScrolledIntoView: el? el.getBoundingClientRect().top>=0 && el.getBoundingClientRect().top<800 : null,
    saveBtn:!!document.querySelector('#em button[onclick="saveM()"]'),
    cancelBtn:!!document.querySelector('#em button[onclick="EM=null;draw()"]'),
    deleteBtn:!!document.querySelector('#em button[onclick="delM()"]'),
    alerts:window.__alerts.slice(),confirms:window.__confirms.slice()};})()`);

  record('b1. Clicking the table Edit button opens the material editor with the record pre-filled',
    editClick.found === true && editor.present === true && editor.en === beforeEdit.name && editor.eu === beforeEdit.unit
      && Number(editor.ep) === Number(beforeEdit.priceNow) && editor.EM === TARGET && editor.saveBtn && editor.cancelBtn && editor.deleteBtn,
    `Edit onclick="editM('${TARGET}')" found=${editClick.found}; editor #em present=${editor.present}, <h3>=${JSON.stringify(editor.title)}; fields: #en=${JSON.stringify(editor.en)}, #eu=${JSON.stringify(editor.eu)}, #ep=${JSON.stringify(editor.ep)}, #emn=${JSON.stringify(editor.emn)}, #et=${JSON.stringify(editor.et)}; EM=${JSON.stringify(editor.EM)}; buttons save/cancel/delete present=${editor.saveBtn}/${editor.cancelBtn}/${editor.deleteBtn}`);

  // ---- required screenshot: material editor open
  await sleep(300);
  {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(path.join(ROOT, SHOT_NAME), Buffer.from(data, 'base64'));
  }

  const NEW_NAME = 'ZZ Cheese Wedge';
  const NEW_UNIT = 'g';
  const NEW_PRICE = 512.75;
  const NEW_MIN = 7;
  const filled = await cdp.eval(`(()=>{document.getElementById('en').value=${JSON.stringify(NEW_NAME)};document.getElementById('eu').value=${JSON.stringify(NEW_UNIT)};document.getElementById('ep').value=${JSON.stringify(String(NEW_PRICE))};document.getElementById('emn').value=${JSON.stringify(String(NEW_MIN))};document.getElementById('et').value='new';return {en:val('en'),eu:val('eu'),ep:val('ep'),emn:val('emn'),et:val('et')};})()`);
  const saveClick = await clickExact('saveM()');
  await sleep(250);

  const afterEdit = await q(`(()=>{const r=rmOf(${JSON.stringify(TARGET)});return {
    saveClickFound:${saveClick.found},
    exists:!!r,name:r&&r.name,unit:r&&r.unit,min:r&&r.min,prices:r&&r.prices,
    priceNow:r?price(r.id,V.date):null,EM:EM,editorPresent:!!document.getElementById('em'),
    alerts:window.__alerts.slice(),confirms:window.__confirms.slice(),
    rowName:document.querySelector('#app table tr td')?document.querySelector('#app table tr td').textContent:null};})()`);
  const lsAfterEdit = JSON.parse(await cdp.eval(`JSON.stringify(${lsRM})`));
  const lsRecEdit = lsAfterEdit.ok ? lsAfterEdit.rm.find((r) => r.id === TARGET) : null;
  const lsPriceEdit = lsRecEdit ? (lsRecEdit.prices.filter((p) => p.d <= beforeEdit.Vdate).sort((a, b) => (a.d < b.d ? -1 : 1)).pop() || {}).p : null;

  record('b2. saveM() via the real Save button applied the new name + unit + price in S.rm and closed the editor',
    afterEdit.saveClickFound === true && afterEdit.exists && afterEdit.name === NEW_NAME && afterEdit.unit === NEW_UNIT
      && Number(afterEdit.min) === NEW_MIN && Number(afterEdit.priceNow) === NEW_PRICE && afterEdit.EM === null && afterEdit.editorPresent === false,
    `after Save: rmOf('${TARGET}')={name:${JSON.stringify(afterEdit.name)}, unit:${JSON.stringify(afterEdit.unit)}, min:${afterEdit.min}, priceNow@${beforeEdit.Vdate}=${afterEdit.priceNow}}, prices=${JSON.stringify(afterEdit.prices)}; EM=${JSON.stringify(afterEdit.EM)}, #em present=${afterEdit.editorPresent}; typed=${JSON.stringify(filled)}; confirm() prompts shown by saveM (unit-change guard)=${JSON.stringify(afterEdit.confirms)}`);

  record('b3. The edit was persisted to localStorage.nest2',
    lsAfterEdit.ok === true && !!lsRecEdit && lsRecEdit.name === NEW_NAME && lsRecEdit.unit === NEW_UNIT && Number(lsPriceEdit) === NEW_PRICE,
    `localStorage parses=${lsAfterEdit.ok}; persisted rm record={name:${JSON.stringify(lsRecEdit && lsRecEdit.name)}, unit:${JSON.stringify(lsRecEdit && lsRecEdit.unit)}, min:${lsRecEdit && lsRecEdit.min}, price@${beforeEdit.Vdate}=${lsPriceEdit}}, prices=${JSON.stringify(lsRecEdit && lsRecEdit.prices)}; storage bytes ${beforeEdit.lsBytes} -> ${lsAfterEdit.bytes}`);

  // (b4) prove the unit-change guard really blocks the change when the user answers "no"
  const unitGuard = await cdp.eval(`(()=>{
    V.tab='items';draw();
    const b=[...document.querySelectorAll('#app button')].find(x=>(x.getAttribute('onclick')||'')==="editM('${TARGET}')");b.click();
    document.getElementById('eu').value='kg';
    const real=window.confirm;window.confirm=function(m){window.__confirms.push('[FORCED-FALSE] '+m);return false;};
    [...document.querySelectorAll('#app button')].find(x=>(x.getAttribute('onclick')||'')==='saveM()').click();
    window.confirm=real;
    const r=rmOf('${TARGET}');
    return {unit:r.unit,name:r.name,EM:EM,editorStillOpen:!!document.getElementById('em'),confirms:window.__confirms.slice(-3)};
  })()`);
  await cdp.eval(`EM=null;draw();`);
  record('b4. Answering "no" to the used-material unit-change confirm aborts saveM() (unit unchanged)',
    unitGuard.unit === NEW_UNIT && unitGuard.name === NEW_NAME && unitGuard.confirms.some((c) => /numbers will not be converted/.test(c)),
    `forced window.confirm=false; after Save attempt rmOf('${TARGET}') unit=${JSON.stringify(unitGuard.unit)} (must stay ${JSON.stringify(NEW_UNIT)}), name=${JSON.stringify(unitGuard.name)}, EM=${JSON.stringify(unitGuard.EM)}, editor stayed open=${unitGuard.editorStillOpen}; confirm text=${JSON.stringify(unitGuard.confirms)}`);

  /* ================================================================== *
   * (c) RELOAD
   * ================================================================== */
  section('(c) Reload: the material edit survives');

  const exBeforeReloadC = exceptions.length;
  await reloadPage();
  const afterReloadC = await q(`(()=>{const r=rmOf(${JSON.stringify(TARGET)});let ls=null;try{ls=JSON.parse(localStorage.getItem('nest2'));}catch(e){}
    const lr=ls?ls.rm.find(x=>x.id===${JSON.stringify(TARGET)}):null;
    return {exists:!!r,name:r&&r.name,unit:r&&r.unit,min:r&&r.min,priceNow:r?price(r.id,V.date):null,
      lsName:lr&&lr.name,lsUnit:lr&&lr.unit,
      Vdate:V.date,appLen:document.getElementById('app').innerHTML.length,
      exceptionsDuringReload:${exceptions.length} - ${exBeforeReloadC}};})()`);

  record('c1. After Page.reload the edited material still has the new name/unit/price',
    afterReloadC.exists && afterReloadC.name === NEW_NAME && afterReloadC.unit === NEW_UNIT
      && Number(afterReloadC.min) === NEW_MIN && Number(afterReloadC.priceNow) === NEW_PRICE
      && afterReloadC.lsName === NEW_NAME && afterReloadC.lsUnit === NEW_UNIT,
    `after reload S rebuilt from localStorage: rmOf('${TARGET}')={name:${JSON.stringify(afterReloadC.name)}, unit:${JSON.stringify(afterReloadC.unit)}, min:${afterReloadC.min}, priceNow@${afterReloadC.Vdate}=${afterReloadC.priceNow}}; localStorage record name=${JSON.stringify(afterReloadC.lsName)} unit=${JSON.stringify(afterReloadC.lsUnit)}; #app=${afterReloadC.appLen} chars; uncaught exceptions during reload=${exceptions.length - exBeforeReloadC}`);

  /* ================================================================== *
   * (d) MENU ITEM edit
   * ================================================================== */
  section('(d) Edit a menu item');

  await cdp.eval(`V.tab='items';draw();`);
  const menuTarget = A.menuIds[0]; // m0
  const menuBefore = await q(`(()=>{const m=S.menu.find(x=>x.id===${JSON.stringify(menuTarget)});return {id:m.id,name:m.name,price:m.price,rec:m.rec,recCount:m.rec.length,rc:recipe(m,V.date)};})()`);

  const recipeClick = await clickExact(`editR('${menuTarget}')`);
  const recipeEditor = await q(`(()=>{const el=document.getElementById('ed');return {
    present:!!el, title:el?el.querySelector('h3').textContent:'',
    inputIds:[...document.querySelectorAll('#ed input,#ed select')].map(x=>x.id),
    hasNameInput:[...document.querySelectorAll('#ed input,#ed select')].some(x=>/name/i.test(x.id)),
    hasPriceInput:[...document.querySelectorAll('#ed input,#ed select')].some(x=>/price/i.test(x.id)),
    anyMenuNamePriceEditor:[...document.querySelectorAll('#app input,#app select')].some(x=>/^(mn|mp)$/.test(x.id) && document.getElementById('ed') && document.getElementById('ed').contains(x)),
    saveBtn:!!document.querySelector('#ed button[onclick="saveR()"]'),
    ED:ED?{id:ED.id,prep:ED.prep,items:ED.items}:null};})()`);

  info(`menu-item editor #ed present=${recipeEditor.present}, <h3>=${JSON.stringify(recipeEditor.title)}, fields=[${recipeEditor.inputIds.join(', ')}]`);

  record('d1. Menu-item name / selling-price editing is NOT available (documented capability gap, not a defect)',
    recipeEditor.hasNameInput !== true && recipeEditor.hasPriceInput !== true,
    `No such control exists. Menu items render only a button onclick="editR('<id>')" labelled "Edit recipe"; clicking it opens #ed = ${JSON.stringify(recipeEditor.title)} whose fields are [${recipeEditor.inputIds.join(', ')}] -- only ingredient select/qty + effective date${recipeEditor.hasNameInput ? '' : ' (no name input)'}${recipeEditor.hasPriceInput ? '' : ' (no price input)'}. The only name/selling-price inputs in the Items tab are #mn/#mp inside the ADD MENU ITEM card. Editing S.menu[].name / S.menu[].price is therefore impossible through the UI.`);

  // (d2) the real per-menu-item Edit control we DO have: recipe version edit
  const NEW_Q = 210;
  const recipeFill = await cdp.eval(`(()=>{
    const q0=document.getElementById('eq0'); if(!q0) return {error:'no #eq0'};
    const sel=document.getElementById('er0');
    const before={rm:sel?sel.value:null,q:q0.value,ef:val('ef'),items:ED.items.length};
    q0.value=${JSON.stringify(String(NEW_Q))};
    return {before, after:{q:q0.value,ef:val('ef')}, itemCount:ED.items.length};
  })()`);
  const saveRClick = await clickExact('saveR()');
  await sleep(250);
  const menuAfter = await q(`(()=>{const m=S.menu.find(x=>x.id===${JSON.stringify(menuTarget)});const rc=recipe(m,V.date);return {
    saveRFound:${saveRClick.found},
    name:m.name,price:m.price,recCount:m.rec.length,recDates:m.rec.map(v=>v.from),
    currentRecipe:rc?{from:rc.from,items:rc.items}:null,ED:ED,editorPresent:!!document.getElementById('ed'),
    alerts:window.__alerts.slice()};})()`);
  const lsAfterMenu = JSON.parse(await cdp.eval(`JSON.stringify(${lsRM})`));
  const lsMenuRec = lsAfterMenu.ok ? lsAfterMenu.menu.find((m) => m.id === menuTarget) : null;

  record('d2. "Edit recipe" via the real Save-as-new-version button changed the menu item recipe in S.menu and localStorage',
    saveRClick.found === true && !!menuAfter.currentRecipe && Number(menuAfter.currentRecipe.items[0].q) === NEW_Q
      && menuAfter.recCount === menuBefore.recCount + 1 && menuAfter.ED === null && menuAfter.editorPresent === false
      && !!lsMenuRec && lsMenuRec.rec.some((v) => v.from === menuAfter.currentRecipe.from && Number(v.items[0].q) === NEW_Q),
    `clicked onclick="${saveRClick.want}" found=${saveRClick.found}; ingredient #0 q ${recipeFill.before && recipeFill.before.q} -> ${NEW_Q} (rm=${recipeFill.before && recipeFill.before.rm}); S.menu['${menuTarget}'].rec versions ${menuBefore.recCount} -> ${menuAfter.recCount} (dates=[${menuAfter.recDates.join(', ')}]); recipe@${afterReloadC.Vdate} items=${JSON.stringify(menuAfter.currentRecipe && menuAfter.currentRecipe.items)}; persisted in localStorage=${!!(lsMenuRec && lsMenuRec.rec.some((v) => Number(v.items[0].q) === NEW_Q))}`);

  const exBeforeReloadD = exceptions.length;
  await reloadPage();
  const afterReloadD = await q(`(()=>{const m=S.menu.find(x=>x.id===${JSON.stringify(menuTarget)});const rc=recipe(m,V.date);let ls=null;try{ls=JSON.parse(localStorage.getItem('nest2'));}catch(e){}
    const lm=ls?ls.menu.find(x=>x.id===${JSON.stringify(menuTarget)}):null;
    const lrc=lm?lm.rec.filter(v=>v.from<=V.date).sort((a,b)=>a.from<b.from?-1:1).pop():null;
    return {recCount:m.rec.length,name:m.name,price:m.price,currentQ:rc?rc.items[0].q:null,lsQ:lrc?lrc.items[0].q:null,appLen:document.getElementById('app').innerHTML.length,
      exceptionsDuringReload:${exceptions.length} - ${exBeforeReloadD}};})()`);

  record('d3. After Page.reload the menu item recipe edit survived (name/price unchanged as expected)',
    afterReloadD.recCount === menuBefore.recCount + 1 && Number(afterReloadD.currentQ) === NEW_Q && Number(afterReloadD.lsQ) === NEW_Q
      && afterReloadD.name === menuBefore.name && Number(afterReloadD.price) === Number(menuBefore.price),
    `after reload: S.menu['${menuTarget}'] name=${JSON.stringify(afterReloadD.name)} price=${afterReloadD.price}, rec versions=${afterReloadD.recCount}, recipe ingredient #0 q=${afterReloadD.currentQ}; localStorage recipe q=${afterReloadD.lsQ}; #app=${afterReloadD.appLen} chars; uncaught exceptions during reload=${exceptions.length - exBeforeReloadD}`);

  /* ================================================================== *
   * (e) DELETE an unused raw material through the real UI
   * ================================================================== */
  section('(e) Delete an unused raw material');

  const DEL_NAME = 'ZZ Verify Deletable ' + Date.now();
  await cdp.eval(`V.tab='items';draw();`);
  const addNew = await cdp.eval(`(()=>{document.getElementById('an').value=${JSON.stringify(DEL_NAME)};document.getElementById('au').value='kg';document.getElementById('ap').value='77';document.getElementById('am').value='3';return {an:val('an'),ap:val('ap')};})()`);
  const addNewClick = await clickExact('addRM()');
  await sleep(200);
  const createdRec = await q(`(()=>{const r=S.rm.find(x=>x.name===${JSON.stringify(DEL_NAME)});return {found:!!r,id:r&&r.id,rmLen:S.rm.length,prep:r&&!!r.prep,prices:r&&r.prices};})()`);
  info(`added via real Add form: ${JSON.stringify(createdRec)} (click found=${addNewClick.found}, typed=${JSON.stringify(addNew)})`);
  const newId = createdRec.id;

  const beforeDel = await q(`(()=>{
    const o=JSON.parse(localStorage.getItem('nest2'));
    const canon=arr=>arr.map(r=>r.id+'|'+r.name+'|'+r.unit+'|'+JSON.stringify(r.prices)).sort();
    return {ids:S.rm.map(r=>r.id),rmLen:S.rm.length,canon:canon(S.rm),lsIds:o.rm.map(r=>r.id),lsCanon:canon(o.rm),
      menuRefs:[...new Set(S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.map(i=>i.rm))))],
      invIds:[...new Set(S.inv.map(e=>e.rm))],wasteIds:[...new Set(S.waste.map(w=>w.rm))],
      usedM:(typeof usedM==='function')?usedM(${JSON.stringify(newId)}):null,
      alerts:window.__alerts.slice(),confirms:window.__confirms.slice()};})()`);

  const openNew = await clickExact(`editM('${newId}')`);
  const edNew = await q(`(()=>{const el=document.getElementById('em');return {present:!!el,title:el?el.querySelector('h3').textContent:'',en:val('en'),EM:EM};})()`);
  const delClick = await clickExact('delM()');
  await sleep(300);
  const afterDel = await q(`(()=>{
    const o=JSON.parse(localStorage.getItem('nest2'));
    const canon=arr=>arr.map(r=>r.id+'|'+r.name+'|'+r.unit+'|'+JSON.stringify(r.prices)).sort();
    return {ids:S.rm.map(r=>r.id),rmLen:S.rm.length,canon:canon(S.rm),lsIds:o.rm.map(r=>r.id),lsCanon:canon(o.rm),
      stillInS:!!S.rm.find(r=>r.id===${JSON.stringify(newId)}),
      stillInLs:!!o.rm.find(r=>r.id===${JSON.stringify(newId)}),
      invIds:[...new Set(S.inv.map(e=>e.rm))],wasteIds:[...new Set(S.waste.map(w=>w.rm))],
      EM:EM,editorPresent:!!document.getElementById('em'),
      menuRefs:[...new Set(S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.map(i=>i.rm))))],
      alerts:window.__alerts.slice(),confirms:window.__confirms.slice(),
      orphans:S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.filter(i=>!rmOf(i.rm)).map(i=>({menu:m.name,rm:i.rm}))))};})()`);

  const removed = beforeDel.ids.filter((x) => !afterDel.ids.includes(x));
  const added = afterDel.ids.filter((x) => !beforeDel.ids.includes(x));
  const lsRemoved = beforeDel.lsIds.filter((x) => !afterDel.lsIds.includes(x));
  const othersSame = JSON.stringify(beforeDel.canon.filter((c) => !c.startsWith(newId + '|'))) === JSON.stringify(afterDel.canon.filter((c) => !c.startsWith(newId + '|')));

  record('e1. The new material was created through the real Add form (setup for the delete test)',
    createdRec.found === true && createdRec.rmLen === 9 && createdRec.prep === false,
    `Add onclick="addRM()" found=${addNewClick.found}; typed #an=${JSON.stringify(addNew.an)} #ap=${addNew.ap}; created id=${JSON.stringify(newId)}, S.rm.length 8 -> ${createdRec.rmLen}; stored prices=${JSON.stringify(createdRec.prices)}`);

  record('e2. Clicking the row Edit button then Delete removed exactly that one material from S.rm and localStorage',
    openNew.found === true && delClick.found === true && beforeDel.usedM === false
      && afterDel.stillInS === false && afterDel.stillInLs === false && afterDel.rmLen === 8
      && removed.length === 1 && removed[0] === newId && added.length === 0 && lsRemoved.length === 1 && lsRemoved[0] === newId,
    `editor for ${newId}: found=${openNew.found}, <h3>=${JSON.stringify(edNew.title)}, #em present=${edNew.present}; Delete onclick="delM()" found=${delClick.found}; usedM(${newId})=${beforeDel.usedM}; S.rm ${beforeDel.rmLen} -> ${afterDel.rmLen}; removed from S.rm=[${removed.join(', ')}], added=[${added.join(', ')}]; removed from localStorage=[${lsRemoved.join(', ')}]; confirm() text seen=${JSON.stringify(afterDel.confirms.slice(beforeDel.confirms.length))}`);

  const invSame = JSON.stringify([...afterDel.invIds].sort()) === JSON.stringify([...beforeDel.invIds].sort());
  const wasteSame = JSON.stringify([...afterDel.wasteIds].sort()) === JSON.stringify([...beforeDel.wasteIds].sort());
  const refsSame = [...afterDel.menuRefs].sort().join(',') === [...beforeDel.menuRefs].sort().join(',');

  record('e3. The delete had no collateral effect on other materials (or on stock/wastage/recipe references)',
    othersSame === true && refsSame === true && invSame === true && wasteSame === true && afterDel.orphans.length === 0,
    `id+name+unit+prices fingerprint of all other ${afterDel.rmLen} materials unchanged=${othersSame}; menu recipe refs unchanged=${refsSame} ([${beforeDel.menuRefs.join(', ')}]); stock(inv) rm refs unchanged=${invSame} (${beforeDel.invIds.length} materials with stock); waste rm refs unchanged=${wasteSame} (${beforeDel.wasteIds.length} materials with wastage); removed ids=[${removed.join(', ')}]; orphans after delete=${JSON.stringify(afterDel.orphans)}`);

  const exBeforeReloadE = exceptions.length;
  await reloadPage();
  const afterReloadE = await q(`(()=>{const r=S.rm.find(x=>x.id===${JSON.stringify(newId)});let ls=null;try{ls=JSON.parse(localStorage.getItem('nest2'));}catch(e){}
    return {stillInS:!!r,stillInLs:!!(ls&&ls.rm.find(x=>x.id===${JSON.stringify(newId)})),rmLen:S.rm.length,appLen:document.getElementById('app').innerHTML.length,
      exceptionsDuringReload:${exceptions.length} - ${exBeforeReloadE}};})()`);

  record('e4. The deletion survived Page.reload',
    afterReloadE.stillInS === false && afterReloadE.stillInLs === false && afterReloadE.rmLen === 8 && afterReloadE.appLen > 200,
    `after reload: ${newId} in S.rm=${afterReloadE.stillInS}, in localStorage=${afterReloadE.stillInLs}; S.rm.length=${afterReloadE.rmLen}; #app=${afterReloadE.appLen} chars; uncaught exceptions during reload=${exceptions.length - exBeforeReloadE}`);

  /* ================================================================== *
   * (f) DELETE interaction with usage -- the highest-risk case
   * ================================================================== */
  section('(f) Delete vs. usage (usedM)');

  const usedId = USE.recipeUsed[0]; // e.g. r0 -- referenced by menu recipes
  const usedProbe = await q(`(()=>{const id=${JSON.stringify(usedId)};return {
    id, usedM:usedM(id),
    menuRecipe:S.menu.some(m=>m.rec.some(v=>v.items.some(i=>i.rm==id))),
    prepRecipe:S.rm.some(p=>p.prep&&p.rec.some(v=>v.items.some(i=>i.rm==id))),
    stock:S.inv.some(e=>e.rm==id),waste:S.waste.some(w=>w.rm==id),
    name:rmOf(id).name,price:price(id,V.date)};})()`);

  await cdp.eval(`V.tab='items';draw();`);
  const openUsed = await clickExact(`editM('${usedId}')`);
  const confirmBase = await q(`({alerts:window.__alerts.length,confirms:window.__confirms.length})`);
  const delUsedClick = await clickExact('delM()');
  await sleep(300);
  const afterUsedDel = await q(`(()=>{const o=JSON.parse(localStorage.getItem('nest2'));return {
    stillInS:!!S.rm.find(r=>r.id===${JSON.stringify(usedId)}),
    stillInLs:!!o.rm.find(r=>r.id===${JSON.stringify(usedId)}),
    rmLen:S.rm.length,EM:EM,
    alerts:window.__alerts.slice(${confirmBase.alerts}),confirms:window.__confirms.slice(${confirmBase.confirms}),
    orphans:S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.filter(i=>!rmOf(i.rm)).map(i=>({menu:m.name,rm:i.rm})))),
    allRecipeRefsResolvable:S.menu.every(m=>m.rec.every(v=>v.items.every(i=>!!rmOf(i.rm))))};})()`);

  record('f1. Deleting a recipe-used material does not orphan a menu recipe',
    afterUsedDel.orphans.length === 0 && afterUsedDel.allRecipeRefsResolvable === true && afterUsedDel.stillInS === true,
    `material ${usedId} (${JSON.stringify(usedProbe.name)}) is used: menuRecipe=${usedProbe.menuRecipe}, prepRecipe=${usedProbe.prepRecipe}, stock=${usedProbe.stock}, waste=${usedProbe.waste} -> usedM(${usedId})=${usedProbe.usedM}. Clicked Edit found=${openUsed.found}, then Delete found=${delUsedClick.found}. RESULT: record still in S.rm=${afterUsedDel.stillInS}, still in localStorage=${afterUsedDel.stillInLs}; S.rm.length unchanged=${afterUsedDel.rmLen}; alert() text=${JSON.stringify(afterUsedDel.alerts)}; confirm() text=${JSON.stringify(afterUsedDel.confirms)}; dangling recipe refs=${JSON.stringify(afterUsedDel.orphans)}`);

  const added2 = await cdp.eval(`(()=>{document.getElementById('an').value='ZZ Verify GuardStock';document.getElementById('au').value='kg';document.getElementById('ap').value='9';return true;})()`);
  const add2 = await clickExact('addRM()');
  await sleep(200);
  const gid = (await q(`(()=>{const r=S.rm.find(x=>x.name==='ZZ Verify GuardStock');return {id:r&&r.id,rmLen:S.rm.length};})()`)).id;
  // give it a wastage record (not a recipe), then try to delete it
  await cdp.eval(`V.tab='stock';draw();`);
  const wasteAdd = await cdp.eval(`(()=>{document.getElementById('wr').value=${JSON.stringify(gid)};document.getElementById('wq').value='1';return {wr:val('wr'),wq:val('wq')};})()`);
  const wasteClick = await clickSub('saveWaste(');
  await sleep(200);
  const guard1 = await q(`(()=>{const id=${JSON.stringify(gid)};return {usedM:usedM(id),wasteEntry:S.waste.some(w=>w.rm==id),inS:!!S.rm.find(r=>r.id==id),
    stock:S.inv.some(e=>e.rm==id),menuRecipe:S.menu.some(m=>m.rec.some(v=>v.items.some(i=>i.rm==id))),alerts:window.__alerts.slice()};})()`);
  await cdp.eval(`V.tab='items';draw();`);
  const guardBase = await q(`({alerts:window.__alerts.length,confirms:window.__confirms.length})`);
  await clickExact(`editM('${gid}')`);
  const guardDelClick = await clickExact('delM()');
  await sleep(250);
  const guard2 = await q(`(()=>{return {stillInS:!!S.rm.find(r=>r.id===${JSON.stringify(gid)}),rmLen:S.rm.length,
    alerts:window.__alerts.slice(${guardBase.alerts}),confirms:window.__confirms.slice(${guardBase.confirms})};})()`);

  record('f2. A material used ONLY by a wastage/stock record is also protected from deletion (usedM guards more than recipes)',
    guard1.usedM === true && guard1.wasteEntry === true && guard2.stillInS === true,
    `material ${gid} ("ZZ Verify GuardStock"): addRM clicked=${add2.found}; saveWaste onclick="${wasteClick.onclick}" found=${wasteClick.found} (typed ${JSON.stringify(wasteAdd)}); then usedM=${guard1.usedM} with waste entry=${guard1.wasteEntry}, stock entry=${guard1.stock}, menu-recipe usage=${guard1.menuRecipe}; Delete found=${guardDelClick.found} -> still in S.rm=${guard2.stillInS} (S.rm.length=${guard2.rmLen}); alert()=${JSON.stringify(guard2.alerts)}; confirm()=${JSON.stringify(guard2.confirms)} (no confirm => nothing was deleted)`);

  await cdp.eval(`V.tab='items';draw();`);
  const orphanProbe = await q(`(()=>({orphans:S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.filter(i=>!rmOf(i.rm)).map(i=>({menu:m.name,rm:i.rm})))),total:S.menu.reduce((n,m)=>n+m.rec.reduce((k,v)=>k+v.items.length,0),0)}))()`);
  record('f3. Integrity invariant: every ingredient id in every menu recipe resolves to an existing material',
    orphanProbe.orphans.length === 0,
    `${orphanProbe.total} ingredient references across ${A.sMenu} menu items; dangling references=${JSON.stringify(orphanProbe.orphans)}`);

  /* ================================================================== *
   * (g) no uncaught exceptions during the whole main flow
   * ================================================================== */
  section('(g) Uncaught exceptions / console errors');
  const mainAppEx = appExceptions(exceptions);
  const cdnEx = exceptions.filter((e) => appExceptions([e]).length === 0);
  record('g1. No uncaught JS exceptions during the whole edit/delete flow',
    mainAppEx.length === 0,
    mainAppEx.length === 0
      ? `0 uncaught exceptions (captured ${exceptions.length} total, ${cdnEx.length} attributable to the SheetJS CDN); console errors=${consoleMsgs.filter((m) => m.type === 'error').length}`
      : `${mainAppEx.length}: ${fmtEx(mainAppEx)}`);
  const consoleErrors = consoleMsgs.filter((m) => m.type === 'error');
  record('g2. No console.error() output during the flow', consoleErrors.length === 0,
    consoleErrors.length === 0 ? `0 console.error calls (${consoleMsgs.length} console messages total)` : consoleErrors.map((m) => `${m.text} @ ${m.url}:${(m.line ?? -1) + 1}`).join(' | '));

  /* ================================================================== *
   * (h) screenshot
   * ================================================================== */
  section('(h) Screenshot');
  const shotPath = path.join(ROOT, SHOT_NAME);
  const shotExists = fs.existsSync(shotPath);
  const shotSize = shotExists ? fs.statSync(shotPath).size : 0;
  record('h1. Screenshot of the open material editor saved as ' + SHOT_NAME + ' (>5000 bytes)',
    shotExists && shotSize > 5000, `${SHOT_NAME} exists=${shotExists}, ${shotSize} bytes, path=${shotPath}`);

  /* ------------------------------------------------------------------ *
   * freeze the main transcript before the adversarial section
   * ------------------------------------------------------------------ */
  const mainExceptions = [...exceptions];
  const mainTranscript = { consoleMsgs: [...consoleMsgs], exceptions: [...exceptions], logEntries: [...logEntries], dialogs: [...dialogs] };
  exceptions.length = 0; consoleMsgs.length = 0; logEntries.length = 0; dialogs.length = 0;
  const pageAlerts = await cdp.eval('JSON.stringify(window.__alerts || [])').catch(() => '[]');
  const pageConfirms = await cdp.eval('JSON.stringify(window.__confirms || [])').catch(() => '[]');

  /* ================================================================== *
   * (X) ADVERSARIAL: does ANY delete path orphan a menu recipe?
   *     "Clear demo data" removes demo materials/menus but keeps non-demo
   *     menu items -- including non-demo recipes that reference demo materials.
   * ================================================================== */
  section('(X) ADVERSARIAL: orphan a recipe via Settings > "Clear demo data"');

  await cdp.eval(`V.tab='items';draw();`);
  const ORPHAN_MENU = 'ZZ Orphan Dish';
  await cdp.eval(`(()=>{document.getElementById('mn').value=${JSON.stringify(ORPHAN_MENU)};document.getElementById('mp').value='199';return true;})()`);
  const orphanAddClick = await clickExact('addM()');
  await sleep(200);
  const orphanMid = (await q(`(()=>{const m=S.menu.find(x=>x.name===${JSON.stringify(ORPHAN_MENU)});return {id:m&&m.id,menuLen:S.menu.length};})()`)).id;
  const demoMaterialId = 'r3'; // "Sauce" -- a demo material referenced by demo recipes
  const orphanEditClick = await clickExact(`editR('${orphanMid}')`);
  const plusIngClick = await clickSub('syncE();ED.items.push(');
  const orphanFill = await cdp.eval(`(()=>{const sel=document.getElementById('er0');const q0=document.getElementById('eq0');if(!sel||!q0)return {error:'no ingredient row'};sel.value=${JSON.stringify(demoMaterialId)};q0.value='50';return {rm:sel.value,q:q0.value,ef:val('ef'),items:ED.items.length};})()`);
  const orphanSaveClick = await clickExact('saveR()');
  await sleep(250);
  const orphanSaved = await q(`(()=>{const m=S.menu.find(x=>x.id===${JSON.stringify(orphanMid)});const rc=m?recipe(m,V.date):null;return {menuName:m&&m.name,recCount:m?m.rec.length:null,current:rc?rc.items:null,demo:!!(m&&m.demo)};})()`);

  record('X1. A non-demo menu item ("' + ORPHAN_MENU + '") was created with a real recipe pointing at a demo material ' + demoMaterialId,
    orphanAddClick.found === true && orphanEditClick.found === true && plusIngClick.found === true && orphanSaveClick.found === true
      && !!orphanSaved.current && orphanSaved.current[0].rm === demoMaterialId && Number(orphanSaved.current[0].q) === 50 && orphanSaved.demo === false,
    `addM found=${orphanAddClick.found} (id=${orphanMid}); editR found=${orphanEditClick.found}; "+ Ingredient" found=${plusIngClick.found}; filled=${JSON.stringify(orphanFill)}; saveR found=${orphanSaveClick.found}; S.menu["${ORPHAN_MENU}"].demo=${orphanSaved.demo}, recipe@${afterReloadC.Vdate}=${JSON.stringify(orphanSaved.current)}`);

  // now the real app UI path: Settings > Clear demo data (this DELETES demo materials)
  await cdp.eval(`V.tab='set';draw();`);
  const clearClick = await clickSub('Remove all demo data');
  await sleep(400);
  const afterClear = await q(`(()=>{
    const missing=S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.filter(i=>!S.rm.find(r=>r.id==i.rm)).map(i=>({menu:m.name,rm:i.rm,q:i.q}))));
    const o=JSON.parse(localStorage.getItem('nest2'));
    const lsMissing=o.menu.flatMap(m=>m.rec.flatMap(v=>v.items.filter(i=>!o.rm.find(r=>r.id==i.rm)).map(i=>({menu:m.name,rm:i.rm}))));
    return {rmIds:S.rm.map(r=>r.id),menuNames:S.menu.map(m=>m.name),missing,lsMissing,
      orphanKept:!!S.menu.find(m=>m.name===${JSON.stringify(ORPHAN_MENU)}),
      demoLeft:S.rm.filter(r=>r.demo).length+S.menu.filter(m=>m.demo).length,
      confirms:window.__confirms.slice(-3)};})()`);

  record('X2. "Clear demo data" leaves a non-demo recipe pointing at a deleted demo material [DATA-INTEGRITY BUG if FAIL]',
    afterClear.missing.length === 0,
    `Settings button onclick="${clearClick.onclick}" found=${clearClick.found}; confirm accepted (text=${JSON.stringify(afterClear.confirms)}); after clear: S.rm ids=[${afterClear.rmIds.join(', ')}], S.menu=[${afterClear.menuNames.join(', ')}], demo records left=${afterClear.demoLeft}; DANGLING recipe refs in S=${JSON.stringify(afterClear.missing)}; same dangling refs persisted in localStorage=${JSON.stringify(afterClear.lsMissing)}`);

  // the app must now be degraded: which tabs still render?
  const exBeforeX3 = exceptions.length;
  const tabScope = [];
  for (const id of ['dash', 'sales', 'stock', 'items', 'set']) {
    const r = await evalSafe(`(()=>{V.tab='${id}';draw();return document.getElementById('app').innerHTML.length;})()`);
    tabScope.push(`${id}:${r.ok ? 'ok(' + r.value + ')' : 'THROWS'}`);
  }
  const directItemsError = await evalSafe(`(()=>{V.tab='items';draw();return document.getElementById('app').innerHTML.length;})()`);

  // now the REAL user path: click the Items nav button
  await evalSafe(`(()=>{V.tab='dash';draw();return true;})()`);
  const navBefore = await q(`(()=>({tab:V.tab,appLen:document.getElementById('app').innerHTML.length,text:document.getElementById('app').textContent.trim().slice(0,400)}))()`);
  exceptions.length = 0;
  const navClick = await evalSafe(`(()=>{const b=document.getElementById('nav').querySelectorAll('button')[3];const label=b.textContent;b.click();return label;})()`);
  await sleep(250);
  const navAfter = await q(`(()=>({tab:V.tab,appLen:document.getElementById('app').innerHTML.length,navActive:[...document.querySelectorAll('#nav button.on')].map(b=>b.textContent),text:document.getElementById('app').textContent.trim().slice(0,400)}))()`);
  const realUncaught = exceptions.slice();

  record('X3. After the orphan exists the Items tab no longer renders and the real Items nav click raises an uncaught TypeError [APP TAB FATALLY BROKEN if FAIL]',
    directItemsError.ok === true && navAfter.text.indexOf('Raw materials') >= 0 && realUncaught.length === 0,
    `direct draw() per tab -> [${tabScope.join(', ')}]; direct V.tab='items';draw() -> ok=${directItemsError.ok}${directItemsError.ok ? ` appLen=${directItemsError.value}` : ` error=${directItemsError.error}`}; before nav click: active tab=${navBefore.tab}, #app=${navBefore.appLen} chars ("${navBefore.text}"); clicked nav button[3] "${navClick.value}" -> V.tab now=${navAfter.tab}, #app still ${navAfter.appLen} chars ("${navAfter.text}"), nav .on=[${navAfter.navActive.join(',')}]; UNCAUGHT exceptions from the real click=${realUncaught.length}${realUncaught.length ? ' :: ' + fmtEx(realUncaught) : ' (the inline onclick swallowed it silently)'}`);

  // and it survives a reload, because the corruption is in localStorage
  const exBeforeX4 = exceptions.length;
  const reloadStateX = await reloadPage();
  const afterX4 = await q(`(()=>{
    const o=JSON.parse(localStorage.getItem('nest2'));
    const lsOrphans=o.menu.flatMap(m=>m.rec.flatMap(v=>v.items.filter(i=>!o.rm.find(r=>r.id==i.rm)).map(i=>({menu:m.name,rm:i.rm}))));
    return {appLen:document.getElementById('app').innerHTML.length,navLen:document.getElementById('nav').innerHTML.length,navButtons:document.getElementById('nav').querySelectorAll('button').length,title:document.title,Srm:typeof S==='object'&&S?S.rm.length:null,menuNames:typeof S==='object'&&S?S.menu.map(m=>m.name):null,lsOrphans,activeTab:V.tab};})()`);
  const itemsAfterReload = await evalSafe(`(()=>{V.tab='items';draw();return document.getElementById('app').innerHTML.length;})()`);
  const x4Exceptions = exceptions.slice(exBeforeX4);

  record('X4. The corruption is persisted, survives a page reload and still breaks the Items tab [DATA-INTEGRITY BUG if FAIL]',
    afterX4.lsOrphans.length === 0 && itemsAfterReload.ok === true,
    `reload load event=${reloadStateX}; boot tab=${afterX4.activeTab}, #app=${afterX4.appLen} chars, #nav=${afterX4.navLen} chars / ${afterX4.navButtons} buttons, title=${JSON.stringify(afterX4.title)}; S.rm.length=${afterX4.Srm}, S.menu=[${(afterX4.menuNames || []).join(', ')}]; dangling refs still in localStorage after reload=${JSON.stringify(afterX4.lsOrphans)}; Items tab after reload -> ok=${itemsAfterReload.ok}${itemsAfterReload.ok ? ` appLen=${itemsAfterReload.value}` : ` error=${itemsAfterReload.error}`}; uncaught exceptions around reload=${x4Exceptions.length}${x4Exceptions.length ? ' :: ' + fmtEx(x4Exceptions) : ''}`);

  /* ------ restore a clean app ------ */
  await cdp.eval(`localStorage.clear()`);
  exceptions.length = 0;
  await reloadPage();
  const restored = await q(`(()=>({appLen:document.getElementById('app').innerHTML.length,rm:S.rm.length,menu:S.menu.length,navButtons:document.getElementById('nav').querySelectorAll('button').length}))()`);
  record('X5. Clearing localStorage and reloading restores the demo app (recovery requires manual localStorage clearing)',
    restored.appLen > 200 && restored.rm === 8 && restored.menu === 5 && restored.navButtons === 5,
    `after localStorage.clear() + reload: #app=${restored.appLen} chars, S.rm.length=${restored.rm}, S.menu.length=${restored.menu}, nav buttons=${restored.navButtons}, uncaught exceptions=${exceptions.length}`);

  /* ================================================================== *
   * (Y) ADVERSARIAL 2: the fully realistic lockout variant.
   *     X5 left a freshly seeded demo app. Now: create a REAL material,
   *     record a REAL stock count for TODAY via the Stock tab, create a REAL
   *     menu item whose recipe uses a demo ingredient, then follow the app's
   *     own advice ("Clear it in Settings when you start real entries").
   * ================================================================== */
  section('(Y) ADVERSARIAL 2: real stock entry + real menu recipe + Clear demo data -> can the app still boot?');

  const todayISO = await cdp.eval(`(()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})()`);

  await cdp.eval(`V.tab='items';draw();`);
  await cdp.eval(`(()=>{document.getElementById('an').value='ZZ Real Material';document.getElementById('au').value='kg';document.getElementById('ap').value='5';return true;})()`);
  const yAddRM = await clickExact('addRM()');
  await sleep(150);
  const yRealMat = await q(`(()=>{const r=S.rm.find(x=>x.name==='ZZ Real Material');return {id:r&&r.id,demo:r&&!!r.demo};})()`);

  const yDate = await evalSafe(`(()=>{V.tab='stock';draw();const d=document.querySelector('#app input[type=date]');if(!d)return 'no date input';const before=V.date;d.value=${JSON.stringify(todayISO)};d.dispatchEvent(new Event('change',{bubbles:true}));return before+' -> '+V.date;})()`);
  const yFill = await evalSafe(`(()=>{const id=${JSON.stringify(yRealMat.id)};
    // the app prefills "Opening" from the previous day for every material, and saveStock
    // then demands a closing count for each of them; blank the other materials out so the
    // count only covers the material we care about (they are demo rows anyway).
    const blanked=[];S.rm.filter(r=>!r.prep&&r.id!=id).forEach(r=>{const el=document.getElementById('o_'+r.id);if(el&&el.value!==''){el.value='';blanked.push(r.id)}});
    const set=(k,v)=>{const el=document.getElementById(k+'_'+id);if(!el)return false;el.value=v;return true};
    return {o:set('o','5'),p:set('p','2'),c:set('c','4'),blanked};})()`);
  const yStockClick = await clickExact(`saveStock('Areekode')`);
  await sleep(250);
  const yStockState = await q(`(()=>{const id=${JSON.stringify(yRealMat.id)};const c=calc(V.date,['Areekode']);return {invEntry:S.inv.find(e=>e.rm==id&&e.d===V.date)||null,invHasDemo:S.inv.some(e=>e.d===V.date&&e.demo),Vdate:V.date,dashRows:c.rows.length,dashSales:c.sales,a:window.__alerts.slice(-2)};})()`);

  await cdp.eval(`V.tab='items';draw();`);
  await cdp.eval(`(()=>{document.getElementById('mn').value='ZZ Real Dish';document.getElementById('mp').value='149';return true;})()`);
  const yAddM = await clickExact('addM()');
  await sleep(150);
  const yRealMid = (await q(`(()=>{const m=S.menu.find(x=>x.name==='ZZ Real Dish');return {id:m&&m.id,demo:m&&!!m.demo};})()`)).id;
  const yEditR = await clickExact(`editR('${yRealMid}')`);
  const yPlus = await clickSub('syncE();ED.items.push(');
  await cdp.eval(`(()=>{document.getElementById('er0').value='r3';document.getElementById('eq0').value='50';return true;})()`);
  const ySaveR = await clickExact('saveR()');
  await sleep(200);
  const yRecipe = await q(`(()=>{const m=S.menu.find(x=>x.id===${JSON.stringify(yRealMid)});const rc=recipe(m,V.date);return {current:rc?rc.items:null,demo:!!m.demo};})()`);
  const yPreDash = await evalSafe(`(()=>{V.tab='dash';draw();return document.getElementById('app').innerHTML.length;})()`);

  record('Y1. Real-UI setup: non-demo material + non-demo stock count for today + non-demo menu item whose recipe uses demo ingredient r3',
    yAddRM.found && yRealMat.id && yRealMat.demo === false && yDate.ok === true && yStockClick.found === true
      && !!yStockState.invEntry && yStockState.invEntry.demo === undefined && yStockState.invHasDemo === false
      && yAddM.found && yEditR.found && yPlus.found && ySaveR.found && !!yRecipe.current && yRecipe.current[0].rm === 'r3',
    `addRM found=${yAddRM.found} -> real material ${yRealMat.id} (demo=${yRealMat.demo}); top-bar date changed via the real date input: ${JSON.stringify(yDate.value)} (date fields set=${JSON.stringify(yFill.value)}); saveStock("Areekode") found=${yStockClick.found} -> S.inv entry for today=${JSON.stringify(yStockState.invEntry)} (any demo inv left today=${yStockState.invHasDemo}); addM found=${yAddM.found} -> real menu item ${yRealMid} (demo=${yRecipe.demo}); editR found=${yEditR.found}, +Ingredient found=${yPlus.found}, saveR found=${ySaveR.found} -> recipe=${JSON.stringify(yRecipe.current)}; alert()=${JSON.stringify(yStockState.a)}`);

  record('Y2. Before clearing, the dashboard renders fine with this data',
    yPreDash.ok === true && yPreDash.value > 200,
    `V.date=${yStockState.Vdate}: calc() rows=${yStockState.dashRows} (so dash() does NOT take the "No sales or stock" early return), sales=${yStockState.dashSales}; dash draw() -> ok=${yPreDash.ok} appLen=${yPreDash.value}`);

  await cdp.eval(`V.tab='set';draw();`);
  const yClear = await clickSub('Remove all demo data');
  await sleep(400);
  const yPostClear = await q(`(()=>({miss:S.menu.flatMap(m=>m.rec.flatMap(v=>v.items.filter(i=>!rmOf(i.rm)).map(i=>({menu:m.name,rm:i.rm})))),rmIds:S.rm.map(r=>r.id),menuNames:S.menu.map(m=>m.name),invLeft:S.inv.length}))()`);
  const yDashAfter = await evalSafe(`(()=>{V.tab='dash';draw();return document.getElementById('app').innerHTML.length;})()`);

  record('Y3. After "Clear demo data" the DASHBOARD (default landing tab) still renders [TOTAL LOCKOUT if FAIL]',
    yDashAfter.ok === true,
    `Clear-demo onclick found=${yClear.found}; after clear: S.rm ids=[${yPostClear.rmIds.join(', ')}] (all demo materials deleted), S.menu=[${yPostClear.menuNames.join(', ')}], remaining inv rows=${yPostClear.invLeft}, dangling refs=${JSON.stringify(yPostClear.miss)}; dash draw() -> ok=${yDashAfter.ok}${yDashAfter.ok ? ` appLen=${yDashAfter.value}` : ` error=${yDashAfter.error}`}`);

  const exBeforeY4 = exceptions.length;
  const yReload = await reloadPage();
  const yBoot = await q(`(()=>({appLen:document.getElementById('app').innerHTML.length,navLen:document.getElementById('nav').innerHTML.length,navButtons:document.getElementById('nav').querySelectorAll('button').length,title:document.title,Srm:typeof S==='object'&&S?S.rm.length:null,Vdate:typeof V==='object'?V.date:null}))()`);
  const yBootEx = exceptions.slice(exBeforeY4);

  record('Y4. The app still boots into a usable UI after the reload [BLANK-SCREEN DATA LOCKOUT if FAIL]',
    yBoot.appLen > 200 && yBoot.navButtons === 5,
    `reload load event=${yReload}; on boot: #app=${yBoot.appLen} chars, #nav=${yBoot.navLen} chars, nav buttons=${yBoot.navButtons}, title=${JSON.stringify(yBoot.title)}, S.rm.length=${yBoot.Srm}, V.date=${yBoot.Vdate}; UNCAUGHT exception during boot draw()=${yBootEx.length}${yBootEx.length ? ' :: ' + fmtEx(yBootEx) : ''}`);

  await cdp.eval(`localStorage.clear()`);
  exceptions.length = 0;
  await reloadPage();
  const yRestored = await q(`(()=>({appLen:document.getElementById('app').innerHTML.length,rm:S.rm.length,menu:S.menu.length,navButtons:document.getElementById('nav').querySelectorAll('button').length}))()`);
  record('Y5. Clearing localStorage by hand restores the app (no in-app recovery path exists once #nav is gone)',
    yRestored.appLen > 200 && yRestored.rm === 8 && yRestored.menu === 5 && yRestored.navButtons === 5,
    `after localStorage.clear() + reload: #app=${yRestored.appLen} chars, S.rm.length=${yRestored.rm}, S.menu.length=${yRestored.menu}, nav buttons=${yRestored.navButtons}, uncaught exceptions=${exceptions.length}`);

  /* ------------------------- transcripts ------------------------- */
  console.log('\n================ CONSOLE & PAGE-ERROR TRANSCRIPT (main edit/delete flow) ================');
  const interestingConsole = mainTranscript.consoleMsgs.filter((m) => m.type !== 'debug');
  if (!interestingConsole.length) console.log('(no console messages captured)');
  for (const m of interestingConsole) console.log(`  [console.${m.type}] ${m.text}${m.url ? `  @ ${m.url}:${(m.line ?? -1) + 1}` : ''}`);
  if (mainTranscript.exceptions.length) {
    console.log('  --- uncaught exceptions (main flow) ---');
    for (const e of mainTranscript.exceptions) console.log(`  [exception] ${e.text} :: ${(e.desc || '').split('\n')[0]} @ ${e.url}:${(e.line ?? -1) + 1}`);
  }
  const netish = mainTranscript.logEntries.filter((e) => /net::ERR_|Failed to load resource/i.test(e.text || ''));
  if (netish.length) { console.log('  --- network/resource failures ---'); for (const e of netish) console.log(`  [net] ${e.text} ${e.url || ''}`); }
  console.log(`  --- alert() calls seen in page: ${pageAlerts}`);
  console.log(`  --- confirm() calls seen in page: ${pageConfirms}`);
  console.log(`  --- CDP dialogs auto-accepted: ${JSON.stringify(mainTranscript.dialogs)}`);
  console.log(`  --- static server requests: ${JSON.stringify(requestLog)}`);
  console.log('=========================================================================================\n');

  /* ------------------------- summary ------------------------- */
  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} assertions PASSED`);
  console.log('\nRESULT TABLE');
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  if (failed.length) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}\n      ${f.detail}`);
  }
  if (chromeStderr && /error|Error/.test(chromeStderr) && process.env.VERBOSE) {
    console.log('--- chrome stderr ---\n' + chromeStderr.slice(-3000));
  }
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (e) {
  console.error('HARNESS ERROR (not necessarily an app bug):', (e && e.stack) || e);
  exitCode = 2;
} finally {
  await cleanup();
}
console.log(`\nEXIT ${exitCode}${exitCode === 2 ? ' (harness error)' : ''}`);
process.exit(exitCode);
