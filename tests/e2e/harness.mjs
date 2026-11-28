// E2E-Hilfen für die LIVE-Repos (PS-Dashboard / PS-Dashboard-Telekom): statischer Server, Firebase-Testersatz,
// Power-Automate-ATTRAPPEN. Synthetische Daten, kein echter Flow / kein echtes SharePoint / kein echtes Firebase.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const FAKE = fs.readFileSync(new URL('./fake-firebase-compat.js', import.meta.url), 'utf8');
// CDN-Bibliotheken aus node_modules (npm i --no-save …, siehe README); Ordner per PS_NODE_MODULES änderbar
const NM = process.env.PS_NODE_MODULES || path.join(process.cwd(), 'node_modules');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export function staticServer(root) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(c => srv.close(c)) })));
}

export const BRANDS = {
  o2: {
    ns: 'o2-pencil-selling', queue: 'o2', archiveFlow: '6e4980d3dcb74b89bec5b9d88d14e5eb', v3Flow: 'b2b28ed9cc334864ab329d8369175831',
    shops: { A: 'aalen', C: 'crailsheim' }, shopName: { aalen: 'Aalen', crailsheim: 'Crailsheim' }
  },
  telekom: {
    ns: 'pencil-selling-telekom', queue: 'telekom', archiveFlow: '68f976da79094ad5b087fc8072ede002', v3Flow: 'c19dac4835d44e8a80ed2d45ddc48801',
    shops: { A: null, C: null }
  }
};
export const PW = 'Synthetik-123';
// CDN-Dateien lokal (Netz im Testsystem gesperrt), gleiche Versionen wie in index.html
const LOCAL = [
  [/react-dom@18\.3\.1/, 'react-dom/umd/react-dom.production.min.js'],
  [/react@18\.3\.1/, 'react/umd/react.production.min.js'],
  [/html2pdf\.js@0\.10\.1/, 'html2pdf.js/dist/html2pdf.bundle.min.js'],
  [/pdf-lib\/1\.17\.1/, 'pdf-lib/dist/pdf-lib.min.js'],
  [/pdf\.js\/2\.16\.105\/pdf\.min\.js/, 'pdfjs-dist/build/pdf.min.js'],
  [/pdf\.js\/2\.16\.105\/pdf\.worker/, 'pdfjs-dist/build/pdf.worker.min.js'],
  [/cdn\.tailwindcss\.com/, null]
];

export function flows() {
  return { stored: new Set(), payloads: [], archiveDown: false, storeDelayMs: 0, v3Broken: false, v3NoExists: false, v3Calls: [] };
}
export const sid = n => String(n || '').toLowerCase().replace(/[^a-z0-9._+\-]/g, '_').slice(0, 180);

export async function launch() {
  return chromium.launch({ executablePath: process.env.PW_CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
}

/** Kontext mit Firebase-Ersatz und Flow-Attrappen. archiveFlowMatch: Teilstring der Archiv-Flow-URL. */
export async function context(browser, srv, brand, seed, fl, archiveFlowMatch) {
  const B = BRANDS[brand];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(s => { window.__FAKE_FB_SEED = s; window.__PS_TEST_HOOKS = true; }, seed);
  await ctx.route(u => !u.href.startsWith(srv.url) && !/^(data|blob):/.test(u.href), async route => {
    const u = route.request().url();
    if (/firebase-app-compat\.js/.test(u)) return route.fulfill({ contentType: 'text/javascript', body: FAKE });
    if (/gstatic\.com\/firebasejs\//.test(u)) return route.fulfill({ contentType: 'text/javascript', body: '' });
    if (archiveFlowMatch && u.includes(archiveFlowMatch)) {
      if (fl.archiveDown) return route.abort('internetdisconnected');
      let p = {};
      try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      fl.payloads.push({ archiveFileName: p.archiveFileName, archiveSubject: p.archiveSubject, agent: p.agent, shop: p.shop, type: p.type, pdf: !!p.pdfBase64 });
      const id = sid(p.archiveFileName);
      if (fl.storeDelayMs) setTimeout(() => fl.stored.add(id), fl.storeDelayMs); else fl.stored.add(id);
      return route.fulfill({ status: 202, body: '' });
    }
    if (u.includes(B.v3Flow)) {
      const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
      let p = {};
      try { p = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      fl.v3Calls.push(p.action || '');
      if (fl.v3Broken) return route.fulfill({ status: 500, headers: h, body: JSON.stringify({ ok: false, error: 'server' }) });
      if (p.action === 'exists') {
        if (fl.v3NoExists) return route.fulfill({ status: 400, headers: h, body: JSON.stringify({ ok: false, error: 'unknown action' }) });
        const found = (p.names || []).filter(n => fl.stored.has(sid(n)));
        return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ ok: true, found }) });
      }
      if (p.action === 'list') return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ ok: true, items: [...fl.stored].map((n, i) => ({ id: i + 1, name: n })), lastId: fl.stored.size, done: true }) });
      return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ ok: true }) });
    }
    const local = LOCAL.find(([re]) => re.test(u));
    if (local) return route.fulfill({ contentType: 'text/javascript', body: local[1] ? fs.readFileSync(path.join(NM, local[1])) : '' });
    return route.abort();
  });
  return ctx;
}

export async function page(ctx) {
  const pg = await ctx.newPage();
  pg.errs = [];
  pg.on('pageerror', e => pg.errs.push(String(e).slice(0, 300)));
  return pg;
}
