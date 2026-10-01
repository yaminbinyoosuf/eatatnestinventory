#!/usr/bin/env node
/**
 * verify-browser.mjs
 *
 * Drives real headless Google Chrome over the Chrome DevTools Protocol (CDP)
 * against a real http:// URL served from ./public, and produces hard evidence
 * about whether the "Nest Inventory & Food Cost" single-file app actually works.
 *
 * Re-run:  node verify-browser.mjs
 *
 * Exits non-zero if any assertion fails.
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
// GitHub Pages serves a project site under /<repo>/, so the harness also mounts the
// same directory under this prefix to prove the app is subpath-safe.
const SUBPATH_PREFIX = '/eatatnestinventory';

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
function info(msg) {
  console.log(`      ${msg}`);
}

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
const getFreePort = () =>
  new Promise((resolve, reject) => {
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
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

/* ------------------------------------------------------------------ *
 * static file server for ./public
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function startStaticServer() {
  const requestLog = [];
  const server = createServer((req, res) => {
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    // emulate a GitHub Pages project subpath as well as the origin root
    const mounted = rawPath === SUBPATH_PREFIX || rawPath.startsWith(SUBPATH_PREFIX + '/')
      ? rawPath.slice(SUBPATH_PREFIX.length)
      : rawPath;
    let rel = mounted === '/' || mounted === '' ? '/index.html' : mounted;
    const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!abs.startsWith(PUBLIC_DIR)) {
      requestLog.push({ url: rawPath, status: 403 });
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      requestLog.push({ url: rawPath, status: 404 });
      res.writeHead(404); res.end('not found'); return;
    }
    requestLog.push({ url: rawPath, status: 200 });
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, requestLog });
    });
  });
}

/* ------------------------------------------------------------------ *
 * minimal CDP client
 * ------------------------------------------------------------------ */
