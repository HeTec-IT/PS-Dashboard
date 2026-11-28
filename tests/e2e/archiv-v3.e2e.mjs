// Archivierung v3 – Browser-Ende-zu-Ende gegen die ECHTE index.html (Chromium), synthetische Daten.
// Firebase = Testersatz (fake-firebase-compat.js, OHNE Firestore-Regeln), Power Automate / SharePoint = Attrappen.
// Jedes "Tablet" ist ein eigener Browser-Kontext (eigene IndexedDB/localStorage); das zentrale Backend (Firestore)
// wird zwischen den Tablets synchronisiert, SharePoint ist gemeinsam.
//
// Aufruf (im Repo-Ordner):
//   npm i --no-save playwright@1.63.0 react@18.3.1 react-dom@18.3.1 html2pdf.js@0.10.1 pdf-lib@1.17.1 pdfjs-dist@2.16.105
//   PW_CHROME=/pfad/zu/chrome PS_BRAND=o2 PS_FILE=index.html node --test tests/e2e/
//   PS_BRAND=o2 PS_FILE=index-neu.html … (Hall-Test)     PS_BRAND=telekom … (im Telekom-Repo)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticServer, BRANDS, PW, flows, sid, launch, context, page } from './harness.mjs';

const ROOT = process.env.PS_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = process.env.PS_BRAND || 'o2';
const FILE = process.env.PS_FILE || 'index.html';
const B = BRANDS[BRAND];
const QN = B.queue;
const SH = BRAND === 'telekom' ? { X: 'telekom-crailsheim', Y: 'fh-ellwangen' } : { X: 'crailsheim', Y: 'aalen' };
const prof = (name, vorname, shopId, extra = {}) => ({ name, vorname, nachname: name.split(' ')[1], role: 'verkaeufer', active: true, status: 'approved', shopId, ...extra });
const ACC = [
  ['uidA', 'test.anna@hetec-gmbh.de', prof('Anna Archiv', 'Anna', SH.X)],
  ['uidB', 'test.bernd@hetec-gmbh.de', prof('Bernd Beispiel', 'Bernd', SH.X)],
  ['uidC', 'test.clara@hetec-gmbh.de', prof('Clara Fremd', 'Clara', SH.Y)],
  ['uidD', 'test.dora@hetec-gmbh.de', prof('Dora Dritte', 'Dora', SH.X)],
  ['uidS', 'test.sven@hetec-gmbh.de', prof('Sven Springer', 'Sven', SH.Y, { springer: true })],
  ['uidAdm', 'test.admin@hetec-gmbh.de', prof('Ada Admin', 'Ada', '', { role: 'admin' })]
];
const SEED = { accounts: ACC.map(([uid, email]) => ({ uid, email, password: PW })), docs: Object.fromEntries(ACC.map(([uid, email, p]) => [B.ns + '|users/' + uid, { ...p, email }])) };
const EMAIL = Object.fromEntries(ACC.map(([uid, email]) => [uid, email]));

let srv, browser;
before(async () => { srv = await staticServer(ROOT); browser = await launch(); });
after(async () => { if (browser) await browser.close(); if (srv) await srv.close(); });

const fl = flows();
/** Ein Tablet = eigener Kontext. */
async function tablet() { const ctx = await context(browser, srv, BRAND, SEED, fl, B.archiveFlow); const pg = await page(ctx); return { ctx, pg }; }
async function login(pg, uid) {
  if (pg.url().startsWith(srv.url)) { await pg.evaluate(() => window.__betaAuth && window.__betaAuth.signOut()).catch(() => {}); }
  await pg.goto(srv.url + '/' + FILE);
  await pg.waitForSelector('#ps-gate-email', { timeout: 30000 });
  await pg.fill('#ps-gate-email', EMAIL[uid]);
  await pg.fill('#ps-gate-pw', PW);
  await pg.click('#ps-gate-submit');
  await pg.waitForFunction(u => window.__PS_USER_UID === u && window.__psArchivTest && window.__psArchivQueueDeps, uid, { timeout: 40000 });
}
/** Zentrales Backend (Firestore-Ersatz) von einem Tablet auf andere übertragen (wie die echte Cloud-Datenbank). */
const backend = { docs: {} };
async function pull(pg) { const d = await pg.evaluate(() => firebase.__state().docs); Object.assign(backend.docs, d); }
async function push(pg) { await pg.evaluate(d => { const S = firebase.__state(); S.log = []; Object.assign(S.docs, d); try { localStorage.setItem('__fakefb', JSON.stringify(firebase.__state())); } catch (e) {} }, backend.docs); }
async function delDoc(pg, key) { await pg.evaluate(k => { delete firebase.__state().docs[k]; }, key); delete backend.docs[key]; }

