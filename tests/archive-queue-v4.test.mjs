// Archiv-Ausgang v3 – Testmatrix (Modulebene, synthetische Daten, Flow-/SharePoint-/Firestore-ATTRAPPEN).
// Nummern = Szenarien aus dem Auftrag (Abschnitt 17). Browser-Szenarien (Suche, Rechte, UI) stehen in tests/e2e/.
// Aufruf:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(pathToFileURL(path.join(ROOT, 'archive-queue.js')).href);
const Q = globalThis.PSArchivQueue;
const S = Q.STATUS;
const H = 3600000, D = 86400000;

const pdf = (n = 1200) => new Blob(['%PDF-1.4\n' + 'x'.repeat(n) + '\n%%EOF'], { type: 'application/pdf' });
function clock(start = Date.UTC(2026, 10, 28, 10, 0, 0)) { const c = { t: start }; c.now = () => c.t; c.adv = ms => { c.t += ms; }; return c; }
const NAME = (kenn, shop = 'Aalen', typ = 'Angebot', tok = '1000abc') => Q.uniqueFileName(`PENCIL_${kenn}_${shop}_${typ}_2026-11-28.pdf`, tok);
function rec(over = {}) {
  return { uid: 'uidA', email: 'a.test@hetec-gmbh.de', employeeName: 'Anna Test', shopId: 'crailsheim', type: 'angebot', fileName: NAME('Mueller', 'Crailsheim'), subject: 'PENCIL|angebot|2026-11-28|Anna', agent: 'Anna', kunde: 'Max Mueller', ruf: '', pdfBlob: pdf(), ...over };
}
/** Gemeinsame Attrappe: "SharePoint" (Set) + "Suchindex" (Map) wie das zentrale Backend, für mehrere Tablets. */
function backend() {
  const sp = new Set(), index = new Map(), backupIdx = new Map(), jobs = new Map(), sent = [];
  let spMeta = null; // v4: Map(id → {size, sha256}) – simuliert einen Prüfdienst, der Größe/Prüfsumme liefert
  let spDown = false, fbDown = false, sendFail = 0, verifyMode = 'ok', dropOnStore = false;
  const b = {
    sp, index, backupIdx, jobs, sent, setMeta: m => { spMeta = m; },
    set: o => { if ('spDown' in o) spDown = o.spDown; if ('fbDown' in o) fbDown = o.fbDown; if ('sendFail' in o) sendFail = o.sendFail; if ('verifyMode' in o) verifyMode = o.verifyMode; if ('dropOnStore' in o) dropOnStore = o.dropOnStore; },
    deps: (uid, online = () => true) => ({
      uid, online,
      send: async r => { if (sendFail > 0) { sendFail--; return { ok: false, code: 'timeout' }; } sent.push(r.fileName); if (!dropOnStore) sp.add(Q.idOf(r.fileName)); return { ok: true }; },
      verify: async names => {
        if (spDown || verifyMode === 'unavailable') return { available: false, found: new Set() };
        return { available: true, found: new Set(names.map(Q.idOf).filter(n => sp.has(n))), meta: spMeta || undefined };
      },
      // wie psIdxRecordArchive: Suchindex schreiben + unveränderliche Sicherung (nur anlegen, nie überschreiben)
      recordIndex: async r => {
        if (fbDown) return false;
        const e = { uid: r.uid, shopId: r.shopId, fileName: r.fileName, keys: r.kunde ? ['n:' + r.kunde.slice(0, 3).toLowerCase()] : [] };
        index.set(Q.idOf(r.fileName), e);
        if (!backupIdx.has(Q.idOf(r.fileName))) backupIdx.set(Q.idOf(r.fileName), { ...e });
        return true;
      },
      indexCheck: async r => {
        if (fbDown) return null;
        const e = index.get(Q.idOf(r.fileName));
        return { exists: !!e, uid: e && e.uid, shopId: e && e.shopId, searchable: !e || e.keys.length > 0 || !r.kunde, backup: backupIdx.has(Q.idOf(r.fileName)) };
      },
      restoreIndex: async r => { if (fbDown) return false; const b = backupIdx.get(Q.idOf(r.fileName)); if (!b) return false; index.set(Q.idOf(r.fileName), { ...b }); return true; },
      syncJob: async s => { if (fbDown) return false; jobs.set(s.archiveId, { ...s, syncedAt: Date.now() }); return true; }
    })
  };
  return b;
}
const mkQ = (c, store) => Q.createQueue({ store: store || Q.memoryStore(), now: c.now, useLocks: false, random: () => 0.5 });

