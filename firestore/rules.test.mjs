// Tests der Firestore-Regeln (firestore.rules) im Firestore-Emulator – synthetische Daten.
// Lokal:   cd firestore && npm i --no-save firebase-tools@13 @firebase/rules-unit-testing@3 firebase@10
//          npx firebase emulators:exec --only firestore --project demo-ps "node --test rules.test.mjs"
// Automatisch: GitHub Actions "Firestore-Regeln testen" (.github/workflows/firestore-regeln-test.yml)
import test, { before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';

let env;
const RULES = fs.readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
const users = {
  annaCr: { role: 'verkaeufer', active: true, status: 'approved', shopId: 'crailsheim', name: 'Anna' },
  berndCr: { role: 'verkaeufer', active: true, status: 'approved', shopId: 'Crailsheim', name: 'Bernd' }, // Großschreibung im Profil
  claraAa: { role: 'verkaeufer', active: true, status: 'approved', shopId: 'aalen', name: 'Clara' },
  dieterExtra: { role: 'verkaeufer', active: true, status: 'approved', shopId: 'aalen', extraShopIds: ['crailsheim'], name: 'Dieter' },
  svenSpringer: { role: 'verkaeufer', active: true, status: 'approved', shopId: 'aalen', springer: true, name: 'Sven' },
  ingaInaktiv: { role: 'verkaeufer', active: false, status: 'pending', shopId: 'crailsheim', name: 'Inga' },
  adaAdmin: { role: 'admin', active: true, status: 'approved', shopId: '', name: 'Ada' }
};
const entry = (o = {}) => ({ fileName: 'PENCIL_Mueller--1000abcdefgh_Crailsheim_Angebot_2026-11-28.pdf', typ: 'angebot', shopId: 'crailsheim', kunde: 'Max Mueller', ruf: '', nsn: '', datum: '2026-11-28', agent: 'Anna', ts: 1795850000000, keys: ['n:max', 'n:mue'], offerId: '', src: 'app', uid: 'annaCr', v: 1, ...o });
const ID = 'pencil_mueller--1000abcdefgh_crailsheim_angebot_2026-11-28.pdf';
const db = uid => (uid ? env.authenticatedContext(uid, { email: uid + '@hetec-gmbh.de' }) : env.unauthenticatedContext()).firestore();
const job = (o = {}) => ({ archiveId: 'ar-1', uid: 'annaCr', shopId: 'crailsheim', status: 'verified', complete: true, createdAt: 1, sends: 1, fileKey: 'abc', ...o });

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-ps', firestore: { rules: RULES, host: '127.0.0.1', port: 8080 } });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const f = ctx.firestore();
    for (const [uid, p] of Object.entries(users)) await f.collection('users').doc(uid).set(p);
    await f.collection('pdf_index').doc(ID).set(entry());
    await f.collection('pdf_index_backup').doc(ID).set(entry());
    await f.collection('pdf_index').doc('aalen-1').set(entry({ fileName: 'PENCIL_X_Aalen_Angebot_2026-11-28.pdf', shopId: 'aalen', uid: 'claraAa' }));
    await f.collection('archiv_jobs').doc('ar-1').set(job());
  });
});

test('Kundensuche: Kollegen desselben Standorts finden sich gegenseitig', async () => {
  await assertSucceeds(db('berndCr').collection('pdf_index').doc(ID).get());
  await assertSucceeds(db('berndCr').collection('pdf_index').where('shopId', '==', 'crailsheim').where('keys', 'array-contains', 'n:mue').get());
  await assertSucceeds(db('annaCr').collection('pdf_index').where('uid', '==', 'annaCr').get()); // "Meine Archivierungen"
  await assertSucceeds(db('berndCr').collection('pdf_index_backup').where('shopId', '==', 'crailsheim').where('keys', 'array-contains', 'n:mue').get());
});

test('Fremder Standort ohne Berechtigung: kein Lesen, keine Abfrage, auch nicht ohne Filter (Manipulation des Clients)', async () => {
  await assertFails(db('claraAa').collection('pdf_index').doc(ID).get());
  await assertFails(db('claraAa').collection('pdf_index').where('shopId', '==', 'crailsheim').get());
  await assertFails(db('claraAa').collection('pdf_index').get());
  await assertFails(db('claraAa').collection('pdf_index_backup').doc(ID).get());
  await assertFails(db('ingaInaktiv').collection('pdf_index').where('shopId', '==', 'crailsheim').get());
  await assertFails(db(null).collection('pdf_index').where('shopId', '==', 'crailsheim').get());
});

test('Zusatzfiliale, Springer und Admin', async () => {
  await assertSucceeds(db('dieterExtra').collection('pdf_index').where('shopId', '==', 'crailsheim').get());
  await assertSucceeds(db('svenSpringer').collection('pdf_index').get());
  await assertSucceeds(db('adaAdmin').collection('pdf_index').where('ts', '>=', 0).get());
});