const submit = (pg, { typ = 'angebot', kennung = 'keinName', kunde = '', pdf = true, broken = '' } = {}) => pg.evaluate(async o => {
  const T = window.__psArchivTest;
  const datum = PSArchivQueue.localDate();
  const name = T.name(o.typ, datum, o.kennung);
  const betreff = T.betreff(o.typ, datum, window.__PS_PROFILE_NAME);
  const body = o.broken === 'truncated' ? '%PDF-1.4\n' + 'abgeschnitten '.repeat(80) : '%PDF-1.4\n' + 'synthetisch '.repeat(80) + '\n%%EOF';
  const blob = o.pdf ? new Blob([body], { type: 'application/pdf' }) : new Blob(['<html>kaputt</html>'], { type: 'text/html' });
  try { T.resetTokens(); } catch (e) {}
  const r = await T.submit(blob, name, betreff, { kunde: o.kunde, ruf: o.typ === 'abschluss' ? o.kennung : '' });
  return { ...r, error: r && r.error ? String(r.error.message || r.error) : undefined, name };
}, { typ, kennung, kunde, pdf, broken });
const qAll = pg => pg.evaluate(async qn => (await PSArchivQueue.queue(qn).all()).map(r => ({ id: r.archiveId, uid: r.uid, status: r.status, fileName: r.fileName, shopId: r.shopId, hasPdf: !!r.pdfBlob, sends: r.sends, indexed: !!r.indexed })), QN);
const qUpd = (pg, id, patch) => pg.evaluate(async ([qn, i, p]) => PSArchivQueue.queue(qn).update(i, p), [QN, id, patch]);
// Durchlauf; läuft gerade der Hintergrundlauf der App, wird gewartet und erneut ausgeführt (sonst alter Stand)
const proc = pg => pg.evaluate(async qn => { const q = PSArchivQueue.queue(qn); let r; for (let i = 0; i < 3; i++) { r = await q.process(window.__psArchivQueueDeps()); } return r; }, QN);
// Testhilfe: unveränderliche Felder (z. B. createdAt) für Alters-Szenarien direkt im Speicher zurückdatieren
const qBackdate = (pg, id, patch) => pg.evaluate(async ([qn, i, p]) => { const q = PSArchivQueue.queue(qn); const r = await q.get(i); await q.store.put(Object.assign({}, r, p)); }, [QN, id, patch]);
const idx = pg => pg.evaluate(ns => { const d = firebase.__state().docs; return Object.keys(d).filter(k => k.startsWith(ns + '|pdf_index/')).map(k => ({ key: k, ...d[k] })); }, B.ns);
const jobs = pg => pg.evaluate(ns => { const d = firebase.__state().docs; return Object.keys(d).filter(k => k.startsWith(ns + '|archiv_jobs/')).map(k => d[k]); }, B.ns);
const search = (pg, q, cfgPatch) => pg.evaluate(async ([qq, cp]) => {
  const cfg = Object.assign({}, window.__psArchCfgGetter(), cp || {});
  try { const r = await psIdxSearch(cfg, qq, {}); return { items: r.items.map(e => ({ fileName: e.fileName, uid: e.uid, shopId: e.shopId })) }; } catch (e) { return { error: String(e && (e.code || e.message)) }; }
}, [q, cfgPatch || null]);
const view = pg => pg.evaluate(async () => {
  const div = document.createElement('div'); document.body.appendChild(div);
  ReactDOM.render(React.createElement(ArchivProtokollView, null), div);
  for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 100)); if (!/Lade Archiv-Protokoll/.test(div.textContent)) break; }
  div.querySelectorAll('button[aria-expanded="false"]').forEach(b => b.click());
  await new Promise(r => setTimeout(r, 150));
  const txt = div.textContent; ReactDOM.unmountComponentAtNode(div); div.remove(); return txt;
});