test('Modul v3/v4: Grundwerte, keine Altersgrenze für unbestätigte PDFs mehr', () => {
  assert.equal(Q.SCHEMA_VERSION, 4);
  assert.equal('keepUnverifiablePdfMs' in Q.POLICY, false, '7-Tage-Löschregel entfernt');
  assert.equal(S.DISCARDED, 'discarded');
  const h = { status: S.HANDED, handedAt: 0, verifyAvailable: false, pdfBlob: pdf(), lastVerifyAt: 0 };
  for (const age of [8 * D, 90 * D, 400 * D]) assert.notEqual(Q.nextAction(h, age), 'purgePdf');
  assert.equal(Q.nextAction({ ...h, status: S.PENDING, nextTryAt: 0 }, 400 * D), 'send');
  assert.equal(Q.nextAction({ status: S.FAILED, createdAt: 0, pdfBlob: pdf() }, 400 * D), 'wait', 'fehlgeschlagen: nie automatisch löschen');
});

test('1: Mitarbeiter A archiviert → bestätigt, Index mit uid A + Standort, Metadaten vollständig', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec({ consultationId: 'b-123' }));
  for (const k of ['archiveId', 'consultationId', 'uid', 'employeeName', 'shopId', 'createdByUserId', 'createdAt', 'archivedAt', 'fileName', 'documentType', 'archiveStatus', 'documentVersion', 'retryCount', 'fileSize', 'checksum', 'fileKey']) assert.ok(r[k] !== undefined && r[k] !== '', 'Feld ' + k);
  assert.match(r.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.fileSize, r.pdfBlob.size);
  await q.sendNow(r.archiveId, be.deps('uidA'));
  c.adv(61000); await q.process(be.deps('uidA'));
  const v = await q.get(r.archiveId);
  assert.equal(v.status, S.VERIFIED); assert.ok(v.verifiedAt >= v.createdAt); assert.ok(v.durationMs >= 0);
  assert.equal(v.complete, true, 'v4: vollständig (Datei + Suchindex + Zuordnung)'); assert.equal(v.backup, true);
  assert.deepEqual(be.index.get(Q.idOf(r.fileName)), { uid: 'uidA', shopId: 'crailsheim', fileName: r.fileName, keys: ['n:max'] });
  assert.equal(v.lastError, '');
});

test('4/28: Zuordnung unveränderlich – Aufruf durch B oder Standortwechsel ändert Mitarbeiter/Standort nie', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, be.deps('uidA', () => false)); // ausstehend
  await q.update(r.archiveId, { uid: 'uidB', employeeName: 'Bernd', shopId: 'aalen', createdByUserId: 'uidB', fileKey: 'x', checksum: 'y', fileSize: 1 });
  const g = await q.get(r.archiveId);
  assert.deepEqual([g.uid, g.employeeName, g.shopId, g.createdByUserId, g.fileKey, g.checksum, g.fileSize], ['uidA', 'Anna Test', 'crailsheim', 'uidA', r.fileKey, r.checksum, r.fileSize]);
  // Mitarbeiter A wechselt (Springer) den Standort, Vorgang wird unter B nachgesendet
  c.adv(31000); await q.process(be.deps('uidB'));
  const h = await q.get(r.archiveId);
  assert.equal(h.status, S.HANDED); assert.equal(h.shopId, 'crailsheim'); assert.equal(h.uid, 'uidA');
  assert.equal(be.index.size, 0, 'B schreibt keinen Index für A');
});

test('5: vier Tablets archivieren gleichzeitig denselben Kunden (gleicher Shop/Tag/Minute) → 4 getrennte Archivierungen', async () => {
  const c = clock(); const be = backend();
  const tabs = ['uidA', 'uidB', 'uidC', 'uidD'].map(u => ({ u, q: Q.createQueue({ store: Q.memoryStore(), now: c.now, useLocks: false }) }));
  const recs = await Promise.all(tabs.map(t => t.q.create(rec({ uid: t.u, employeeName: t.u, fileName: Q.uniqueFileName('PENCIL_keinName_Crailsheim_Angebot_2026-11-28.pdf', Q.makeToken(c.now())) }))));
  assert.equal(new Set(recs.map(r => r.fileName)).size, 4, 'Dateinamen verschieden');
  assert.equal(new Set(recs.map(r => r.archiveId)).size, 4);
  await Promise.all(tabs.map((t, i) => t.q.sendNow(recs[i].archiveId, be.deps(t.u))));
  c.adv(61000);
  await Promise.all(tabs.map(t => t.q.process(be.deps(t.u))));
  assert.equal(be.sp.size, 4); assert.equal(be.index.size, 4, 'kein Index-Eintrag überschrieben');
  assert.deepEqual([...be.index.values()].map(x => x.uid).sort(), ['uidA', 'uidB', 'uidC', 'uidD']);
  for (const t of tabs) assert.ok((await t.q.all()).every(x => x.status === S.VERIFIED));
});

test('5b: Kennzeichen-Kollisionen – 4 Tablets × 50 Archivierungen in derselben Minute', () => {
  const t0 = Date.UTC(2026, 10, 28, 10, 0);
  const names = new Set();
  for (let i = 0; i < 200; i++) names.add(Q.uniqueFileName('PENCIL_keinName_Crailsheim_Angebot_2026-11-28.pdf', Q.makeToken(t0)));
  assert.equal(names.size, 200, 'v4: 8 Zufallszeichen');
});