test('Nicht vorhandene Dokumente: Abfrage erlaubt (für Prüfung/Reparatur), verrät nichts', async () => {
  await assertSucceeds(db('annaCr').collection('pdf_index').doc('gibt-es-nicht').get());
  await assertSucceeds(db('annaCr').collection('pdf_index_backup').doc('gibt-es-nicht').get());
});

test('Schreiben: nur eigene UID und freigegebener Standort; Zuordnung unveränderlich', async () => {
  await assertSucceeds(db('annaCr').collection('pdf_index').doc('neu').set(entry({ fileName: 'neu.pdf' })));
  await assertFails(db('annaCr').collection('pdf_index').doc('neu2').set(entry({ fileName: 'neu2.pdf', shopId: 'aalen' })));
  await assertFails(db('claraAa').collection('pdf_index').doc('neu3').set(entry({ fileName: 'neu3.pdf' })));
  await assertFails(db('claraAa').collection('pdf_index').doc('neu4').set(entry({ fileName: 'neu4.pdf', uid: 'annaCr', shopId: 'aalen' })));
  await assertFails(db('berndCr').collection('pdf_index').doc(ID).set(entry({ uid: 'berndCr' })), 'Kollege übernimmt nicht');
  await assertSucceeds(db('annaCr').collection('pdf_index').doc(ID).set(entry({ kunde: 'Max Mueller-Neu' })), 'Eigentümer aktualisiert');
  await assertFails(db('annaCr').collection('pdf_index').doc(ID).set(entry({ uid: 'claraAa' })));
  await assertFails(db('annaCr').collection('pdf_index').doc('x').set({ ...entry({ fileName: 'x.pdf' }), extra: 'feld' }), 'unbekanntes Feld');
});

test('Sicherung: nur anlegen, nie überschreiben, nicht löschen (außer Admin)', async () => {
  await assertSucceeds(db('annaCr').collection('pdf_index_backup').doc('neu').set(entry({ fileName: 'neu.pdf' })));
  await assertFails(db('annaCr').collection('pdf_index_backup').doc(ID).set(entry({ kunde: 'Manipuliert' })));
  await assertFails(db('annaCr').collection('pdf_index_backup').doc(ID).delete());
  await assertFails(db('annaCr').collection('pdf_index_backup').doc('_selftest_annacr').set(entry({ fileName: '_selftest_annacr' })));
  await assertSucceeds(db('adaAdmin').collection('pdf_index_backup').doc(ID).delete());
});

test('Wiederherstellung durch Kollegen: nur exakte Kopie der Sicherung, nur eigener Standort', async () => {
  await env.withSecurityRulesDisabled(async ctx => { await ctx.firestore().collection('pdf_index').doc(ID).delete(); });
  await assertFails(db('claraAa').collection('pdf_index').doc(ID).set(entry()), 'fremder Standort');
  await assertFails(db('berndCr').collection('pdf_index').doc(ID).set(entry({ kunde: 'Anders' })), 'veränderte Kopie');
  await assertSucceeds(db('berndCr').collection('pdf_index').doc(ID).set(entry()), 'exakte Kopie durch Kollegen');
  // falsche Zuordnung im Index wird mit der Sicherung überschrieben
  await env.withSecurityRulesDisabled(async ctx => { await ctx.firestore().collection('pdf_index').doc(ID).set(entry({ shopId: 'crailsheim', uid: 'claraAa' })); });
  await assertSucceeds(db('berndCr').collection('pdf_index').doc(ID).set(entry()));
});

test('Selbsttest der App: eigener Eintrag anlegen und löschen; fremde nicht löschen', async () => {
  const st = entry({ fileName: '_selftest_annacr', kunde: '' });
  await assertSucceeds(db('annaCr').collection('pdf_index').doc('_selftest_annacr').set(st));
  await assertSucceeds(db('annaCr').collection('pdf_index').doc('_selftest_annacr').delete());
  await assertFails(db('annaCr').collection('pdf_index').doc(ID).delete());
  await assertFails(db('berndCr').collection('pdf_index').doc(ID).delete());
});

test('Archivierungsmonitor: Admin liest alle; Mitarbeiter schreiben nur eigene Meldungen ohne Kundendaten', async () => {
  await assertSucceeds(db('adaAdmin').collection('archiv_jobs').where('createdAt', '>=', 0).get());
  await assertFails(db('berndCr').collection('archiv_jobs').doc('ar-1').get());
  await assertSucceeds(db('annaCr').collection('archiv_jobs').doc('ar-1').get());
  await assertSucceeds(db('berndCr').collection('archiv_jobs').doc('ar-2').set(job({ archiveId: 'ar-2', uid: 'berndCr' })));
  await assertFails(db('berndCr').collection('archiv_jobs').doc('ar-3').set(job({ archiveId: 'ar-3', uid: 'annaCr' })));
  await assertFails(db('berndCr').collection('archiv_jobs').doc('ar-4').set(job({ archiveId: 'ar-4', uid: 'berndCr', fileName: 'PENCIL_Mueller.pdf' })));
  await assertFails(db('berndCr').collection('archiv_jobs').doc('ar-5').set(job({ archiveId: 'ar-5', uid: 'berndCr', kunde: 'Max' })));
  await assertFails(db('claraAa').collection('archiv_jobs').doc('ar-6').set(job({ archiveId: 'ar-6', uid: 'claraAa', shopId: 'crailsheim' })), 'fremder Standort');
  await assertSucceeds(db('annaCr').collection('archiv_jobs').doc('ar-1').set({ status: 'verified', complete: true, sends: 2 }, { merge: true }));
  await assertFails(db('annaCr').collection('archiv_jobs').doc('ar-1').set({ shopId: 'aalen' }, { merge: true }), 'Standort unveränderlich');
  await assertFails(db('berndCr').collection('archiv_jobs').doc('ar-1').set({ status: 'failed' }, { merge: true }));
  await assertFails(db('annaCr').collection('archiv_jobs').doc('ar-1').delete());
});