test(`Archivierung v3 E2E – ${BRAND} ${FILE}`, { timeout: 900000 }, async t => {
  const T1 = await tablet(), T2 = await tablet(), T3 = await tablet();
  let mueller;

  await t.test('1: Mitarbeiter A archiviert und findet seine Beratung (erst nach SharePoint-Fund "erfolgreich")', async () => {
    await login(T1.pg, 'uidA');
    fl.storeDelayMs = 1200;
    mueller = await submit(T1.pg, { kennung: 'Mueller', kunde: 'Max Mueller' });
    assert.equal(mueller.ok, true); assert.equal(mueller.status, 'handed');
    assert.match(await view(T1.pg), /Bestätigung ausstehend/);
    await T1.pg.waitForTimeout(1400); await proc(T1.pg);
    const q = await qAll(T1.pg);
    assert.equal(q[0].status, 'verified'); assert.equal(q[0].hasPdf, false); assert.equal(q[0].indexed, true);
    assert.match(await view(T1.pg), /Erfolgreich archiviert[\s\S]*Mueller|Mueller[\s\S]*Erfolgreich archiviert/);
    const s = await search(T1.pg, 'Mueller');
    assert.deepEqual(s.items.map(x => x.fileName), [mueller.name]);
    fl.storeDelayMs = 0;
    await pull(T1.pg);
  });

  await t.test('24: zentrale Statusmeldung (archiv_jobs) ohne Kundendaten', async () => {
    await proc(T1.pg); await pull(T1.pg);
    const j = (await jobs(T1.pg))[0];
    assert.ok(j, 'Monitor-Eintrag vorhanden');
    assert.equal(j.status, 'verified'); assert.equal(j.uid, 'uidA'); assert.equal(j.shopId, SH.X); assert.equal(j.brand, BRAND);
    assert.ok(!/Mueller|PENCIL_|test\.anna/.test(JSON.stringify(j)), 'keine Kundendaten/Dateinamen/E-Mail');
  });

  await t.test('2+12(Sync): Mitarbeiter B (anderes Tablet, gleicher Standort) findet die Beratung von A', async () => {
    await login(T2.pg, 'uidB'); await push(T2.pg);
    const s = await search(T2.pg, 'Mueller');
    assert.deepEqual(s.items.map(x => x.fileName), [mueller.name]);
    const s2 = await search(T2.pg, 'Max Mue');
    assert.equal(s2.items.length, 1, 'Namensanfänge');
  });

  await t.test('4: B ruft die Beratung auf → Mitarbeiterstatistik/Zuordnung bleibt bei A', async () => {
    const before = (await idx(T2.pg)).find(e => e.fileName === mueller.name);
    await search(T2.pg, 'Mueller');
    const after = (await idx(T2.pg)).find(e => e.fileName === mueller.name);
    assert.deepEqual(after, before); assert.equal(after.uid, 'uidA');
    assert.ok(!/Mueller/.test(await view(T2.pg)), '"Meine Archivierungen" von B enthält A nicht');
  });

  await t.test('3: Mitarbeiter C (anderer Standort) findet die Beratung ohne Berechtigung nicht', async () => {
    await login(T3.pg, 'uidC'); await push(T3.pg);
    const s = await search(T3.pg, 'Mueller');
    assert.equal((s.items || []).length, 0, JSON.stringify(s));
    // auch mit gezielter Standortangabe nicht
    const r = await T3.pg.evaluate(async x => (await psIdxSearch(window.__psArchCfgGetter(), 'Mueller', { shop: x })).items.length, SH.X);
    assert.equal(r, 0);
  });

  await t.test('26 (nur Client): manipulierter Standortfilter – Ergebnis ohne Firestore-Regeln NICHT prüfbar', async t2 => {
    // Der Testersatz kennt keine Firestore-Regeln: setzt ein Angreifer cfg.isAdmin=true, liefert er Treffer.
    // Schutz MUSS serverseitig erfolgen (Regelvorschlag docs/ARCHIVIERUNG-V3.md). Dieser Test dokumentiert das.
    const s = await search(T3.pg, 'Mueller', { isAdmin: true, scopeShop: '' });
    t2.diagnostic('Treffer mit manipulierter Konfiguration (Testersatz ohne Regeln): ' + (s.items || []).length);
    assert.ok(true);
  });

  await t.test('5/6: vier Tablets archivieren gleichzeitig dieselbe Kennung → 4 getrennte Dateien/Index-Einträge', async () => {
    const T4 = await tablet();
    await login(T4.pg, 'uidD');
    const pages = [T1.pg, T2.pg, T3.pg, T4.pg];
    const rs = await Promise.all(pages.map(p => submit(p, { kennung: 'keinName' })));
    assert.equal(new Set(rs.map(r => r.name)).size, 4);
    assert.ok(rs.every(r => r.ok && r.status === 'handed'));
    for (const p of pages) { await proc(p); await pull(p); }
    const kn = Object.keys(backend.docs).filter(k => k.startsWith(B.ns + '|pdf_index/') && /keinname/.test(k));
    assert.equal(kn.length, 4, 'kein Überschreiben');
    assert.deepEqual(kn.map(k => backend.docs[k].uid).sort(), ['uidA', 'uidB', 'uidC', 'uidD']);
    assert.ok(rs.every(r => fl.stored.has(sid(r.name))));
    await T4.ctx.close();
  });

  await t.test('7/18: mehrfacher Klick → ein Versand', async () => {
    const n0 = fl.payloads.length;
    const rs = await T1.pg.evaluate(async () => {
      const T = window.__psArchivTest; const datum = PSArchivQueue.localDate(); T.resetTokens();
      const name = T.name('angebot', datum, 'Doppel'); const b = T.betreff('angebot', datum, window.__PS_PROFILE_NAME);
      const blob = new Blob(['%PDF-1.4\n' + 'z'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' });
      const out = await Promise.all([1, 2, 3].map(() => T.submit(blob, name, b, {})));
      return out.map(o => o.archiveId);
    });
    assert.equal(new Set(rs).size, 1); assert.equal(fl.payloads.length - n0, 1);
  });

  await t.test('8/11: Internetausfall → "Lokal gesichert – Versand ausstehend" → Rückkehr → bestätigt', async () => {
    fl.archiveDown = true;
    const r = await submit(T1.pg, { kennung: 'Netzweg', kunde: 'Netz Weg' });
    assert.equal(r.status, 'pending');
    assert.match(await view(T1.pg), /Versand ausstehend|Wiederholungsversuch/);
    fl.archiveDown = false;
    await qUpd(T1.pg, r.archiveId, { nextTryAt: 0, lastTryAt: 0 });
    await proc(T1.pg); await proc(T1.pg);
    assert.equal((await qAll(T1.pg)).find(x => x.id === r.archiveId).status, 'verified');
  });

  await t.test('12: Flow nimmt an, Datei fehlt in SharePoint → nach Frist gleicher Name erneut, kein Schein-Erfolg', async () => {
    const r = await T1.pg.evaluate(async () => {
      const T = window.__psArchivTest; const datum = PSArchivQueue.localDate(); T.resetTokens();
      return T.submit(new Blob(['%PDF-1.4\n' + 'v'.repeat(900) + '\n%%EOF'], { type: 'application/pdf' }), T.name('angebot', datum, 'Verloren'), T.betreff('angebot', datum, window.__PS_PROFILE_NAME), { kunde: 'Verloren' });
    });
    const name = (await qAll(T1.pg)).find(x => x.id === r.archiveId).fileName;
    fl.stored.delete(sid(name)); // Ablage-Kette hat die Datei "verloren"
    await qUpd(T1.pg, r.archiveId, { lastVerifyAt: 0 }); await proc(T1.pg); // Prüfung: nicht gefunden
    assert.equal((await qAll(T1.pg)).find(x => x.id === r.archiveId).status, 'handed');
    const sends0 = fl.payloads.filter(p => p.archiveFileName === name).length;
    await qUpd(T1.pg, r.archiveId, { handedAt: Date.now() - 21 * 60000 }); await proc(T1.pg);
    const sends1 = fl.payloads.filter(p => p.archiveFileName === name).length;
    const dbg = await T1.pg.evaluate(async ([qn, id]) => { const r = await PSArchivQueue.queue(qn).get(id); const { pdfBlob, ...x } = r; return x; }, [QN, r.archiveId]);
    assert.equal(sends1, sends0 + 1, 'erneut gesendet – gleicher Dateiname: ' + JSON.stringify(dbg));
    await qUpd(T1.pg, r.archiveId, { lastVerifyAt: 0 }); await proc(T1.pg);
    assert.equal((await qAll(T1.pg)).find(x => x.id === r.archiveId).status, 'verified');
  });

  await t.test('13: PDF vorhanden, Suchindex fehlt → Selbstreparatur durch das Gerät des Eigentümers', async () => {
    const key = B.ns + '|pdf_index/' + sid(mueller.name);
    await delDoc(T1.pg, key);
    const rec = (await qAll(T1.pg)).find(x => x.fileName === mueller.name);
    await qUpd(T1.pg, rec.id, { indexCheckedAt: 0 });
    await proc(T1.pg);
    const e = (await idx(T1.pg)).find(x => x.fileName === mueller.name);
    assert.ok(e, 'Index-Eintrag wieder da'); assert.equal(e.uid, 'uidA'); assert.equal(e.shopId, SH.X);
    await pull(T1.pg);
  });

  await t.test('16: Prüfdienst gestört → "Bestätigung ausstehend", PDF bleibt, später bestätigt', async () => {
    fl.v3Broken = true;
    const r = await submit(T1.pg, { kennung: 'Pruefung', kunde: 'Pruefung' });
    await qUpd(T1.pg, r.archiveId, { lastVerifyAt: 0 }); await proc(T1.pg);
    let x = (await qAll(T1.pg)).find(y => y.id === r.archiveId);
    assert.equal(x.status, 'handed'); assert.equal(x.hasPdf, true);
    fl.v3Broken = false;
    await T1.pg.evaluate(() => { try { localStorage.removeItem('tps_arch_exists_v1'); } catch (e) {} });
    await qUpd(T1.pg, r.archiveId, { lastVerifyAt: 0 }); await proc(T1.pg);
    x = (await qAll(T1.pg)).find(y => y.id === r.archiveId);
    assert.equal(x.status, 'verified');
  });

  await t.test('30: Prüfflow kennt "exists" nicht → KEINE vorgetäuschte Bestätigung; Telekom merkt sich das (schont den Flow)', async () => {
    fl.v3NoExists = true;
    await T1.pg.evaluate(() => { try { localStorage.removeItem('tps_arch_exists_v1'); } catch (e) {} });
    const r = await submit(T1.pg, { kennung: 'OhneExists', kunde: 'Ohne Exists' });
    await qUpd(T1.pg, r.archiveId, { lastVerifyAt: 0 }); await proc(T1.pg);
    let x = (await qAll(T1.pg)).find(y => y.id === r.archiveId);
    assert.equal(x.status, 'handed', 'nur "übergeben", nicht "erfolgreich"'); assert.equal(x.hasPdf, true);
    assert.match(await view(T1.pg), /Bestätigung ausstehend/);
    if (BRAND === 'telekom') {
      const st = await T1.pg.evaluate(() => JSON.parse(localStorage.getItem('tps_arch_exists_v1') || 'null'));
      assert.equal(st && st.ok, false, 'Flow-Fähigkeit "nein" gemerkt');
      const n0 = fl.v3Calls.filter(a => a === 'exists').length;
      await qUpd(T1.pg, r.archiveId, { lastVerifyAt: 0 }); await proc(T1.pg);
      assert.equal(fl.v3Calls.filter(a => a === 'exists').length, n0, 'innerhalb 1 h kein erneuter exists-Aufruf');
    }
    // Flow wird aktualisiert (Aktion exists vorhanden) → Bestätigung kommt automatisch, ohne neue App-Version
    fl.v3NoExists = false;
    await T1.pg.evaluate(() => { try { localStorage.removeItem('tps_arch_exists_v1'); } catch (e) {} });
    await qUpd(T1.pg, r.archiveId, { lastVerifyAt: 0 }); await proc(T1.pg);
    x = (await qAll(T1.pg)).find(y => y.id === r.archiveId);
    assert.equal(x.status, 'verified');
    if (BRAND === 'telekom') assert.equal((await T1.pg.evaluate(() => JSON.parse(localStorage.getItem('tps_arch_exists_v1') || 'null'))).ok, true);
  });

  await t.test('17: unbestätigt > 7 Tage → nicht gelöscht, Warnhinweis + Eskalation sichtbar', async () => {
    fl.v3Broken = true;
    const r = await submit(T1.pg, { kennung: 'Alt', kunde: 'Alt Kunde' });
    await qBackdate(T1.pg, r.archiveId, { createdAt: Date.now() - 8 * 86400000, handedAt: Date.now() - 8 * 86400000, lastVerifyAt: 0 });
    await proc(T1.pg);
    const x = (await qAll(T1.pg)).find(y => y.id === r.archiveId);
    assert.equal(x.hasPdf, true, 'PDF bleibt');
    const v = await view(T1.pg);
    assert.match(v, /seit über 3 Tagen offen/); assert.match(v, /nie automatisch gelöscht/);
    fl.v3Broken = false;
  });

  await t.test('23: unvollständige / beschädigte PDF → nicht gesendet, Vorgang bleibt offen', async () => {
    const n0 = fl.payloads.length;
    const a = await submit(T1.pg, { kennung: 'Kaputt1', pdf: false });
    const b = await submit(T1.pg, { kennung: 'Kaputt2', broken: 'truncated' });
    assert.equal(a.ok, false); assert.equal(b.ok, false); assert.equal(fl.payloads.length, n0);
  });

  await t.test('23b: echte PDF aus html2pdf (wie Archiv-PDF) besteht die Prüfung (kein Fehlalarm)', async () => {
    const r = await T1.pg.evaluate(async () => {
      if (!window.html2pdf) return { skip: true };
      const el = document.createElement('div'); el.innerHTML = '<h1>Synthetisch</h1><p>Testinhalt ' + 'x'.repeat(300) + '</p>'; document.body.appendChild(el);
      const blob = await window.html2pdf().set({ jsPDF: { compress: true } }).from(el).outputPdf('blob');
      el.remove();
      return { c: await PSArchivQueue.checkPdf(blob), size: blob.size };
    });
    if (r.skip) return;
    assert.equal(r.c.ok, true, JSON.stringify(r));
  });

  await t.test('20: Springer wechselt den Standort → findet Archivierungen des neuen Standorts; eigene bleiben sichtbar', async () => {
    await login(T3.pg, 'uidS'); // Springer, Heimat = Y
    await push(T3.pg);
    const own = await submit(T3.pg, { kennung: 'Weber', kunde: 'Weber' });
    assert.ok(own.ok);
    await proc(T3.pg); await pull(T3.pg);
    assert.equal((await search(T3.pg, 'Mueller')).items.length, 0, 'in Y nicht');
    await T3.pg.evaluate(x => localStorage.setItem('ps_shop', x), SH.X);
    if (BRAND === 'telekom') await T3.pg.evaluate(x => localStorage.setItem('tps_shop', x), SH.X);
    await T3.pg.reload();
    await T3.pg.waitForFunction(x => window.__PS_SHOP_ORT === x && window.__psArchivQueueDeps, SH.X, { timeout: 40000 });
    await push(T3.pg);
    assert.deepEqual((await search(T3.pg, 'Mueller')).items.map(x => x.fileName), [mueller.name], 'in X gefunden');
    assert.match(await view(T3.pg), /Weber/, 'eigene Archivierung aus Y weiter sichtbar');
    const e = (await idx(T3.pg)).find(x => x.fileName === own.name);
    assert.equal(e.shopId, SH.Y, 'Zuordnung bleibt beim Standort der Archivierung');
  });

  await t.test('28: Standortwechsel während ausstehender Archivierung → Standort/Mitarbeiter unverändert', async () => {
    fl.archiveDown = true;
    const r = await submit(T3.pg, { kennung: 'Wechsel', kunde: 'Wechsel' });
    assert.equal(r.status, 'pending');
    await T3.pg.evaluate(x => { localStorage.setItem('ps_shop', x); localStorage.setItem('tps_shop', x); }, SH.Y);
    await T3.pg.reload();
    await T3.pg.waitForFunction(x => window.__PS_SHOP_ORT === x && window.__psArchivQueueDeps, SH.Y, { timeout: 40000 });
    fl.archiveDown = false;
    await qUpd(T3.pg, r.archiveId, { nextTryAt: 0 }); await proc(T3.pg);
    const x = (await qAll(T3.pg)).find(y => y.id === r.archiveId);
    assert.equal(x.shopId, SH.X); assert.equal(x.uid, 'uidS'); assert.ok(['handed', 'verified'].includes(x.status));
    const p = fl.payloads.find(y => y.archiveFileName === x.fileName);
    assert.ok(p && String(p.shop).toLowerCase().includes(String(SH.X).split('-').pop()), 'Flow bekommt den ursprünglichen Standort: ' + (p && p.shop));
  });

  await t.test('Verwerfen nur mit Grund, protokolliert, im Monitor als "verworfen"', async () => {
    fl.archiveDown = true;
    const r = await submit(T1.pg, { kennung: 'Verwerfen', kunde: 'Verwerfen' });
    fl.archiveDown = false;
    await qUpd(T1.pg, r.archiveId, { status: 'failed' });
    await T1.pg.evaluate(() => { window.__p = window.prompt; window.__c = window.confirm; window.prompt = () => 'Kunde hat abgesagt'; window.confirm = () => true; });
    await T1.pg.evaluate(() => { const d = document.createElement('div'); d.id = 'avx'; document.body.appendChild(d); ReactDOM.render(React.createElement(ArchivProtokollView, null), d); });
    await T1.pg.waitForFunction(() => !/Lade Archiv-Protokoll/.test(document.getElementById('avx').textContent), null, { timeout: 15000 });
    await T1.pg.evaluate(() => document.querySelectorAll('#avx button[aria-expanded="false"]').forEach(b => b.click()));
    await T1.pg.click('#avx button:has-text("Verwerfen")');
    let st = '';
    for (let i = 0; i < 50 && st !== 'discarded'; i++) { await T1.pg.waitForTimeout(200); st = (await qAll(T1.pg)).find(x => x.id === r.archiveId).status; }
    assert.equal(st, 'discarded');
    await T1.pg.evaluate(() => { window.prompt = window.__p; window.confirm = window.__c; ReactDOM.unmountComponentAtNode(document.getElementById('avx')); });
    const log = await T1.pg.evaluate(() => PSArchivQueue.readLog().filter(l => l.step === 'discard').map(l => l.code));
    assert.ok(log.some(c => /^owner:Kunde hat abgesagt/.test(c)), JSON.stringify(log));
    await proc(T1.pg); await pull(T1.pg);
    assert.equal(backend.docs[B.ns + '|archiv_jobs/' + r.archiveId].status, 'discarded');
  });

  await t.test('27: zentraler Archivierungsmonitor (Admin) – Kennzahlen und Quote', async () => {
    for (const p of [T1.pg, T2.pg, T3.pg]) { await proc(p); await pull(p); }
    const TA = await tablet();
    await login(TA.pg, 'uidAdm'); await push(TA.pg);
    await TA.pg.evaluate(() => { const d = document.createElement('div'); d.id = 'diag'; document.body.appendChild(d); ReactDOM.render(React.createElement(PsArchivDiagnose, { onClose: () => {} }), d); });
    await TA.pg.click('button:has-text("Suchindex analysieren")');
    await TA.pg.waitForSelector('text=Alte Dateinamen ohne Kennzeichen', { timeout: 15000 });
    await TA.pg.click('button:has-text("Mit SharePoint abgleichen")');
    await TA.pg.waitForSelector('text=PDF in SharePoint nicht gefunden', { timeout: 20000 });
    await TA.pg.click('button:has-text("Monitor laden")');
    await TA.pg.waitForSelector('text=Archivierungsquote', { timeout: 15000 });
    const txt = await TA.pg.evaluate(() => document.getElementById('diag').textContent);
    const all = Object.keys(backend.docs).filter(k => k.startsWith(B.ns + '|archiv_jobs/')).map(k => backend.docs[k]);
    const ver = all.filter(j => j.status === 'verified').length;
    const exp = (Math.round(ver / all.length * 1000) / 10).toLocaleString('de-DE') + ' %';
    assert.ok(txt.includes('Archivierungsquote' + exp), 'Quote ' + exp + ' (' + ver + '/' + all.length + ') in: ' + txt.slice(txt.indexOf('Aufträge'), txt.indexOf('Aufträge') + 300));
    assert.match(txt, /Abgleich Auftrag/);
    assert.deepEqual(TA.pg.errs, [], 'Skriptfehler Admin');
    await TA.ctx.close();
  });

  await t.test('22: IndexedDB nicht nutzbar → Direktversand, ehrlich "übergeben", kein "erfolgreich"', async () => {
    const T5 = await tablet();
    await T5.ctx.addInitScript(() => { const o = indexedDB.open.bind(indexedDB); indexedDB.open = (n, v) => (/ArchivQueue/.test(n) ? (() => { throw new Error('IDB kaputt (Test)'); })() : o(n, v)); });
    await login(T5.pg, 'uidB');
    const r = await submit(T5.pg, { kennung: 'OhneIDB', kunde: 'Ohne IDB' });
    assert.equal(r.ok, true); assert.equal(r.status, 'handed'); assert.notEqual(r.status, 'verified');
    assert.ok(fl.payloads.some(p => p.archiveFileName === r.name));
    await T5.ctx.close();
  });

  await t.test('21: Service Worker – neue Cache-Version, Modul im Cache, alte Caches gelöscht', async () => {
    const T6 = await tablet();
    await T6.pg.goto(srv.url + '/' + FILE);
    const r = await T6.pg.evaluate(async () => {
      await caches.open('pencil-o2-v1'); await caches.open('pencil-tcr-v1');
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 50 && !(reg.active && reg.active.state === 'activated'); i++) await new Promise(x => setTimeout(x, 100));
      const keys = await caches.keys();
      const own = keys.find(k => /^pencil-(o2|tcr)-v\d+$/.test(k) && !/-v1$/.test(k));
      const c = await caches.open(own);
      return { keys, mod: !!(await c.match('archive-queue.js?v=3')) };
    });
    assert.ok(r.mod, 'archive-queue.js?v=3 vorab im Cache: ' + r.keys);
    assert.ok(!r.keys.includes(BRAND === 'telekom' ? 'pencil-tcr-v1' : 'pencil-o2-v1'), 'alter eigener Cache entfernt: ' + r.keys);
    await T6.ctx.close();
  });

  await t.test('29: Smart Capture (nur Hall, index-neu.html) – QR packen → Bild → lesen → entpacken unverändert', async t2 => {
    if (FILE !== 'index-neu.html') return t2.skip('nur Hall-Testversion');
    const r = await T1.pg.evaluate(async () => {
      const d = { tarife: [{ name: 'O2 Mobile M', art: 'tarif', t: 2999 }], geraete: [{ name: 'Pixel 9', art: 'geraet', am: '1,00' }], internet: [], einmalig: '1,00', monatlich: '29,99', hinweis: '' };
      const shop = window.__PS_SHOP_ORT;
      const txt = await psO2QrPack(d, shop, true);
      await psO2LoadLib('vendor/qrcode.js', 'x'); await psO2LoadLib('vendor/jsQR.js', 'x');
      const q = qrcode(0, 'L'); q.addData(txt); q.make();
      const n = q.getModuleCount(), sc = 4, pad = 4 * sc, W = n * sc + 2 * pad;
      const c = document.createElement('canvas'); c.width = c.height = W; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, W); g.fillStyle = '#000';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect(pad + x * sc, pad + y * sc, sc, sc);
      const img = g.getImageData(0, 0, W, W);
      const code = jsQR(img.data, W, W);
      const back = code ? await psO2QrUnpack(code.data, shop) : { err: 'nicht gelesen' };
      const foreign = await psO2QrUnpack(txt, 'anderer-shop');
      return { same: code && code.data === txt, tarif: back.d && back.d.tarife[0].name, ok: back.ok, foreignErr: !!foreign.err, scan: typeof psO2QrScan === 'function', show: typeof psO2QrShow === 'function' };
    });
    assert.deepEqual(r, { same: true, tarif: 'O2 Mobile M', ok: true, foreignErr: true, scan: true, show: true });
  });

  await t.test('Keine Skriptfehler auf den Tablets', async () => {
    for (const T of [T1, T2, T3]) assert.deepEqual(T.pg.errs, []);
  });
  for (const T of [T1, T2, T3]) await T.ctx.close();
});