test('6: zwei Mitarbeiter, dieselbe Kundenkennung/Nummer → zwei getrennte Archivierungen mit eigener Zuordnung', async () => {
  const c = clock(); const be = backend(); const qA = mkQ(c), qB = mkQ(c);
  const base = 'PENCIL_017612345678_Crailsheim_Abschluss_2026-11-28.pdf';
  const a = await qA.create(rec({ type: 'abschluss', subject: 'PENCIL|abschluss|2026-11-28|Anna', fileName: Q.uniqueFileName(base, Q.makeToken(c.now())) }));
  const b = await qB.create(rec({ uid: 'uidB', employeeName: 'Bernd', type: 'abschluss', subject: 'PENCIL|abschluss|2026-11-28|Bernd', fileName: Q.uniqueFileName(base, Q.makeToken(c.now())) }));
  assert.notEqual(a.fileName, b.fileName);
  await qA.sendNow(a.archiveId, be.deps('uidA')); await qB.sendNow(b.archiveId, be.deps('uidB'));
  assert.equal(be.index.get(Q.idOf(a.fileName)).uid, 'uidA'); assert.equal(be.index.get(Q.idOf(b.fileName)).uid, 'uidB');
});

test('7/18: mehrfacher Klick + Wiederholungsversand → ein Eintrag, immer derselbe Dateiname, keine Dubletten', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => q.create(rec())));
  assert.equal((await q.all()).length, 1);
  assert.equal(new Set(all.map(x => x.archiveId)).size, 1);
  be.set({ dropOnStore: true }); // Flow nimmt an, Datei kommt aber nicht an
  await Promise.all([q.sendNow(all[0].archiveId, be.deps('uidA')), q.sendNow(all[0].archiveId, be.deps('uidA'))]);
  assert.equal(be.sent.length, 1, 'paralleler Doppelversand verhindert');
  for (let i = 0; i < 80; i++) { c.adv(61000); await q.process(be.deps('uidA')); }
  assert.equal(be.sent.length, 3); assert.equal(new Set(be.sent).size, 1, 'idempotent: gleicher Name');
});

test('8: Internetausfall während der Archivierung → lokal gesichert, Rückkehr der Verbindung → sofort gesendet', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  let on = false;
  const r = await q.create(rec());
  const p = await q.sendNow(r.archiveId, be.deps('uidA', () => on));
  assert.equal(p.status, S.PENDING); assert.equal(p.errorKind, 'offline'); assert.ok(p.pdfBlob);
  assert.equal(be.sent.length, 0, 'offline: kein Netzaufruf');
  on = true; c.adv(1000); // Verbindung zurück – nicht erst Backoff abwarten
  await q.process(be.deps('uidA', () => on));
  assert.equal((await q.get(r.archiveId)).status, S.HANDED);
});

test('9/10: App geschlossen / Tablet neu gestartet während "läuft" → neue Instanz auf gleichem Speicher setzt fort', async () => {
  const c = clock(); const be = backend(); const store = Q.memoryStore();
  const q1 = mkQ(c, store);
  const r = await q1.create(rec()); // Absturz direkt nach dem lokalen Sichern
  const q2 = mkQ(c, store); // "Neustart"
  await q2.process(be.deps('uidA'));
  assert.equal(be.sent.length, 0, 'frisch "läuft" → nicht doppelt');
  c.adv(3 * 60000 + 1000); await q2.process(be.deps('uidA'));
  assert.equal((await q2.get(r.archiveId)).status, S.HANDED);
  c.adv(61000); await q2.process(be.deps('uidA'));
  assert.equal((await q2.get(r.archiveId)).status, S.VERIFIED);
});

test('11: Power Automate antwortet verspätet (Zeitlimit) → ausstehend mit Backoff, dann übergeben', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  be.set({ sendFail: 1 });
  const r = await q.create(rec());
  const p = await q.sendNow(r.archiveId, be.deps('uidA'));
  assert.equal(p.status, S.PENDING); assert.equal(p.lastError, 'timeout'); assert.equal(p.errorKind, 'temporary');
  assert.equal(p.nextTryAt - p.lastTryAt, 30000, 'erster Backoff 30 s (Jitter neutral)');
  c.adv(30001); await q.process(be.deps('uidA'));
  assert.equal((await q.get(r.archiveId)).status, S.HANDED);
});

test('12: Flow nimmt an, SharePoint-Datei fehlt → nach Frist erneut (gleicher Name), max. 3×, dann fehlgeschlagen – PDF bleibt', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  be.set({ dropOnStore: true });
  const events = [];
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, be.deps('uidA'));
  for (let i = 0; i < 90; i++) { c.adv(61000); await q.process({ ...be.deps('uidA'), onEvent: e => events.push(e.type) }); }
  const f = await q.get(r.archiveId);
  assert.equal(f.status, S.FAILED); assert.equal(f.lastError, 'not-found-in-archive'); assert.equal(f.errorKind, 'admin');
  assert.ok(f.pdfBlob); assert.ok(events.includes('failed'));
  assert.equal(be.sent.length, 3);
  // manuell erneut, Ablage klappt jetzt
  be.set({ dropOnStore: false });
  await q.retry(r.archiveId, { uid: 'uidA' });
  await q.process(be.deps('uidA')); c.adv(61000); await q.process(be.deps('uidA'));
  assert.equal((await q.get(r.archiveId)).status, S.VERIFIED);
});