test('Profile: Standort/Rolle/Freigabe nicht selbst änderbar; Registrierung nur als ausstehender Verkäufer', async () => {
  await assertSucceeds(db('annaCr').collection('users').doc('annaCr').update({ vorname: 'Anna', nachname: 'Neu', name: 'Anna Neu' }));
  await assertFails(db('annaCr').collection('users').doc('annaCr').update({ shopId: 'aalen' }));
  await assertFails(db('annaCr').collection('users').doc('annaCr').update({ springer: true }));
  await assertFails(db('annaCr').collection('users').doc('annaCr').update({ role: 'admin' }));
  await assertFails(db('annaCr').collection('users').doc('berndCr').get());
  await assertSucceeds(db('neuUser').collection('users').doc('neuUser').set({ email: 'n@hetec-gmbh.de', name: 'Neu', shopId: 'aalen', role: 'verkaeufer', status: 'pending', active: false, isTestUser: false, createdAt: 1 }));
  await assertFails(db('neu2').collection('users').doc('neu2').set({ name: 'X', shopId: 'aalen', role: 'admin', status: 'approved', active: true }));
  await assertFails(db('neu3').collection('users').doc('neu3').set({ name: 'X', shopId: 'aalen', role: 'verkaeufer', status: 'pending', active: false, springer: true }));
  await assertSucceeds(db('adaAdmin').collection('users').doc('annaCr').update({ shopId: 'aalen', active: true }));
  await assertSucceeds(db('adaAdmin').collection('users').get());
});

test('Kompatibilität mit der App: echte Monitor-Meldung (jobSummary aus archive-queue.js) und echter Suchindex-Eintrag', async () => {
  await import(new URL('../archive-queue.js', import.meta.url).href);
  const Q = globalThis.PSArchivQueue;
  const q = Q.createQueue({ store: Q.memoryStore(), useLocks: false });
  const rec = await q.create({ uid: 'berndCr', employeeName: 'Bernd', shopId: 'crailsheim', type: 'angebot', fileName: 'PENCIL_Test--1000abcdefgh_Crailsheim_Angebot_2026-11-28.pdf', subject: 'PENCIL|angebot|2026-11-28|Bernd', kunde: 'Max', pdfBlob: new Blob(['%PDF-1.4\n' + 'x'.repeat(500) + '\n%%EOF']) });
  const summary = Object.assign(Q.jobSummary(rec), { brand: 'o2', deviceId: 'dev-x', appVersion: '55.171', syncedAtMs: Date.now() });
  const f = db('berndCr');
  // Die App schreibt mit set(…, { merge: true }) und serverTimestamp (compat: FieldValue)
  const fb = (await import('firebase/compat/app')).default;
  await import('firebase/compat/firestore');
  const FV = fb.firestore.FieldValue;
  await assertSucceeds(f.collection('archiv_jobs').doc(rec.archiveId).set({ ...summary, syncedAt: FV.serverTimestamp() }, { merge: true }));
  await assertSucceeds(f.collection('archiv_jobs').doc(rec.archiveId).set({ ...summary, status: 'verified', complete: true, syncedAt: FV.serverTimestamp() }, { merge: true }));
  // Suchindex-Eintrag exakt wie psIdxBuild (Felder + Typen)
  const e = { fileName: rec.fileName, typ: 'angebot', shopId: 'crailsheim', kunde: 'Max', ruf: '', nsn: '', datum: '2026-11-28', agent: 'Bernd', ts: Date.now(), keys: ['n:max'], offerId: '', src: 'app', uid: 'berndCr', v: 1 };
  const id = Q.idOf(rec.fileName);
  await assertSucceeds(f.collection('pdf_index').doc(id).set(e));
  const b = await f.collection('pdf_index_backup').doc(id).get();
  if (b.exists) throw new Error('Sicherung sollte noch fehlen');
  await assertSucceeds(f.collection('pdf_index_backup').doc(id).set(e));
  // Kollegin desselben Standorts (Großschreibung im Profil von Bernd egal) findet ihn
  await assertSucceeds(db('annaCr').collection('pdf_index').where('shopId', '==', 'crailsheim').where('keys', 'array-contains', 'n:max').get());
});