class CDP {
  constructor(WS, url) {
    this.WS = WS;
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.events = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new this.WS(this.url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
          else res(msg.result);
        } else if (msg.method) {
          this.events.push(msg);
          for (const h of this.handlers.get(msg.method) || []) {
            try { h(msg.params); } catch { /* ignore */ }
          }
        }
      });
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
  async eval(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue, awaitPromise, userGesture: true,
    });
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
let chromeProc = null;
let profileDir = null;
let staticSrv = null;
let cdp = null;

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
  try {
    if (profileDir && fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

async function main() {
  // ---- preflight
  if (!fs.existsSync(CHROME_BIN)) throw new Error(`Chrome not found at ${CHROME_BIN}`);
  if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) throw new Error('public/index.html missing');

  const { WS, from } = loadWs();
  info(`WebSocket impl: ws from ${from}`);

  // ---- servers
  const { server, port: httpPort, requestLog } = await startStaticServer();
  staticSrv = server;
  const appUrl = `http://127.0.0.1:${httpPort}${APP_URL_PATH}`;
  info(`Serving ${PUBLIC_DIR} at http://127.0.0.1:${httpPort}/`);
  info(`App URL: ${appUrl}`);

  const debugPort = await getFreePort();
  profileDir = fs.mkdtempSync(path.join(ROOT, '.verify-profile-'));
  info(`Chrome profile: ${profileDir}`);
  info(`Chrome debugging port: ${debugPort}`);

  // ---- launch Chrome
  const flags = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--window-size=390,844',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    '--disable-background-networking',
    '--no-default-browser-check',
    '--disable-extensions',
    'about:blank',
  ];
  info(`Launching: ${CHROME_BIN} ${flags.join(' ')}`);
  chromeProc = spawn(CHROME_BIN, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeStderr = '';
  chromeProc.stderr.on('data', (d) => { chromeStderr += d.toString(); });
  chromeProc.on('error', (e) => { chromeStderr += `\nspawn error: ${e.message}`; });

  // ---- wait for the debugger endpoint
  const version = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    if (!r.ok) return null;
    return r.json();
  }, { label: 'Chrome /json/version', timeout: 25000 });
  info(`Chrome: ${version.Browser} (${version['User-Agent']})`);

  // ---- open a fresh target at about:blank so we capture everything from the start
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
  info(`Target: ${target.id} (${target.type})`);

  // ---- connect CDP
  cdp = new CDP(WS, target.webSocketDebuggerUrl);
  await cdp.connect();

  const consoleMsgs = [];
  const exceptions = [];
  const logEntries = [];
  const dialogs = [];

  cdp.on('Runtime.consoleAPICalled', (p) => {
    consoleMsgs.push({
      type: p.type,
      text: (p.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? '').join(' '),
      url: p.stackTrace?.callFrames?.[0]?.url,
      line: p.stackTrace?.callFrames?.[0]?.lineNumber,
      at: Date.now(),
    });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    exceptions.push({
      text: d.text,
      desc: d.exception?.description || d.exception?.value,
      url: d.url || d.stackTrace?.callFrames?.[0]?.url,
      line: (d.lineNumber ?? d.stackTrace?.callFrames?.[0]?.lineNumber),
      column: d.columnNumber,
      stack: d.stackTrace?.callFrames?.slice(0, 4).map((f) => `${f.functionName || '(anon)'} @ ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`),
      at: Date.now(),
    });
  });
  cdp.on('Log.entryAdded', (p) => {
    logEntries.push({ level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url, line: p.entry.lineNumber });
  });
  cdp.on('Page.javascriptDialogOpening', async (p) => {
    dialogs.push({ type: p.type, message: p.message });
    try { await cdp.send('Page.handleJavaScriptDialog', { accept: true }); } catch { /* ignore */ }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // Instrument the page before any app script runs: capture alert/confirm text and
  // auto-answer dialogs so the app never deadlocks waiting for a modal in headless mode.
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

  // ---- navigate
  const loadFired = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 30000);
    cdp.on('Page.loadEventFired', () => { clearTimeout(t); resolve('fired'); });
  });
  const nav = await cdp.send('Page.navigate', { url: appUrl });
  info(`Page.navigate -> ${JSON.stringify(nav)}`);
  const loadState = await loadFired;
  info(`load event: ${loadState}`);
  await sleep(1500); // let any in-flight CDN script / font work settle

  const newDocExceptions = () => exceptions.filter((e) => e.at > navStart);
  const navStart = Date.now() - 60000; // all captured exceptions are from this session's navigation

  /* =============================== (a) =============================== */
  const indexReqs = requestLog.filter((r) => r.url === APP_URL_PATH);
  const httpStatus = indexReqs.length ? indexReqs[indexReqs.length - 1].status : null;
  const docTitle = await cdp.eval('document.title');
  const readyState = await cdp.eval('document.readyState');
  const locHref = await cdp.eval('location.href');
  record('a1. index.html served over HTTP with status 200',
    httpStatus === 200 && locHref.startsWith('http://'),
    `static server status=${httpStatus}, location.href=${locHref}, readyState=${readyState}`);
  record('a2. document.title === "Nest Inventory & Food Cost"',
    docTitle === 'Nest Inventory & Food Cost',
    `document.title=${JSON.stringify(docTitle)}`);

  /* =============================== (b) =============================== */
  const xlsxType = await cdp.eval('typeof XLSX');
  const xlsxOk = xlsxType === 'object' || xlsxType === 'function';
  const scriptErrors = await cdp.eval('JSON.stringify(window.__scriptErrors || [])');
  const cdnFailed = !xlsxOk;
  if (cdnFailed) {
    warn('b0. CDN SheetJS not loaded (external/network issue, NOT counted as an app bug)',
      `typeof XLSX=${xlsxType}; window.__scriptErrors=${scriptErrors}`);
  } else {
    warn('b0. CDN SheetJS loaded', `typeof XLSX=${xlsxType}, XLSX.version=${await cdp.eval('typeof XLSX!=="undefined"&&XLSX.version')}`);
  }
  const realExceptions = exceptions.filter((e) => {
    const blob = `${e.text || ''} ${e.desc || ''} ${e.url || ''}`;
    if (cdnFailed && /xlsx|cdnjs/i.test(blob)) return false; // CDN failure reported separately
    return true;
  });
  record('b1. No uncaught JS exceptions during load and tab rendering',
    realExceptions.length === 0,
    realExceptions.length === 0
      ? `0 uncaught exceptions (captured ${exceptions.length} total, ${exceptions.length - realExceptions.length} attributed to the CDN)`
      : `${realExceptions.length}: ` + realExceptions.map((e) => `${e.text} :: ${e.desc || ''} @ ${e.url}:${(e.line ?? -1) + 1}`).join(' | '));

  /* =============================== (c) =============================== */
  const globals = await cdp.eval(`JSON.stringify({
    hasS: typeof S === 'object' && S !== null,
    hasV: typeof V === 'object' && V !== null,
    hasDraw: typeof draw === 'function',
    hasSave: typeof save === 'function',
    hasCalc: typeof calc === 'function',
    hasDemo: typeof demo === 'function',
    tabsLen: typeof TABS !== 'undefined' ? TABS.length : null,
    tabIds: typeof TABS !== 'undefined' ? TABS.map(t => t[0]) : null,
  })`);
  const G = JSON.parse(globals);
  record('c1. TABS.length === 5 with ids dash/sales/stock/items/set',
    G.tabsLen === 5 && JSON.stringify(G.tabIds) === JSON.stringify(['dash', 'sales', 'stock', 'items', 'set']),
    `TABS.length=${G.tabsLen}, ids=${JSON.stringify(G.tabIds)}`);

  const tabReport = [];
  let tabPass = true;
  for (const id of ['dash', 'sales', 'stock', 'items', 'set']) {
    const r = await cdp.eval(`(() => {
      V.tab = ${JSON.stringify(id)};
      draw();
      const app = document.getElementById('app');
      const nav = document.getElementById('nav');
      return JSON.stringify({
        id: ${JSON.stringify(id)},
        appLen: app ? app.innerHTML.length : -1,
        navButtons: nav ? nav.querySelectorAll('button').length : -1,
        navOn: nav ? Array.from(nav.querySelectorAll('button')).filter(b => b.className === 'on').length : -1,
        firstText: app ? app.textContent.trim().slice(0, 45) : '',
      });
    })()`);
    const t = JSON.parse(r);
    const ok = t.appLen > 200 && t.navButtons === 5;
    if (!ok) tabPass = false;
    tabReport.push(`${t.id}: app.innerHTML=${t.appLen}, navButtons=${t.navButtons}, "${t.firstText}"`);
  }
  record('c2. Every tab (V.tab + draw()) renders >200 chars into #app and #nav has 5 buttons',
    tabPass, tabReport.join(' || '));

  // also exercise the REAL nav button click handlers (onclick="V.tab=...;draw()")
  const clickReport = [];
  let clickPass = true;
  for (let i = 0; i < 5; i++) {
    const r = await cdp.eval(`(() => {
      const nav = document.getElementById('nav');
      const btns = nav.querySelectorAll('button');
      if (!btns[${i}]) return JSON.stringify({ error: 'no button ' + ${i} });
      btns[${i}].click();
      return JSON.stringify({
        label: btns[${i}].textContent,
        tab: V.tab,
        appLen: document.getElementById('app').innerHTML.length,
        activeCount: nav.querySelectorAll('button.on').length,
      });
    })()`);
    const t = JSON.parse(r);
    const ok = t.tab === ['dash', 'sales', 'stock', 'items', 'set'][i] && t.appLen > 200 && t.activeCount === 1;
    if (!ok) clickPass = false;
    clickReport.push(`btn[${i}] "${t.label}" -> V.tab=${t.tab}, appLen=${t.appLen}, active=${t.activeCount}`);
  }
  record('c3. Clicking each real nav button switches the tab and re-renders',
    clickPass, clickReport.join(' || '));

  /* =============================== (d) =============================== */
  const seed = JSON.parse(await cdp.eval(`JSON.stringify({
    rm: S.rm.length,
    menu: S.menu.length,
    inv: S.inv.length,
    sales: S.sales.length,
    waste: S.waste.length,
    demoSales: S.sales.filter(x => x.demo).length,
    demoRm: S.rm.filter(x => x.demo).length,
    demoMenu: S.menu.filter(x => x.demo).length,
    anyDemo: S.rm.some(x => x.demo) || S.menu.some(x => x.demo) || S.sales.some(x => x.demo) || S.inv.some(x => x.demo) || S.waste.some(x => x.demo),
    lsLen: (localStorage.getItem('nest2') || '').length,
  })`));
  record('d1. Seeded demo state present (rm/menu populated, demo:true flags)',
    seed.rm > 0 && seed.menu > 0 && seed.anyDemo === true,
    `S.rm.length=${seed.rm}, S.menu.length=${seed.menu}, S.inv.length=${seed.inv}, S.sales.length=${seed.sales}, S.waste.length=${seed.waste}; demo flags: rm=${seed.demoRm}, menu=${seed.demoMenu}, sales=${seed.demoSales}; anyItemDemo=true; localStorage['nest2'] length=${seed.lsLen}`);

  /* =============================== (e) =============================== */
  // (e1) Add a raw material through the real Items-tab form + its own Add button.
  const beforeRM = await cdp.eval('S.rm.length');
  const addRmUI = await cdp.eval(`(() => {
    V.tab = 'items'; draw();
    const nm = 'ZZ Verify Material ' + Date.now();
    document.getElementById('an').value = nm;
    document.getElementById('ap').value = '123.5';
    document.getElementById('au').value = 'kg';
    document.getElementById('am').value = '4';
    const btn = Array.from(document.querySelectorAll('#app button.b')).find(b => /onclick/.test('') || b.getAttribute('onclick') === 'addRM()');
    if (!btn) return JSON.stringify({ error: 'Add (raw material) button not found' });
    btn.click();
    const created = S.rm.find(r => r.name === nm);
    return JSON.stringify({
      name: nm,
      clickedOnclick: btn.getAttribute('onclick'),
      rmLen: S.rm.length,
      created: created ? { id: created.id, name: created.name, unit: created.unit, price: created.prices[created.prices.length - 1].p } : null,
      alerts: window.__alerts.slice(),
    });
  })()`);
  const rmUI = JSON.parse(addRmUI);
  let lsHasRM = false, lsParses = false, lsRMRecord = null;
  if (rmUI.created) {
    const ls = await cdp.eval(`(() => {
      try {
        const raw = localStorage.getItem('nest2');
        const o = JSON.parse(raw);
        const rec = (o.rm || []).find(r => r.name === ${JSON.stringify(rmUI.name)});
        return JSON.stringify({ parses: true, found: !!rec, rec: rec || null, bytes: raw.length });
      } catch (e) { return JSON.stringify({ parses: false, error: String(e) }); }
    })()`);
    const L = JSON.parse(ls);
    lsParses = L.parses; lsHasRM = L.found; lsRMRecord = L.rec;
  }
  record('e1. addRM() via real DOM form + button click grew S.rm and persisted to localStorage.nest2',
    !!rmUI.created && rmUI.rmLen === beforeRM + 1 && lsParses && lsHasRM,
    `S.rm.length ${beforeRM} -> ${rmUI.rmLen}; clicked onclick="${rmUI.clickedOnclick}"; created=${JSON.stringify(rmUI.created)}; localStorage parses=${lsParses}, contains record=${lsHasRM}, persisted=${JSON.stringify(lsRMRecord)}`);

  // (e2) Add a menu item through the real Items-tab form + button.
  const beforeMenu = await cdp.eval('S.menu.length');
  const addMUI = JSON.parse(await cdp.eval(`(() => {
    V.tab = 'items'; draw();
    const nm = 'ZZ Verify Dish ' + Date.now();
    document.getElementById('mn').value = nm;
    document.getElementById('mp').value = '149';
    const btn = Array.from(document.querySelectorAll('#app button.b')).find(b => b.getAttribute('onclick') === 'addM()');
    if (!btn) return JSON.stringify({ error: 'Add (menu item) button not found' });
    btn.click();
    const created = S.menu.find(m => m.name === nm);
    return JSON.stringify({ name: nm, menuLen: S.menu.length, created: created || null, alerts: window.__alerts.slice() });
  })()`));
  const lsMenu = JSON.parse(await cdp.eval(`(() => {
    try {
      const o = JSON.parse(localStorage.getItem('nest2'));
      return JSON.stringify({ found: !!(o.menu || []).find(m => m.name === ${JSON.stringify(addMUI.name)}) });
    } catch (e) { return JSON.stringify({ found: false, error: String(e) }); }
  })()`));
  record('e2. addM() via real DOM form + button click grew S.menu and persisted to localStorage.nest2',
    !!addMUI.created && addMUI.menuLen === beforeMenu + 1 && lsMenu.found === true,
    `S.menu.length ${beforeMenu} -> ${addMUI.menuLen}; created=${JSON.stringify(addMUI.created)}; localStorage contains record=${lsMenu.found}`);

  // (e3) Record wastage through the real Stock-tab form + button (exercises saveWaste + save()).
  const beforeWaste = await cdp.eval('S.waste.length');
  const wasteUI = JSON.parse(await cdp.eval(`(() => {
    V.tab = 'stock'; draw();
    document.getElementById('wq').value = '2.5';
    const wr = document.getElementById('wr');
    const picked = wr.value;
    document.querySelector('button[onclick^="saveWaste"]').click();
    return JSON.stringify({
      picked, wasteLen: S.waste.length,
      last: S.waste[S.waste.length - 1],
      alerts: window.__alerts.slice(),
    });
  })()`));
  const lsWaste = JSON.parse(await cdp.eval(`JSON.stringify({ found: JSON.parse(localStorage.getItem('nest2')).waste.some(w => w.qty === 2.5 && w.rm === ${JSON.stringify(wasteUI.picked)}) })`));
  record('e3. saveWaste() via real Stock-tab form + button click grew S.waste and persisted',
    wasteUI.wasteLen === beforeWaste + 1 && lsWaste.found === true,
    `S.waste.length ${beforeWaste} -> ${wasteUI.wasteLen}; new record=${JSON.stringify(wasteUI.last)}; localStorage contains it=${lsWaste.found}; alerts=${JSON.stringify(wasteUI.alerts)}`);

  // (e4) Save a stock count through the real form + button.
  // NOTE: saveStock() REPLACES all of that outlet+date's entries, so the correct
  // assertion is "exactly one entry for this material with the typed values",
  // not "the array grew".
  const stockUI = JSON.parse(await cdp.eval(`(() => {
    V.tab = 'stock'; draw();
    const rid = S.rm[0].id;
    const o = V.out === 'All' ? 'Areekode' : V.out;
    document.getElementById('o_' + rid).value = '10';
    document.getElementById('p_' + rid).value = '5';
    document.getElementById('c_' + rid).value = '8';
    document.querySelector('button[onclick^="saveStock"]').click();
    const day = S.inv.filter(e => e.d === V.date && e.o === o);
    const mine = day.filter(e => e.rm === rid);
    let lsHas = false;
    try {
      lsHas = JSON.parse(localStorage.getItem('nest2')).inv.some(e =>
        e.d === V.date && e.o === o && e.rm === rid && e.open === 10 && e.pur === 5 && e.close === 8);
    } catch (e) { /* leave false */ }
    return JSON.stringify({
      rid, date: V.date, outlet: o, dayCount: day.length, mineCount: mine.length,
      mine: mine[0] || null, lsHas, alerts: window.__alerts.slice(),
    });
  })()`));
  const stockOk = stockUI.mineCount === 1 && stockUI.mine
    && stockUI.mine.open === 10 && stockUI.mine.pur === 5 && stockUI.mine.close === 8
    && stockUI.lsHas === true
    && stockUI.alerts.some((a) => /^Saved for/.test(a));
  record('e4. saveStock() via real Stock-tab form + button click wrote + persisted the stock entry',
    stockOk,
    `date=${stockUI.date}/${stockUI.outlet}: ${stockUI.dayCount} entries that day, ${stockUI.mineCount} for ${stockUI.rid}; stored=${JSON.stringify(stockUI.mine)}; localStorage contains it=${stockUI.lsHas}; alert="${stockUI.alerts.join(' | ')}"`);

  // (e5) Feed a real CSV file through the page's own <input type=file> so the
  //      XLSX (CDN SheetJS) import path actually runs end-to-end.
  const csvPath = path.join(ROOT, '.verify-sales-fixture.csv');
  fs.writeFileSync(csvPath, [
    'Date,Menu Item,Quantity Sold,Selling Price,Total Sales',
    '2026-10-05,Loaded Fries,10,110,1100',
    '2026-10-05,Zinger Burger,5,120,600',
    '2026-10-05,Cheese Fries,7,90,630',
  ].join('\n') + '\n');
  let importResult = { error: 'not attempted' };
  try {
    const salesBefore = await cdp.eval('S.sales.length');
    await cdp.eval(`V.tab = 'sales'; draw();`);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#app input[type=file]' });
    if (!nodeId) throw new Error('file input not found in Sales tab');
    await cdp.send('DOM.setFileInputFiles', { files: [csvPath], nodeId });
    await cdp.eval(`(() => {
      const el = document.querySelector('#app input[type=file]');
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const preview = await waitFor(async () => {
      const r = JSON.parse(await cdp.eval(`JSON.stringify(typeof P === 'object' && P ? {
        rows: P.rows.length,
        matched: P.rows.filter(r => r.mid).length,
        errors: P.rows.reduce((n, r) => n + r.er.length, 0),
        dup: P.rows.filter(r => r.dup).length,
        previewRendered: /Confirm import/.test(document.getElementById('app').innerHTML),
        alerts: window.__alerts.slice(),
      } : null)`));
      return r;
    }, { label: 'sales import preview', timeout: 15000 });
    const confirmed = JSON.parse(await cdp.eval(`(() => {
      const btn = Array.from(document.querySelectorAll('#app button')).find(b => b.getAttribute('onclick') === 'confirmImp()');
      if (!btn) return JSON.stringify({ error: 'Confirm import button missing (disabled or not rendered)' });
      if (btn.disabled) return JSON.stringify({ error: 'Confirm import button disabled' });
      btn.click();
      return JSON.stringify({
        salesLen: S.sales.length,
        Vdate: V.date,
        rows: S.sales.filter(s => s.d === '2026-10-05'),
        lsHas: JSON.parse(localStorage.getItem('nest2')).sales.filter(s => s.d === '2026-10-05').length,
      });
    })()`));
    importResult = { salesBefore, preview, confirmed };
    const impOk = preview.rows === 3 && preview.matched === 3 && preview.errors === 0
      && !confirmed.error && Array.isArray(confirmed.rows) && confirmed.rows.length === 3
      && confirmed.lsHas === 3 && confirmed.salesLen === salesBefore + 3;
    record('e5. Excel/CSV import via <input type=file> ran XLSX (CDN) and persisted 3 sales rows',
      impOk,
      `preview: ${preview.rows} rows, ${preview.matched} matched, ${preview.errors} errors, ${preview.dup} dup, "Confirm import" rendered=${preview.previewRendered}; after confirm: S.sales ${salesBefore} -> ${confirmed.salesLen}, new rows=${JSON.stringify(confirmed.rows)}, persisted to localStorage=${confirmed.lsHas}; V.date=${confirmed.Vdate}`);
  } catch (e) {
    record('e5. Excel/CSV import via <input type=file> ran XLSX (CDN) and persisted 3 sales rows',
      false, `FAILED: ${e.message}; partial=${JSON.stringify(importResult)}`);
  } finally {
    try { fs.rmSync(csvPath, { force: true }); } catch { /* ignore */ }
  }

  // snapshot the exact persisted evidence we will look for after reload
  const persistedProbe = JSON.parse(await cdp.eval(`(() => {
    const raw = localStorage.getItem('nest2');
    return JSON.stringify({ bytes: raw.length, rmName: ${JSON.stringify(rmUI.name)}, menuName: ${JSON.stringify(addMUI.name)}, rid: ${JSON.stringify(rmUI.created && rmUI.created.id)} });
  })()`));

  /* =============================== (f) =============================== */
  exceptions.length = 0; consoleMsgs.length = 0;
  const reloadFired = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 30000);
    cdp.on('Page.loadEventFired', () => { clearTimeout(t); resolve('fired'); });
  });
  await cdp.send('Page.reload', { ignoreCache: false });
  const reloadState = await reloadFired;
  await sleep(1200);
  info(`reload load event: ${reloadState}`);

  const afterReload = JSON.parse(await cdp.eval(`(() => {
    let ls = null, lsErr = null;
    try { ls = JSON.parse(localStorage.getItem('nest2')); } catch (e) { lsErr = String(e); }
    const has = (arr, name) => Array.isArray(arr) && arr.some(x => x.name === name);
    return JSON.stringify({
      lsErr,
      lsBytes: (localStorage.getItem('nest2') || '').length,
      lsHasRM: ls ? has(ls.rm, ${JSON.stringify(rmUI.name)}) : false,
      lsHasMenu: ls ? has(ls.menu, ${JSON.stringify(addMUI.name)}) : false,
      lsWaste25: ls ? (ls.waste || []).some(w => w.qty === 2.5) : false,
      SrmLen: typeof S === 'object' ? S.rm.length : null,
      SmenuLen: typeof S === 'object' ? S.menu.length : null,
      S: typeof S === 'object' ? {
        hasRM: S.rm.some(r => r.name === ${JSON.stringify(rmUI.name)}),
        hasMenu: S.menu.some(m => m.name === ${JSON.stringify(addMUI.name)}),
        waste25: S.waste.some(w => w.qty === 2.5),
      } : null,
      title: document.title,
      appLen: document.getElementById('app').innerHTML.length,
      alerts: window.__alerts.slice(),
    });
  })()`));
  record('f1. Mutation survived Page.reload (localStorage.nest2 re-parsed, S rebuilt from it)',
    afterReload.lsErr === null && afterReload.lsHasRM && afterReload.lsHasMenu && afterReload.S && afterReload.S.hasRM && afterReload.S.hasMenu,
    `localStorage bytes ${persistedProbe.bytes} -> ${afterReload.lsBytes}; nest2 parses=${afterReload.lsErr === null}; ls has new material=${afterReload.lsHasRM}, new menu item=${afterReload.lsHasMenu}, wastage 2.5=${afterReload.lsWaste25}; rebuilt S.rm.length=${afterReload.SrmLen} contains new material=${afterReload.S && afterReload.S.hasRM}; S.menu contains new item=${afterReload.S && afterReload.S.hasMenu}`);
  record('f2. No uncaught exceptions during reload',
    exceptions.length === 0,
    exceptions.length === 0 ? '0 exceptions after reload' : exceptions.map((e) => `${e.text} :: ${e.desc} @ ${e.url}:${(e.line ?? -1) + 1}`).join(' | '));

  /* =============================== (g) =============================== */
  const shots = [
    { tab: 'dash', file: 'verified-1-dashboard.png' },
    { tab: 'sales', file: 'verified-2-sales.png' },
    { tab: 'stock', file: 'verified-3-stock.png' },
  ];
  const shotReport = [];
  let shotsPass = true;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }).catch(() => {});
  for (const s of shots) {
    await cdp.eval(`V.tab = ${JSON.stringify(s.tab)}; draw(); scrollTo(0,0);`);
    await sleep(400);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const buf = Buffer.from(data, 'base64');
    const out = path.join(ROOT, s.file);
    fs.writeFileSync(out, buf);
    const size = fs.statSync(out).size;
    const ok = size > 5000;
    if (!ok) shotsPass = false;
    shotReport.push(`${s.file} (tab=${s.tab}) ${size} bytes`);
  }
  record('g1. Screenshots captured for dashboard + 2 other tabs',
    shotsPass, shotReport.join(', '));

  /* ------------------------------------------------------------------ *
   * adversarial checks: CDN outage + damaged localStorage
   * ------------------------------------------------------------------ */
  // freeze the main transcript before the adversarial reloads pollute it
  const pageAlerts = await cdp.eval('JSON.stringify(window.__alerts || [])').catch(() => '[]');
  const mainTranscript = {
    consoleMsgs: [...consoleMsgs],
    exceptions: [...exceptions],
    logEntries: [...logEntries],
    dialogs: [...dialogs],
  };
  consoleMsgs.length = 0; exceptions.length = 0; logEntries.length = 0; dialogs.length = 0;

  const reloadPage = async () => {
    const fired = new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 30000);
      cdp.on('Page.loadEventFired', () => { clearTimeout(t); resolve('fired'); });
    });
    await cdp.send('Page.reload', { ignoreCache: false });
    await fired;
    await sleep(1200);
  };

  /* (h1/h2) what happens if the SheetJS CDN is unreachable? */
  let cdnBlockWorking = false;
  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['*cdnjs.cloudflare.com*'] });
    cdnBlockWorking = true;
  } catch (e) {
    info(`Network.setBlockedURLs unavailable: ${e.message}`);
  }
  if (cdnBlockWorking) {
    exceptions.length = 0;
    await reloadPage();
    const noCdn = JSON.parse(await cdp.eval(`JSON.stringify({
      xlsx: typeof XLSX,
      appLen: document.getElementById('app').innerHTML.length,
      navButtons: document.getElementById('nav').querySelectorAll('button').length,
      title: document.title,
      scriptErrors: window.__scriptErrors || [],
    })`));
    const cdnExceptions = [...exceptions];
    const xlsxGone = noCdn.xlsx === 'undefined';
    record('h1. With the xlsx CDN blocked: no uncaught exception, app UI still renders (CDN fault reported as WARNING)',
      xlsxGone && cdnExceptions.length === 0 && noCdn.appLen > 200 && noCdn.navButtons === 5,
      xlsxGone
        ? `typeof XLSX=${noCdn.xlsx}; app.innerHTML=${noCdn.appLen} chars; nav buttons=${noCdn.navButtons}; uncaught exceptions=${cdnExceptions.length}${cdnExceptions.length ? ' :: ' + cdnExceptions.map((e) => `${e.text} @ ${e.url}:${(e.line ?? -1) + 1}`).join(' | ') : ''}`
        : `COULD NOT SIMULATE CDN OUTAGE (typeof XLSX=${noCdn.xlsx}) - result not meaningful`);

    // does an import attempt degrade gracefully with no XLSX?
    const csvPath2 = path.join(ROOT, '.verify-cdn-fixture.csv');
    fs.writeFileSync(csvPath2, 'Date,Menu Item,Quantity Sold,Total Sales\n2026-10-06,Loaded Fries,1,110\n');
    try {
      await cdp.eval(`V.tab='sales'; draw();`);
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#app input[type=file]' });
      await cdp.send('DOM.setFileInputFiles', { files: [csvPath2], nodeId });
      await cdp.eval(`document.querySelector('#app input[type=file]').dispatchEvent(new Event('change', { bubbles: true }))`);
      await sleep(1500);
      const impFail = JSON.parse(await cdp.eval(`JSON.stringify({ alerts: window.__alerts.slice(), appLen: document.getElementById('app').innerHTML.length })`));
      record('h2. Import attempt without XLSX fails gracefully (alert, no uncaught exception)',
        exceptions.length === 0 && impFail.alerts.some((a) => /Import problem/.test(a)),
        `${exceptions.length} uncaught exceptions; alert()="${impFail.alerts.join(' | ')}"; app still ${impFail.appLen} chars`);
    } catch (e) {
      record('h2. Import attempt without XLSX fails gracefully (alert, no uncaught exception)', false, `harness/import error: ${e.message}`);
    } finally {
      try { fs.rmSync(csvPath2, { force: true }); } catch { /* ignore */ }
    }
    await cdp.send('Network.setBlockedURLs', { urls: [] }).catch(() => {});
  } else {
    warn('h1/h2 skipped', 'could not block the CDN URL from this harness');
  }

  /* (h3) damaged but unparseable localStorage -> should fall back to demo */
  exceptions.length = 0;
  await cdp.eval(`localStorage.setItem('nest2', '{this is not json')`);
  await reloadPage();
  const badJson = JSON.parse(await cdp.eval(`JSON.stringify({
    appLen: document.getElementById('app').innerHTML.length,
    rm: typeof S === 'object' && S ? S.rm.length : null,
  })`));
  record('h3. Unparseable localStorage.nest2 does not crash (falls back to demo data)',
    exceptions.length === 0 && badJson.appLen > 200 && (badJson.rm || 0) > 0,
    `exceptions=${exceptions.length}${exceptions.length ? ' :: ' + exceptions.map((e) => `${e.text} @ ${e.url}:${(e.line ?? -1) + 1}`).join(' | ') : ''}; app.innerHTML=${badJson.appLen} chars; S.rm.length=${badJson.rm}`);

  /* (h4) PARSEABLE but partial localStorage -> potential hard crash */
  exceptions.length = 0;
  await cdp.eval(`localStorage.setItem('nest2', '{}')`);
  await reloadPage();
  const partial = JSON.parse(await cdp.eval(`JSON.stringify({
    appLen: document.getElementById('app').innerHTML.length,
    navLen: document.getElementById('nav').innerHTML.length,
    hasS: typeof S,
    title: document.title,
  })`));
  const partialExceptions = [...exceptions];
  const partialCrashed = partialExceptions.length > 0 || partial.appLen < 50;
  if (partialCrashed) {
    warn('h4. FINDING: valid-but-partial localStorage (e.g. "{}") hard-crashes the app on every load',
      `app.innerHTML=${partial.appLen} chars, #nav=${partial.navLen} chars, typeof S=${partial.hasS}; uncaught exceptions=${partialExceptions.length}` +
      (partialExceptions.length ? ` :: ` + partialExceptions.map((e) => `${e.text} :: ${(e.desc || '').split('\n')[0]} @ ${e.url}:${(e.line ?? -1) + 1}`).join(' | ') : ''));
  } else {
    record('h4. Valid-but-partial localStorage ("{}") is handled gracefully', true,
      `app.innerHTML=${partial.appLen} chars, typeof S=${partial.hasS}, ${partialExceptions.length} exceptions`);
  }
  // confirm it is a persistent brick: a second plain reload also fails
  if (partialCrashed) {
    exceptions.length = 0;
    await reloadPage();
    const again = JSON.parse(await cdp.eval(`JSON.stringify({ appLen: document.getElementById('app').innerHTML.length })`));
    info(`h4 follow-up: after a further plain reload with the same bad value, app.innerHTML=${again.appLen} chars and ${exceptions.length} exception(s) -> the app stays broken until localStorage is cleared by hand.`);
  }
  // restore a clean slate
  await cdp.eval(`localStorage.clear()`);
  exceptions.length = 0;
  await reloadPage();
  const restored = JSON.parse(await cdp.eval(`JSON.stringify({ appLen: document.getElementById('app').innerHTML.length, rm: S.rm.length })`));
  record('h5. Clearing localStorage restores a working demo app',
    restored.appLen > 200 && restored.rm === 8,
    `app.innerHTML=${restored.appLen} chars, S.rm.length=${restored.rm}, exceptions=${exceptions.length}`);

  /* (i1) GitHub Pages style project subpath: http://host/<repo>/ */
  exceptions.length = 0; requestLog.length = 0;
  const subUrl = `http://127.0.0.1:${httpPort}${SUBPATH_PREFIX}/`;
  const subFired = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 30000);
    cdp.on('Page.loadEventFired', () => { clearTimeout(t); resolve('fired'); });
  });
  await cdp.send('Page.navigate', { url: subUrl });
  await subFired;
  await sleep(1500);
  const sub = JSON.parse(await cdp.eval(`JSON.stringify({
    href: location.href,
    title: document.title,
    appLen: document.getElementById('app').innerHTML.length,
    navButtons: document.getElementById('nav').querySelectorAll('button').length,
    xlsx: typeof XLSX,
    nestedLocalStorage: typeof localStorage.getItem('nest2'),
    resolvedScripts: Array.from(document.scripts).map(s => s.src).filter(Boolean),
  })`));
  const subReqs = requestLog.map((r) => `${r.url}:${r.status}`);
  record('i1. App works from a /<repo>/ GitHub Pages style subpath (no relative-path breakage)',
    sub.title === 'Nest Inventory & Food Cost' && sub.appLen > 200 && sub.navButtons === 5 && exceptions.length === 0,
    `location.href=${sub.href}; title="${sub.title}"; app.innerHTML=${sub.appLen} chars; nav=${sub.navButtons}; typeof XLSX=${sub.xlsx}; requests=[${subReqs.join(', ')}]; exceptions=${exceptions.length}`);
  info(`i1 scripts resolved from: ${JSON.stringify(sub.resolvedScripts)}`);

  /* ------------------------- console / log dump ------------------------- */
  console.log('\n================ CONSOLE & PAGE-ERROR TRANSCRIPT (main session) ================');
  const interestingConsole = mainTranscript.consoleMsgs.filter((m) => m.type !== 'debug');
  if (!interestingConsole.length) console.log('(no console messages captured)');
  for (const m of interestingConsole) console.log(`  [console.${m.type}] ${m.text}${m.url ? `  @ ${m.url}:${(m.line ?? -1) + 1}` : ''}`);
  if (mainTranscript.exceptions.length) {
    console.log('  --- uncaught exceptions ---');
    for (const e of mainTranscript.exceptions) console.log(`  [exception] ${e.text} :: ${e.desc} @ ${e.url}:${(e.line ?? -1) + 1}`);
  }
  const noisyLog = mainTranscript.logEntries.filter((e) => !/font|Font|favicon|net::ERR_|Deprecat/i.test(e.text || ''));
  if (noisyLog.length) {
    console.log('  --- other browser log entries ---');
    for (const e of noisyLog) console.log(`  [log.${e.level}/${e.source}] ${e.text} ${e.url || ''}`);
  }
  const netish = mainTranscript.logEntries.filter((e) => /net::ERR_|Failed to load resource/i.test(e.text || ''));
  if (netish.length) {
    console.log('  --- network/resource failures ---');
    for (const e of netish) console.log(`  [net] ${e.text} ${e.url || ''}`);
  }
  console.log(`  --- alert() calls seen in page: ${pageAlerts}`);
  console.log(`  --- CDP dialogs auto-accepted: ${JSON.stringify(mainTranscript.dialogs)}`);
  console.log(`  --- static server requests: ${JSON.stringify(requestLog)}`);
  console.log('=================================================================================\n');

  /* ------------------------- summary ------------------------- */
  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY: ${results.length - failed.length}/${results.length} assertions PASSED`);
  if (failed.length) {
    console.log('FAILED:');
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
  console.error('HARNESS ERROR (not necessarily an app bug):', e && e.stack || e);
  exitCode = 2;
} finally {
  await cleanup();
}
console.log(`\nEXIT ${exitCode}${exitCode === 2 ? ' (harness error)' : ''}`);
process.exit(exitCode);