test('12b: Prüfdienst kurzzeitig gestört (keine Antwort) → KEIN Neuversand ohne echtes "nicht gefunden"', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec());
  be.set({ dropOnStore: true });
  await q.sendNow(r.archiveId, be.deps('uidA'));
  c.adv(61000); await q.process(be.deps('uidA')); // einmal erfolgreich geprüft (nicht gefunden) → verifyAvailable=true
  be.set({ spDown: true });
  for (let i = 0; i < 40; i++) { c.adv(61000); await q.process(be.deps('uidA')); }
  assert.equal(be.sent.length, 1, 'Störung des Prüfdienstes ≠ Datei fehlt');
  assert.equal((await q.get(r.archiveId)).status, S.HANDED);
});

test('13: PDF vorhanden, Suchindex fehlt → Wiederherstellung aus der zentralen Sicherung (auch durch Kollegen-Tablet)', async () => {
  const c = clock(); const be = backend(); const store = Q.memoryStore(); const q = mkQ(c, store);
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, be.deps('uidA')); c.adv(61000); await q.process(be.deps('uidA'));
  let x = await q.get(r.archiveId);
  assert.equal(x.complete, true); assert.equal(x.kunde, '', 'erst nach Sicherung minimiert');
  be.index.delete(Q.idOf(r.fileName)); // Index-Eintrag weg (gelöscht/überschrieben)
  c.adv(7 * H);
  // Wiederherstellung läuft auch unter Anmeldung eines Kollegen am selben Gerät – mit den ORIGINALDATEN aus der Sicherung
  const st = await q.process(be.deps('uidB'));
  assert.equal(st.indexRepaired, 1);
  assert.deepEqual(be.index.get(Q.idOf(r.fileName)), be.backupIdx.get(Q.idOf(r.fileName)));
  assert.equal(be.index.get(Q.idOf(r.fileName)).uid, 'uidA'); assert.deepEqual(be.index.get(Q.idOf(r.fileName)).keys, ['n:max'], 'Name bleibt suchbar, obwohl lokal entfernt');
  x = await q.get(r.archiveId); assert.equal(x.complete, true, 'nach Reparatur sofort nachgeprüft: wieder vollständig'); assert.equal(x.indexIssue, '');
  assert.ok(Q.readLog().some(l => l.step === 'index-repair' && l.archiveId === r.archiveId && l.code === 'backup:missing'));
});

test('13b: Suchindex mit falschem Standort / falschem Mitarbeiter → nicht vollständig, aus Sicherung korrigiert', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, be.deps('uidA')); c.adv(61000); await q.process(be.deps('uidA'));
  be.index.set(Q.idOf(r.fileName), { ...be.index.get(Q.idOf(r.fileName)), shopId: 'aalen' });
  c.adv(7 * H); await q.process(be.deps('uidA'));
  assert.ok(Q.readLog().some(l => l.step === 'index-repair' && l.archiveId === r.archiveId && l.code === 'backup:wrong-shop'));
  assert.equal(be.index.get(Q.idOf(r.fileName)).shopId, 'crailsheim'); assert.equal((await q.get(r.archiveId)).complete, true);
  be.index.set(Q.idOf(r.fileName), { ...be.index.get(Q.idOf(r.fileName)), uid: 'uidX' });
  c.adv(7 * H); await q.process(be.deps('uidA'));
  assert.ok(Q.readLog().some(l => l.step === 'index-repair' && l.archiveId === r.archiveId && l.code === 'backup:wrong-employee'));
  assert.equal(be.index.get(Q.idOf(r.fileName)).uid, 'uidA');
  // ohne Sicherung wird eine fremde Zuordnung NICHT aus lokalen Angaben überschrieben
  be.backupIdx.delete(Q.idOf(r.fileName));
  be.index.set(Q.idOf(r.fileName), { ...be.index.get(Q.idOf(r.fileName)), uid: 'uidX' });
  c.adv(7 * H); await q.process(be.deps('uidA'));
  assert.equal(be.index.get(Q.idOf(r.fileName)).uid, 'uidX'); const z = await q.get(r.archiveId);
  assert.equal(z.complete, false); assert.equal(z.indexIssue, 'wrong-employee');
});

test('V4: "In SharePoint abgelegt" ≠ "vollständig archiviert" – ohne Suchindex keine Erfolgsquote', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec());
  const d = { ...be.deps('uidA'), recordIndex: async () => false, restoreIndex: async () => false }; // Index lässt sich nicht schreiben
  await q.sendNow(r.archiveId, d); c.adv(61000); await q.process(d);
  const x = await q.get(r.archiveId);
  assert.equal(x.status, S.VERIFIED); assert.equal(x.complete, false); assert.equal(x.indexIssue, 'missing');
  assert.ok(x.kunde, 'Kundendaten bleiben lokal, bis die Reparatur gelingt');
  const m = Q.computeMetrics([Q.jobSummary(x)]);
  assert.equal(m.verified, 1); assert.equal(m.complete, 0); assert.equal(m.rate, 0); assert.equal(m.fileRate, 1);
  c.adv(3 * H);
  assert.ok((await q.alerts('uidA')).some(a => a.code === 'not-complete'));
  // verifyNow (Anzeige direkt nach dem Archivieren) meldet erst nach Indexprüfung "vollständig"
  const r2 = await q.create(rec({ fileName: NAME('Neu', 'Crailsheim', 'Angebot', '1111abcdefgh') }));
  await q.sendNow(r2.archiveId, be.deps('uidA'));
  const y = await q.verifyNow(r2.archiveId, be.deps('uidA'));
  assert.equal(y.status, S.VERIFIED); assert.equal(y.complete, true);
});

test('5 (Integrität): Dateigröße / SHA-256 vom Prüfdienst müssen zur gesendeten PDF passen', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const mk = async (kenn, meta) => {
    const r = await q.create(rec({ fileName: NAME(kenn, 'Crailsheim', 'Angebot', '1200' + kenn.toLowerCase().padEnd(8, 'x').slice(0, 8)) }));
    be.setMeta(new Map([[Q.idOf(r.fileName), meta(r)]]));
    await q.sendNow(r.archiveId, be.deps('uidA')); c.adv(61000); await q.process(be.deps('uidA'));
    return q.get(r.archiveId);
  };
  let x = await mk('Gross', r => ({ size: r.fileSize }));
  assert.equal(x.integrity, 'size'); assert.equal(x.status, S.VERIFIED);
  x = await mk('Sha', r => ({ size: r.fileSize, sha256: r.checksum.slice(7).toUpperCase() }));
  assert.equal(x.integrity, 'sha256');
  x = await mk('Falsch', r => ({ size: r.fileSize + 1 }));
  assert.equal(x.status, S.FAILED); assert.equal(x.integrity, 'mismatch'); assert.equal(x.errorKind, 'admin'); assert.ok(x.pdfBlob, 'PDF bleibt für Nachweis/erneuten Versand');
  x = await mk('Shafalsch', r => ({ size: r.fileSize, sha256: 'ab'.repeat(32) }));
  assert.equal(x.integrity, 'mismatch');
  be.setMeta(null);
  x = await mk('Name', () => null);
  assert.equal(x.integrity, 'name', 'Prüfdienst liefert nur Namen → ehrlich als "nur Name" gekennzeichnet');
  assert.equal(Q.judgeIntegrity({ fileSize: 10, checksum: 'sha256:aa' }, { size: 10 }), 'size');
});

test('7: Kennzeichen mit 8 Zufallszeichen – 4 Tablets × 5.000 Archivierungen in derselben Minute ohne Kollision', () => {
  const t0 = Date.UTC(2026, 10, 28, 10, 0);
  const tk = Q.makeToken(t0);
  assert.match(tk, /^\d{4}[0-9a-z]{8}$/);
  const f = Q.uniqueFileName('PENCIL_keinName_Crailsheim_Angebot_2026-11-28.pdf', tk);
  assert.equal(f.replace(/\.pdf$/, '').split('_').length, 5, 'Flow-Teile unverändert (kein zusätzliches "_")');
  assert.equal(Q.fileToken(f), tk);
  assert.equal(Q.kennungOf(f), 'keinName');
  const names = new Set();
  for (let i = 0; i < 20000; i++) names.add(Q.uniqueFileName('PENCIL_keinName_Crailsheim_Angebot_2026-11-28.pdf', Q.makeToken(t0)));
  assert.equal(names.size, 20000);
  // Altnamen mit 3er-Kennzeichen bleiben lesbar
  assert.equal(Q.fileToken('PENCIL_Mueller--1415k7q_Aalen_Angebot_2026-11-27.pdf'), '1415k7q');
});

test('14/25: Abgleich erkennt Index ohne PDF, PDF ohne Index, falschen Standort, falschen Mitarbeiter, Dubletten', async () => {
  const now = Date.UTC(2026, 10, 28, 12);
  const old = now - 2 * H;
  const job = (id, key, o = {}) => ({ archiveId: id, fileKey: key, uid: 'uidA', shopId: 'crailsheim', status: S.VERIFIED, createdAt: old, handedAt: old, indexed: true, pdfLocal: false, ...o });
  const jobs = [job('a1', 'k1'), job('a2', 'k2', { status: S.HANDED, pdfLocal: true }), job('a3', 'k3'), job('a4', 'k4'), job('a5', 'k5'), job('a6', 'k5'), job('a7', 'k7')];
  const index = [
    { key: 'k1', uid: 'uidA', shopId: 'crailsheim', ts: old, hasKeys: true },
    { key: 'k3', uid: 'uidA', shopId: 'aalen', ts: old, hasKeys: true },       // falscher Standort
    { key: 'k4', uid: 'uidB', shopId: 'crailsheim', ts: old, hasKeys: true },  // falscher Mitarbeiter
    { key: 'k9', uid: 'uidC', shopId: 'crailsheim', ts: old, hasKeys: true }   // Index ohne PDF
  ];
  const sp = new Map([['k1', true], ['k2', false], ['k7', true], ['k9', false]]);
  const r = Q.reconcile({ jobs, index, sp }, now);
  const has = (code, key) => r.issues.some(i => i.code === code && i.key === key);
  assert.ok(has('job-missing-pdf', 'k2')); assert.equal(r.issues.find(i => i.code === 'job-missing-pdf').repair, 'owner-device', 'PDF lokal vorhanden → Gerät sendet erneut');
  assert.ok(has('wrong-shop', 'k3')); assert.ok(has('wrong-employee', 'k4')); assert.ok(has('duplicate', 'k5'));
  assert.ok(has('pdf-no-index', 'k7')); assert.ok(has('index-no-pdf', 'k9'));
  assert.ok(!r.issues.some(i => i.key === 'k1'), 'korrekter Eintrag ohne Befund');
  assert.ok(r.issues.filter(i => /wrong/.test(i.code)).every(i => i.repair === 'admin'), 'Zuordnung wird nie automatisch geändert');
});

test('15: Firebase vorübergehend nicht erreichbar → Archivierung läuft, Index + Monitor werden nachgeholt', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  be.set({ fbDown: true });
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, be.deps('uidA'));
  c.adv(61000); await q.process(be.deps('uidA'));
  let x = await q.get(r.archiveId);
  assert.equal(x.status, S.VERIFIED, 'Archivierung hängt nicht an Firebase'); assert.ok(!x.indexed); assert.equal(be.jobs.size, 0);
  assert.ok(x.kunde, 'Kundendaten bleiben lokal, bis der Index geschrieben ist');
  be.set({ fbDown: false }); c.adv(61000); await q.process(be.deps('uidA'));
  x = await q.get(r.archiveId);
  assert.equal(x.indexed, true); assert.equal(x.complete, true); assert.equal(x.backup, true); assert.equal(x.kunde, '', 'danach Datensparsamkeit (Sicherung im Backend vorhanden)');
  assert.equal(be.jobs.get(r.archiveId).status, S.VERIFIED);
});

test('16: SharePoint/Prüfdienst nicht erreichbar → kein Schein-Erfolg, PDF bleibt, später bestätigt', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  be.set({ spDown: true });
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, be.deps('uidA'));
  for (let i = 0; i < 10; i++) { c.adv(61000); await q.process(be.deps('uidA')); }
  let x = await q.get(r.archiveId);
  assert.equal(x.status, S.HANDED); assert.equal(x.verifyAvailable, false); assert.ok(x.pdfBlob);
  be.set({ spDown: false }); c.adv(31 * 60000); await q.process(be.deps('uidA'));
  x = await q.get(r.archiveId);
  assert.equal(x.status, S.VERIFIED);
});

test('17: unbestätigte Archivierung älter als 7 Tage → nicht gelöscht, Warnung/Eskalation, Speicher-Warnung', async () => {
  const c = clock(); const q = mkQ(c);
  const r = await q.create(rec());
  await q.update(r.archiveId, { status: S.PENDING, nextTryAt: c.now() + 999 * D, blockedReason: 'x' });
  c.adv(8 * D); await q.process({ uid: 'uidA', online: () => true, send: async () => ({ ok: true }) });
  assert.ok((await q.get(r.archiveId)).pdfBlob);
  const al = await q.alerts('uidA', { usage: 900, quota: 1000 });
  const codes = al.map(a => a.code);
  assert.ok(codes.includes('pending-old') && codes.includes('escalate') && codes.includes('storage-low') && codes.includes('local-pdf'), codes.join());
  assert.deepEqual(await q.alerts('uidB'), [], 'B sieht keine Warnungen zu A');
});

test('19: alte Archivierungen (alter Dateiname / alte Felder) bleiben lesbar und im Abgleich ohne Fehlalarm', () => {
  const alt = Q.normalizeIndexEntry({ fileName: 'PENCIL_Mueller_Crailsheim_Angebot_2026-03-02.pdf', shop: 'Crailsheim', userUid: 'u1', ts: '1772400000000' });
  assert.deepEqual([alt.shopId, alt.uid, alt.legacyName, alt.typ], ['crailsheim', 'u1', true, 'angebot']);
  const r = Q.reconcile({ jobs: [], index: [{ key: 'old', uid: 'u1', shopId: 'crailsheim', ts: 1, hasKeys: true }], sp: new Map() }, Date.now());
  assert.equal(r.issues.length, 0, 'nicht geprüft = kein Befund (keine erfundenen Fehler)');
});

test('22: IndexedDB nicht verfügbar → idbStore meldet Fehler (Aufrufer fällt auf Direktversand zurück, kein Schein-Erfolg)', async () => {
  const s = Q.idbStore('test-db'); // Node: kein indexedDB
  await assert.rejects(s.all(), /IndexedDB nicht verfügbar/);
});

test('23: unvollständige oder beschädigte PDF → wird erkannt, nicht gesendet', async () => {
  assert.deepEqual(await Q.checkPdf(pdf()), { ok: true, code: '', size: pdf().size });
  assert.equal((await Q.checkPdf(new Blob(['%PDF-1.4\n' + 'x'.repeat(5000)]))).code, 'pdf-truncated', 'abgeschnitten (kein %%EOF)');
  assert.equal((await Q.checkPdf(new Blob(['<html>' + 'x'.repeat(500) + '</html>']))).code, 'no-pdf');
  assert.equal((await Q.checkPdf(new Blob(['%PDF']))).code, 'pdf-too-small');
  assert.equal((await Q.checkPdf(null)).code, 'no-pdf');
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec({ pdfBlob: null }));
  const out = await q.sendNow(r.archiveId, be.deps('uidA'));
  assert.equal(out.status, S.FAILED); assert.equal(out.blockedReason, 'nopdf'); assert.equal(be.sent.length, 0);
});

test('24: Anmeldung auf einem anderen Tablet → zentrale Statusmeldung ist geräteunabhängig sichtbar (ohne Kundendaten)', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec());
  await q.sendNow(r.archiveId, be.deps('uidA')); c.adv(61000); await q.process(be.deps('uidA'));
  const j = be.jobs.get(r.archiveId);
  assert.equal(j.status, S.VERIFIED); assert.equal(j.uid, 'uidA'); assert.equal(j.shopId, 'crailsheim'); assert.equal(j.fileKey, r.fileKey);
  const txt = JSON.stringify(j);
  assert.ok(!/Mueller|PENCIL_|a\.test@/.test(txt), 'kein Kundenname, kein Dateiname, keine E-Mail: ' + txt);
  // nur bei Änderung erneut melden
  const n = be.jobs.size; c.adv(61000); const st = await q.process(be.deps('uidA'));
  assert.equal(st.synced, 0); assert.equal(be.jobs.size, n);
  // fremde Einträge meldet nur der Eigentümer
  const r2 = await q.create(rec({ uid: 'uidX', fileName: NAME('Y', 'Crailsheim', 'Angebot', 'zz99zzz') }));
  await q.process(be.deps('uidA'));
  assert.equal(be.jobs.has(r2.archiveId), false);
});

test('27: Archivierungsquote = bestätigt / gestartet – Offenes, Fehlgeschlagenes, Verworfenes bleibt im Nenner', () => {
  const now = Date.UTC(2026, 10, 28, 12);
  const j = (status, o = {}) => ({ archiveId: Math.random().toString(36), status, createdAt: now - H, verifiedAt: status === S.VERIFIED ? now - H + 60000 : 0, shopId: 'crailsheim', uid: 'uidA', indexed: true, complete: status === S.VERIFIED, sends: 1, type: 'angebot', ...o });
  const jobs = [j(S.VERIFIED), j(S.VERIFIED, { sends: 2, shopId: 'aalen', verifiedAt: now - 1000 }), j(S.VERIFIED, { indexed: false, complete: false }), j(S.HANDED), j(S.PENDING), j(S.FAILED, { sends: 3, manualRetries: 1 }), j(S.DISCARDED), j(S.SENDING, { createdAt: now - 4 * D })];
  const m = Q.computeMetrics(jobs, now);
  assert.equal(m.total, 8); assert.equal(m.verified, 3); assert.equal(m.complete, 2, 'v4: nur mit korrektem Suchindex');
  assert.equal(m.rate, 2 / 8, 'Quote = vollständig ÷ gestartet'); assert.equal(m.fileRate, 3 / 8);
  assert.equal(m.pending, 2); assert.equal(m.handed, 1); assert.equal(m.failed, 1); assert.equal(m.discarded, 1); assert.equal(m.noIndex, 1);
  assert.equal(m.retries, 1 + 2 + 1); assert.equal(m.escalated, 1);
  assert.equal(m.lastVerifiedByShop.aalen, now - 1000);
  assert.ok(m.avgDurationMs > 0);
  assert.equal(Q.computeMetrics([], now).rate, null, 'keine Vorgänge → keine erfundene Quote');
  const f = Q.filterJobs(jobs, { shopId: 'aalen' });
  assert.equal(f.length, 1);
  assert.equal(Q.filterJobs(jobs, { status: S.FAILED }).length, 1);
  assert.equal(Q.filterJobs(jobs, { from: now - 2 * D }).length, 7);
});

test('Verwerfen: nur Eigentümer/Admin, nie bestätigte, PDF + Kundendaten weg, Eintrag bleibt "verworfen", protokolliert, gemeldet', async () => {
  const c = clock(); const be = backend(); const q = mkQ(c);
  const r = await q.create(rec());
  await q.update(r.archiveId, { status: S.FAILED });
  await assert.rejects(q.discard(r.archiveId, { uid: 'uidB' }, 'versehentlich'), /forbidden/);
  assert.equal(await q.discard(r.archiveId, { uid: 'uidA' }, 'Kunde hat abgesagt'), true);
  const d = await q.get(r.archiveId);
  assert.deepEqual([d.status, d.pdfBlob, d.kunde, d.discardedBy, d.discardedRole, d.discardReason], [S.DISCARDED, null, '', 'uidA', 'owner', 'Kunde hat abgesagt']);
  assert.ok(Q.readLog().some(l => l.step === 'discard' && l.archiveId === r.archiveId && /^owner:Kunde/.test(l.code)));
  await q.process(be.deps('uidA'));
  assert.equal(be.jobs.get(r.archiveId).status, S.DISCARDED, 'Monitor sieht verworfen (zählt nicht als Erfolg)');
  // bestätigte Archivierung kann nicht verworfen werden
  const r2 = await q.create(rec({ fileName: NAME('Ok', 'Crailsheim', 'Angebot', 'ok11okk') }));
  await q.sendNow(r2.archiveId, be.deps('uidA')); c.adv(61000); await q.process(be.deps('uidA'));
  await assert.rejects(q.discard(r2.archiveId, { uid: 'uidA' }), /bereits archiviert/);
  // neue Archivierung mit gleichem Namen nach Verwerfen ist möglich (kein "Doppelversand verhindert")
  const r3 = await q.create(rec());
  assert.equal(r3.duplicate, undefined); assert.notEqual(r3.archiveId, r.archiveId);
});

test('PDF freigeben (Speicher voll): nur Admin, Metadaten bleiben, Status bleibt offen, protokolliert', async () => {
  const c = clock(); const q = mkQ(c);
  const r = await q.create(rec());
  await q.update(r.archiveId, { status: S.HANDED, handedAt: c.now(), verifyAvailable: false });
  await assert.rejects(q.releasePdf(r.archiveId, { uid: 'uidA' }, 'Speicher'), /forbidden/);
  const x = await q.releasePdf(r.archiveId, { uid: 'adm', isAdmin: true }, 'Speicher voll');
  assert.equal(x.pdfBlob, null); assert.equal(x.status, S.HANDED); assert.equal(x.pdfReleasedBy, 'adm');
  assert.ok(Q.readLog().some(l => l.step === 'release-pdf' && l.archiveId === r.archiveId));
});

test('Backoff mit Jitter, Fehlerklassen', () => {
  const p = Q.POLICY;
  assert.equal(Q.backoffDelay(1, p, () => 0.5), 30000);
  assert.equal(Q.backoffDelay(1, p, () => 0), 22500);
  assert.equal(Q.backoffDelay(1, p, () => 0.999999), 37500);
  assert.equal(Q.backoffDelay(99, p, () => 0.5), 30 * 60000, 'gedeckelt bei 30 Min. (keine Endlosschleife mit Dauerlast)');
  const spread = new Set(Array.from({ length: 50 }, () => Q.backoffDelay(3, p)));
  assert.ok(spread.size > 10, 'Tablets wiederholen gestreut');
  for (const [c, k] of [['offline', 'offline'], ['timeout', 'temporary'], ['AbortError', 'temporary'], ['429', 'temporary'], ['503', 'temporary'], ['500', 'temporary'], ['auth', 'auth'], ['validation:pdf', 'admin'], ['pdf-missing', 'admin'], ['not-found-in-archive', 'admin'], ['', 'temporary']]) assert.equal(Q.classifyError(c), k, c);
});

test('o2 / Telekom gleich: archive-queue.js identisch, Telekom-Kopie unterscheidet sich nur im Protokollschlüssel', () => {
  const isTk = /telekom$/i.test(ROOT);
  const o2f = isTk ? path.join(ROOT, '..', 'ps-dashboard', 'archive-queue.js') : path.join(ROOT, 'archive-queue.js');
  const tkf = isTk ? path.join(ROOT, 'archive-queue.js') : path.join(ROOT, '..', 'ps-dashboard-telekom', 'archive-queue.js');
  if (!fs.existsSync(o2f) || !fs.existsSync(tkf)) return; // nur im gemeinsamen Arbeitsverzeichnis beider Repos prüfbar
  const a = fs.readFileSync(o2f, 'utf8').split('\n');
  const b = fs.readFileSync(tkf, 'utf8').split('\n');
  const diff = a.map((l, i) => (l !== b[i] ? i : -1)).filter(i => i >= 0);
  assert.equal(a.length, b.length);
  assert.equal(diff.length, 1); assert.match(b[diff[0]], /tps_archiv_log_v1/);
});

test('21: Service-Worker-Cache und Skript-Version wurden für das Update erhöht', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const v = Number((/const CACHE = "pencil-[a-z0-9]+-v(\d+)"/.exec(sw) || [])[1]);
  assert.ok(v >= 37, 'Cache-Version: ' + v);
  assert.match(html, /archive-queue\.js\?v=4"/, 'Cache-Busting für das Modul');
});
