/*
 * PSArchivQueue – zuverlässige Archivierung (Archiv-Ausgang) für Pencil Selling.
 *
 * Warum: Der Archiv-Flow (Power Automate) wird mit mode:'no-cors' aufgerufen; die Antwort ist für den Browser
 * unlesbar. "fetch ohne Fehler" heißt nur "Anfrage abgeschickt", nicht "in SharePoint abgelegt". Außerdem gingen
 * fehlgeschlagene Archivierungen nach 24 h still verloren, und auf geteilten Tablets wurden Vorgänge dem gerade
 * angemeldeten statt dem tatsächlichen Mitarbeiter zugeordnet.
 *
 * Grundsätze:
 *  - Jede Archivierung bekommt VOR dem Versand einen dauerhaften Eintrag (IndexedDB) mit eindeutiger archiveId,
 *    eindeutigem Dateinamen (Kennzeichen "--XXXXXXX" hinter der Kennung) und dem Eigentümer (uid, Name, Shop).
 *    Diese Angaben werden nie durch einen späteren Benutzer überschrieben.
 *  - Status: sending (läuft) → handed (übergeben, wird überprüft) → verified (in SharePoint bestätigt).
 *            pending (ausstehend, automatische Wiederholung) · failed (fehlgeschlagen, sichtbar, manuell erneut senden).
 *  - "Erfolgreich" erst, wenn der Archiv-Prüfdienst (Flow "PDF Archiv API V3", Aktion exists) die Datei findet.
 *  - Wiederholung mit gleichem Dateinamen (idempotent, keine Dubletten), begrenzte Anzahl.
 *  - Nichts wird kommentarlos gelöscht: die PDF bleibt bis zur Bestätigung gespeichert – OHNE Altersgrenze (v3: die
 *    frühere 7-Tage-Löschung bei fehlender Prüfmöglichkeit entfällt). Erst nach Bestätigung wird sie entfernt
 *    (Datenschutz), die Metadaten bleiben 31 Tage für die Anzeige "Meine Archivierungen".
 *  - Bewusstes Verwerfen/Freigeben nur durch Eigentümer/Admin, mit Grund, protokolliert; der Eintrag bleibt als
 *    "verworfen" sichtbar (zählt im Monitor nicht als Erfolg).
 *  - v3: Wiederholung mit Backoff + Jitter, Fehlerklassen (vorübergehend / Anmeldung / Eingriff nötig), PDF-Prüfung
 *    (%PDF … %%EOF, Größe, SHA-256), Warnungen (lange ausstehend, Speicher knapp), Selbstreparatur fehlender
 *    Suchindex-Einträge (nur eigene), zentrale Statusmeldung ohne Kundendaten (Archivierungsmonitor), Abgleich.
 *  - v4: Zwei Stufen. "In SharePoint abgelegt" (verified) ≠ "vollständig archiviert" (complete). Vollständig erst, wenn
 *    der Suchindex-Eintrag existiert, Mitarbeiter UND Standort stimmen und er über die Kundensuche auffindbar ist.
 *    Reparatur über eine unveränderliche Sicherungskopie im zentralen Backend (pdf_index_backup) – unabhängig vom Tablet
 *    des ursprünglichen Mitarbeiters. Integrität zusätzlich über Dateigröße / SHA-256, sofern der Prüfdienst sie liefert.
 *    Dateikennzeichen: Uhrzeit + 8 Zufallszeichen (statt 3).
 *  - Unabhängig von Firebase: Versand, Prüfung und Index werden als Funktionen übergeben (Azure-/Entra-tauglich).
 *  - Technisches Protokoll ohne Kundendaten (archiveId, uid, Shop, Schritt, Status, Fehlercode, Versuch).
 *
 * Läuft im Browser (window.PSArchivQueue) und in Node-Tests (globalThis.PSArchivQueue, Speicher austauschbar).
 */
(function (root) {
  'use strict';

  var SCHEMA_VERSION = 4;
  var DB_NAME = 'PencilSellingArchivQueue';
  var STORE = 'outbox';
  var LOG_KEY = 'ps_archiv_log_v1';
  var LOG_MAX = 400;
  var LOG_MAX_AGE_MS = 30 * 86400000;

  var STATUS = Object.freeze({
    SENDING: 'sending',   // Archivierung läuft
    HANDED: 'handed',     // an den Archiv-Flow übergeben – Ablage wird überprüft
    VERIFIED: 'verified', // in SharePoint gefunden – erfolgreich archiviert
    PENDING: 'pending',   // ausstehend – wird automatisch erneut gesendet (z. B. keine Verbindung)
    FAILED: 'failed',     // fehlgeschlagen – bleibt sichtbar, manuell erneut senden
    DISCARDED: 'discarded' // bewusst verworfen (Eigentümer/Admin, protokolliert) – keine PDF mehr, Metadaten 31 Tage
  });

  var POLICY = {
    verifyGraceMs: 20 * 60000,      // so lange darf die Ablage (Flow → Mail → Ablage-Flow → SharePoint) dauern
    maxSends: 3,                    // Erstversand + 2 automatische Wiederholungen
    staleSendingMs: 3 * 60000,      // "läuft" länger als 3 Min. (App geschlossen/abgestürzt) → ausstehend
    pendingBackoffMs: [30000, 60000, 2 * 60000, 5 * 60000, 10 * 60000, 15 * 60000, 30 * 60000],
    jitter: 0.25,                   // ±25 % Streuung: viele Tablets wiederholen nicht im selben Moment
    verifyEveryMs: 60000,           // höchstens einmal pro Minute je Eintrag prüfen …
    verifySlowAfterMs: 2 * 3600000, // … nach 2 h ohne Bestätigung nur noch alle 10 Min.
    verifySlowEveryMs: 10 * 60000,
    unverifiableRecheckMs: 30 * 60000, // Prüfdienst kann (noch) nicht prüfen: höchstens alle 30 Min. erneut fragen
    keepVerifiedMs: 31 * 86400000,  // Metadaten bestätigter/verworfener Einträge (ohne PDF)
    // Unbestätigte PDFs werden NIE wegen ihres Alters gelöscht (v3). Stattdessen Warnungen/Eskalation:
    warnPendingMs: 2 * 3600000,     // ausstehend (nicht übergeben) länger als 2 h → Warnung
    warnUnverifiedMs: 24 * 3600000, // übergeben, aber nach 24 h nicht bestätigt → Warnung
    escalateMs: 72 * 3600000,       // nach 72 h ohne Bestätigung → Admin-Eskalation (Monitor)
    storageWarnRatio: 0.8,          // Gerätespeicher für die App zu 80 % belegt → Warnung
    storageMinFreeBytes: 150 * 1048576,
    indexCheckEveryMs: 6 * 3600000, // eigene bestätigte Einträge: Suchindex-Eintrag höchstens alle 6 h prüfen
    perRunLimit: 25                 // höchstens so viele Index-Prüfungen / Statusmeldungen je Durchlauf (schont Netz/Backend)
  };

  // ── reine Hilfsfunktionen ────────────────────────────────────────────────
  var TOKEN_RE = /--([A-Za-z0-9]{4,12})$/;
  var B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

  function rand(n, rnd) {
    var s = '';
    var r = rnd || defaultRandom;
    for (var i = 0; i < n; i++) s += B36.charAt(Math.floor(r() * 36) % 36);
    return s;
  }
  function defaultRandom() {
    try {
      var c = root.crypto || (root.window && root.window.crypto);
      if (c && c.getRandomValues) { var a = new Uint32Array(1); c.getRandomValues(a); return a[0] / 4294967296; }
    } catch (e) {}
    return Math.random();
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** Lokales Kalenderdatum YYYY-MM-DD (nicht UTC: kurz nach Mitternacht sonst Vortag). */
  function localDate(ms) {
    var d = new Date(typeof ms === 'number' ? ms : Date.now());
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  /**
   * Kennzeichen für den Dateinamen: Uhrzeit HHMM + 8 Zufallszeichen (Krypto-Zufall), z. B. "1415k7q2m9xa".
   * 36^8 ≈ 2,8 Billionen Möglichkeiten je Minute (v3: 3 Zeichen = 46.656). Nur [0-9a-z], kein "_" → Flow-Teile unverändert.
   * Ältere Kennzeichen (4–12 Zeichen) werden weiter erkannt.
   */
  function makeToken(ms, rnd) {
    var d = new Date(typeof ms === 'number' ? ms : Date.now());
    return pad2(d.getHours()) + pad2(d.getMinutes()) + rand(8, rnd);
  }
  /** Eindeutige Archivierungs-ID (lokal, auch Korrelations-ID im Protokoll). */
  function makeArchiveId(ms, rnd) {
    return 'ar-' + (typeof ms === 'number' ? ms : Date.now()).toString(36) + '-' + rand(8, rnd);
  }
  // Zwei Namensschemata:
  //   o2:      PENCIL_[Kennung]_[Shop]_[Typ]_[Datum].pdf   → Kennung = Teil [1]
  //   Telekom: PENCIL_[Shop]_[Typ]_[Datum]_[Kennung].pdf   → Kennung = letzter Teil
  // Das Kennzeichen kommt immer an die KENNUNG, damit die vom Flow gelesenen Teile (Shop, Typ, Datum) unverändert bleiben.
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function kennIndex(parts) {
    if (parts.length >= 3 && DATE_RE.test(parts[parts.length - 1])) return 1;                // o2
    if (parts.length >= 4 && DATE_RE.test(parts[parts.length - 2])) return parts.length - 1; // Telekom
    return -1;
  }
  function splitName(fileName) {
    var f = String(fileName || '');
    if (!/^PENCIL_/i.test(f)) return null;
    var ext = /\.pdf$/i.test(f) ? f.slice(-4) : '';
    var parts = (ext ? f.slice(0, -4) : f).split('_');
    var k = kennIndex(parts);
    return k < 1 ? null : { parts: parts, k: k, ext: ext };
  }
  /** Kennzeichen an die Kennung setzen: PENCIL_Mueller_Aalen_… → PENCIL_Mueller--1415k7q_Aalen_… (idempotent). */
  function uniqueFileName(fileName, token) {
    var f = String(fileName || '');
    var s = splitName(f);
    if (!s || !token) return f;
    if (TOKEN_RE.test(s.parts[s.k])) return f;
    s.parts[s.k] = s.parts[s.k] + '--' + String(token).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    return s.parts.join('_') + s.ext;
  }
  /** Kennung eines Dateinamens ohne Kennzeichen ('' = unbekanntes Schema). */
  function kennungOf(fileName) {
    var s = splitName(fileName);
    return s ? stripToken(s.parts[s.k]) : '';
  }
  /** Kennzeichen eines Dateinamens ('' = alter Name ohne Kennzeichen). */
  function fileToken(fileName) {
    var s = splitName(fileName);
    var t = s && TOKEN_RE.exec(s.parts[s.k]);
    return t ? t[1] : '';
  }
  /** Kennung ohne Kennzeichen. */
  function stripToken(part) { return String(part == null ? '' : part).replace(TOKEN_RE, ''); }
  /** Dateiname ohne Kennzeichen (Vergleich alter/neuer Namen, Kollisions-Diagnose). */
  function baseFileName(fileName) {
    var s = splitName(fileName);
    if (!s) return String(fileName || '');
    s.parts[s.k] = stripToken(s.parts[s.k]);
    return s.parts.join('_') + s.ext;
  }
  function idOf(fileName) { return String(fileName || '').toLowerCase().replace(/[^a-z0-9._+\-]/g, '_').slice(0, 180); }

  /** Wartezeit bis zum nächsten automatischen Versuch (Backoff + Jitter). n = Anzahl bisheriger Fehlversuche (≥1). */
  function backoffDelay(n, pol, rnd) {
    pol = pol || POLICY;
    var arr = pol.pendingBackoffMs;
    var base = arr[Math.max(0, Math.min((n || 1) - 1, arr.length - 1))];
    var r = (rnd || defaultRandom)();
    return Math.max(1000, Math.round(base * (1 + (pol.jitter || 0) * (2 * r - 1))));
  }

  /** Fehlerklasse: offline | temporary (Netz, Zeitlimit, 429, 5xx) | auth (Anmeldung abgelaufen) | admin (Eingriff nötig). */
  function classifyError(code) {
    var c = String(code == null ? '' : code).toLowerCase();
    if (!c) return 'temporary';
    if (c === 'offline') return 'offline';
    if (/^validation|nopdf|pdf-missing|pdf-invalid|forbidden-owner|not-found-in-archive|integrity/.test(c)) return 'admin';
    if (/auth|401|403|unauthenticated|token/.test(c)) return 'auth';
    return 'temporary'; // timeout, aborterror, typeerror, network, 429, 500, 502, 503, 504, send-failed, unbekannt
  }

  /** PDF-Prüfung vor dem Versand: Größe, Anfang "%PDF", Ende "%%EOF". → Promise<{ok, code, size}> */
  function checkPdf(blob) {
    try {
      if (!blob || typeof blob.slice !== 'function') return Promise.resolve({ ok: false, code: 'no-pdf', size: 0 });
      var size = typeof blob.size === 'number' ? blob.size : 0;
      if (size < 200) return Promise.resolve({ ok: false, code: 'pdf-too-small', size: size });
      var txt = function (b) {
        return typeof b.text === 'function' ? b.text() : new Promise(function (res) {
          var fr = new FileReader(); fr.onload = function () { res(String(fr.result || '')); }; fr.onerror = function () { res(''); }; fr.readAsText(b);
        });
      };
      return Promise.all([txt(blob.slice(0, 5)), txt(blob.slice(Math.max(0, size - 2048)))]).then(function (a) {
        if (String(a[0]).indexOf('%PDF') !== 0) return { ok: false, code: 'no-pdf', size: size };
        if (String(a[1]).indexOf('%%EOF') === -1) return { ok: false, code: 'pdf-truncated', size: size };
        return { ok: true, code: '', size: size };
      }, function () { return { ok: false, code: 'pdf-unreadable', size: size }; });
    } catch (e) { return Promise.resolve({ ok: false, code: 'pdf-unreadable', size: 0 }); }
  }

  function subtle() {
    try { var c = root.crypto || (root.window && root.window.crypto); return c && c.subtle ? c.subtle : null; } catch (e) { return null; }
  }
  function hex(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  }
  /** SHA-256 (hex) eines Textes; ohne WebCrypto: '' (Aufrufer muss damit umgehen). */
  function sha256Text(text) {
    var sb = subtle();
    if (!sb || typeof TextEncoder === 'undefined') return Promise.resolve('');
    return sb.digest('SHA-256', new TextEncoder().encode(String(text))).then(hex, function () { return ''; });
  }
  /** SHA-256 (hex) einer Datei (Integritätsnachweis, kein Personenbezug). */
  function sha256Blob(blob) {
    var sb = subtle();
    if (!sb || !blob || typeof blob.arrayBuffer !== 'function') return Promise.resolve('');
    return blob.arrayBuffer().then(function (b) { return sb.digest('SHA-256', b); }).then(hex, function () { return ''; });
  }
  /** Pseudonymer Schlüssel einer Archivdatei (verknüpft Monitor ↔ Suchindex, ohne Kundennamen zu speichern). */
  function fileKeyOf(fileName) {
    return sha256Text('ps-archiv|' + idOf(fileName)).then(function (h) { return h ? h.slice(0, 32) : ''; });
  }

  var FILE_RE = /^PENCIL_[A-Za-z0-9+\-]+_(?:[A-Za-z0-9\-]+_)?(Angebot|Abschluss)_(\d{4}-\d{2}-\d{2})\.pdf$/;          // o2
  var FILE_RE_TK = /^PENCIL_(?:[A-Za-z0-9\-]+_)?(Angebot|Abschluss)_(\d{4}-\d{2}-\d{2})_[A-Za-z0-9+\-]+\.pdf$/;       // Telekom

  /** Vollständigkeit vor dem Versand. Rückgabe: Liste von Fehlercodes (leer = in Ordnung). */
  function validate(rec) {
    var errs = [];
    rec = rec || {};
    if (!rec.archiveId) errs.push('archiveId');
    if (!rec.uid) errs.push('uid');
    var m = FILE_RE.exec(String(rec.fileName || '')) || FILE_RE_TK.exec(String(rec.fileName || ''));
    if (!m) errs.push('fileName');
    var s = String(rec.subject || '').split('|');
    if (s.length !== 4 || s[0] !== 'PENCIL' || (s[1] !== 'angebot' && s[1] !== 'abschluss') || !/^\d{4}-\d{2}-\d{2}$/.test(s[2]) || !s[3]) errs.push('subject');
    var typ = rec.type === 'abschluss' ? 'abschluss' : rec.type === 'angebot' ? 'angebot' : '';
    if (!typ) errs.push('type');
    if (m && typ && m[1].toLowerCase() !== typ) errs.push('typeMismatch');
    if (s.length === 4 && typ && s[1] !== typ) errs.push('typeMismatch');
    if (typ === 'abschluss') {
      var kenn = kennungOf(rec.fileName);
      if (!/\d/.test(kenn) || /^keineNr$/i.test(kenn)) errs.push('abschlussOhneNummer');
    }
    if (!rec.pdfBlob && !rec.pdfRemoved) errs.push('pdf');
    if (rec.pdfBlob && typeof rec.pdfBlob.size === 'number' && rec.pdfBlob.size < 200) errs.push('pdfTooSmall');
    return errs.filter(function (e, i, a) { return a.indexOf(e) === i; });
  }
  /** Prüft die ersten Bytes auf "%PDF". */
  function isPdfBlob(blob) {
    try {
      if (!blob || typeof blob.slice !== 'function') return Promise.resolve(false);
      var part = blob.slice(0, 5);
      var p = typeof part.text === 'function' ? part.text() : new Promise(function (res) {
        var fr = new FileReader(); fr.onload = function () { res(String(fr.result || '')); }; fr.onerror = function () { res(''); }; fr.readAsText(part);
      });
      return p.then(function (t) { return String(t).indexOf('%PDF') === 0; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  /**
   * Was ist mit einem Eintrag als Nächstes zu tun? → 'send' | 'verify' | 'resend' | 'fail' | 'wait' | 'done' | 'purgePdf' | 'purge'
   * ctx = { online: bool } (optional): Rückkehr der Verbindung → wegen fehlender Verbindung wartende Einträge sofort senden.
   * v3: Es gibt KEINE altersbedingte Löschung unbestätigter PDFs mehr. 'purgePdf' nur nach Bestätigung.
   */
  function nextAction(rec, now, pol, ctx) {
    pol = pol || POLICY;
    now = typeof now === 'number' ? now : Date.now();
    if (!rec) return 'wait';
    switch (rec.status) {
      case STATUS.VERIFIED:
        if (rec.pdfBlob) return 'purgePdf';
        return now - (rec.verifiedAt || rec.updatedAt || 0) > pol.keepVerifiedMs ? 'purge' : 'done';
      case STATUS.DISCARDED:
        return now - (rec.discardedAt || rec.updatedAt || 0) > pol.keepVerifiedMs ? 'purge' : 'done';
      case STATUS.FAILED:
        return 'wait'; // nur manuell (Mitarbeiter/Admin) – nie automatisch löschen
      case STATUS.SENDING:
        return now - (rec.sendStartedAt || rec.updatedAt || 0) > pol.staleSendingMs ? 'send' : 'wait';
      case STATUS.PENDING: {
        if (rec.blockedReason) return 'wait'; // z. B. Validierungsfehler: braucht Eingriff
        if (ctx && ctx.online === true && rec.lastError === 'offline') return 'send';
        if (typeof rec.nextTryAt === 'number') return now >= rec.nextTryAt ? 'send' : 'wait';
        // Einträge aus v2 (ohne nextTryAt)
        var n = Math.max(0, (rec.pendingRetries || 0) - 1);
        var wait = pol.pendingBackoffMs[Math.min(n, pol.pendingBackoffMs.length - 1)];
        if (!rec.pendingRetries) wait = 0;
        return now - (rec.lastTryAt || 0) >= wait ? 'send' : 'wait';
      }
      case STATUS.HANDED: {
        var since = now - (rec.handedAt || 0);
        if (since >= pol.verifyGraceMs && rec.verifyAvailable === true && rec.lastVerifyOk === true) {
          if ((rec.sends || 0) >= pol.maxSends || !rec.pdfBlob) return 'fail';
          return 'resend';
        }
        var every = rec.verifyAvailable === false ? pol.unverifiableRecheckMs : since > pol.verifySlowAfterMs ? pol.verifySlowEveryMs : pol.verifyEveryMs;
        return now - (rec.lastVerifyAt || 0) >= every ? 'verify' : 'wait';
      }
    }
    return 'wait';
  }

  /** v4: vollständig archiviert = in SharePoint bestätigt UND Suchindex korrekt (auffindbar, richtige Zuordnung). */
  function isComplete(rec) { return !!rec && rec.status === STATUS.VERIFIED && rec.complete === true; }
  /**
   * v4: Bewertung einer Suchindex-Prüfung. check = { exists, uid, shopId, searchable, backup } (null = unbekannt).
   * → { ok, issue }  issue: 'missing' | 'wrong-employee' | 'wrong-shop' | 'not-searchable' | ''
   */
  function judgeIndex(rec, check) {
    if (!check) return { ok: false, issue: 'unknown' };
    if (!check.exists) return { ok: false, issue: 'missing' };
    if (String(check.uid || '') !== String(rec.uid || '')) return { ok: false, issue: 'wrong-employee' };
    if (String(check.shopId || '').toLowerCase() !== String(rec.shopId || '').toLowerCase()) return { ok: false, issue: 'wrong-shop' };
    if (check.searchable === false) return { ok: false, issue: 'not-searchable' };
    return { ok: true, issue: '' };
  }
  /**
   * v4: Integrität der Ablage. meta = { size, sha256 } vom Prüfdienst (optional).
   * → 'sha256' (Prüfsumme gleich) | 'size' (Größe gleich, keine Prüfsumme) | 'name' (nur Dateiname bestätigt) | 'mismatch'
   */
  function judgeIntegrity(rec, meta) {
    if (!meta) return 'name';
    var lvl = 'name';
    if (typeof meta.size === 'number' && meta.size > 0 && rec.fileSize) {
      if (meta.size !== rec.fileSize) return 'mismatch';
      lvl = 'size';
    }
    var sh = String(meta.sha256 || '').toLowerCase().replace(/^sha256:/, '');
    if (sh && rec.checksum) {
      if ('sha256:' + sh !== String(rec.checksum).toLowerCase()) return 'mismatch';
      lvl = 'sha256';
    }
    return lvl;
  }
  /** Ist ein Eintrag (noch) offen, d. h. weder bestätigt noch bewusst verworfen? */
  function isOpen(rec) { return !!rec && rec.status !== STATUS.VERIFIED && rec.status !== STATUS.DISCARDED; }

  /**
   * Warnungen für die eigenen Einträge eines Geräts (ohne Kundendaten).
   * storage = { usage, quota } aus navigator.storage.estimate() (optional).
   * → [{ code, level:'info'|'warn'|'error', count, oldestAt }]
   */
  function alerts(records, now, pol, storage) {
    pol = pol || POLICY;
    now = typeof now === 'number' ? now : Date.now();
    var out = [];
    var add = function (code, level, list) {
      if (!list.length) return;
      out.push({ code: code, level: level, count: list.length, oldestAt: Math.min.apply(null, list.map(function (r) { return r.createdAt || now; })) });
    };
    var recs = (records || []).filter(Boolean);
    add('failed', 'error', recs.filter(function (r) { return r.status === STATUS.FAILED; }));
    add('pending-old', 'warn', recs.filter(function (r) { return (r.status === STATUS.PENDING || r.status === STATUS.SENDING) && now - (r.createdAt || now) > pol.warnPendingMs; }));
    add('unverified-old', 'warn', recs.filter(function (r) { return r.status === STATUS.HANDED && now - (r.handedAt || r.createdAt || now) > pol.warnUnverifiedMs; }));
    add('escalate', 'error', recs.filter(function (r) { return isOpen(r) && now - (r.createdAt || now) > pol.escalateMs; }));
    add('not-complete', 'warn', recs.filter(function (r) { return r.status === STATUS.VERIFIED && !r.complete && now - (r.verifiedAt || now) > pol.warnPendingMs; }));
    if (storage && storage.quota > 0) {
      var free = storage.quota - (storage.usage || 0);
      if ((storage.usage || 0) / storage.quota >= pol.storageWarnRatio || free < pol.storageMinFreeBytes) {
        out.push({ code: 'storage-low', level: 'warn', count: 1, oldestAt: now, usage: storage.usage || 0, quota: storage.quota });
      }
    }
    var pdfBytes = recs.reduce(function (n, r) { return n + (r.pdfBlob && r.pdfBlob.size ? r.pdfBlob.size : 0); }, 0);
    if (pdfBytes) out.push({ code: 'local-pdf', level: 'info', count: recs.filter(function (r) { return !!r.pdfBlob; }).length, bytes: pdfBytes, oldestAt: now });
    return out;
  }

  /** Statusmeldung für den zentralen Archivierungsmonitor – KEINE Kundendaten (kein Name, keine Nummer, kein Dateiname). */
  function jobSummary(rec, extra) {
    rec = rec || {};
    var s = {
      archiveId: String(rec.archiveId || ''),
      fileKey: String(rec.fileKey || ''),
      schemaVersion: SCHEMA_VERSION,
      uid: String(rec.uid || ''),
      employeeName: String(rec.employeeName || ''),
      createdByUserId: String(rec.createdByUserId || rec.uid || ''),
      shopId: String(rec.shopId || ''),
      type: rec.type === 'abschluss' ? 'abschluss' : 'angebot',
      status: String(rec.status || ''),
      source: String(rec.source || 'app'),
      createdAt: Number(rec.createdAt) || 0,
      handedAt: Number(rec.handedAt) || 0,
      verifiedAt: Number(rec.verifiedAt) || 0,
      discardedAt: Number(rec.discardedAt) || 0,
      sends: Number(rec.sends) || 0,
      pendingRetries: Number(rec.pendingRetries) || 0,
      manualRetries: Number(rec.manualRetries) || 0,
      errorKind: String(rec.errorKind || ''),
      lastError: String(rec.lastError || '').slice(0, 80),
      fileSize: Number(rec.fileSize) || 0,
      checksum: String(rec.checksum || ''),
      indexed: !!rec.indexed,
      complete: rec.status === STATUS.VERIFIED && rec.complete === true,
      completedAt: Number(rec.completedAt) || 0,
      indexIssue: String(rec.indexIssue || ''),
      backup: !!rec.backup,
      integrity: String(rec.integrity || ''),
      verifyAvailable: rec.verifyAvailable === true ? true : rec.verifyAvailable === false ? false : null,
      pdfLocal: !!rec.pdfBlob,
      documentVersion: Number(rec.documentVersion) || 1,
      updatedAt: Number(rec.updatedAt) || 0
    };
    return Object.assign(s, extra || {});
  }

  /** Filter für den Monitor. f = { shopId, uid, from, to, type, status } (leer = alle). */
  function filterJobs(jobs, f) {
    f = f || {};
    return (jobs || []).filter(function (j) {
      if (!j) return false;
      if (f.shopId && j.shopId !== f.shopId) return false;
      if (f.uid && j.uid !== f.uid) return false;
      if (f.type && j.type !== f.type) return false;
      if (f.status && j.status !== f.status) return false;
      if (f.from && (j.createdAt || 0) < f.from) return false;
      if (f.to && (j.createdAt || 0) > f.to) return false;
      return true;
    });
  }

  /**
   * Kennzahlen. Quote = vollständig bestätigt / gestartet. Ausstehende, fehlgeschlagene und verworfene Vorgänge
   * bleiben im Nenner (nichts wird herausgerechnet).
   */
  function computeMetrics(jobs, now) {
    now = typeof now === 'number' ? now : Date.now();
    // v4: verified = Datei in SharePoint bestätigt; complete = zusätzlich Suchindex korrekt und auffindbar.
    //     rate = vollständig ÷ gestartet (Archivierungsquote), fileRate = abgelegt ÷ gestartet.
    var m = { total: 0, verified: 0, complete: 0, handed: 0, pending: 0, failed: 0, discarded: 0, noIndex: 0, retries: 0, avgDurationMs: 0, avgCompleteMs: 0, rate: null, fileRate: null, lastVerifiedByShop: {}, lastSyncAt: 0, escalated: 0, integrity: { sha256: 0, size: 0, name: 0, mismatch: 0 }, verifyAvailable: null };
    var dur = 0, durN = 0, cdur = 0, cdurN = 0, lastVA = 0;
    (jobs || []).forEach(function (j) {
      if (!j) return;
      m.total++;
      switch (j.status) {
        case STATUS.VERIFIED: m.verified++; break;
        case STATUS.HANDED: m.handed++; break;
        case STATUS.FAILED: m.failed++; break;
        case STATUS.DISCARDED: m.discarded++; break;
        default: m.pending++; // sending, pending, unbekannt
      }
      if (j.status === STATUS.VERIFIED && j.complete === true) m.complete++;
      if (j.status === STATUS.VERIFIED && j.complete !== true) m.noIndex++;
      if (j.status === STATUS.VERIFIED && j.complete === true && j.completedAt && j.createdAt && j.completedAt >= j.createdAt) { cdur += j.completedAt - j.createdAt; cdurN++; }
      if (j.integrity && m.integrity[j.integrity] !== undefined) m.integrity[j.integrity]++;
      if ((j.verifyAvailable === true || j.verifyAvailable === false) && (j.updatedAt || 0) >= lastVA) { lastVA = j.updatedAt || 0; m.verifyAvailable = j.verifyAvailable; }
      m.retries += Math.max(0, (j.sends || 0) - 1) + (j.manualRetries || 0);
      if (j.status === STATUS.VERIFIED && j.verifiedAt && j.createdAt && j.verifiedAt >= j.createdAt) { dur += j.verifiedAt - j.createdAt; durN++; }
      if (j.status === STATUS.VERIFIED && j.shopId && (j.verifiedAt || 0) > (m.lastVerifiedByShop[j.shopId] || 0)) m.lastVerifiedByShop[j.shopId] = j.verifiedAt;
      var syncedAt = typeof j.syncedAt === 'number' ? j.syncedAt : j.syncedAt && typeof j.syncedAt.toMillis === 'function' ? j.syncedAt.toMillis() : 0;
      if (syncedAt > m.lastSyncAt) m.lastSyncAt = syncedAt;
      if (isOpen(j) && now - (j.createdAt || now) > POLICY.escalateMs) m.escalated++;
    });
    m.avgDurationMs = durN ? Math.round(dur / durN) : 0;
    m.avgCompleteMs = cdurN ? Math.round(cdur / cdurN) : 0;
    m.rate = m.total ? m.complete / m.total : null;
    m.fileRate = m.total ? m.verified / m.total : null;
    return m;
  }

  /**
   * Abgleich Archivierungsauftrag ↔ SharePoint ↔ Suchindex (rein, ohne Netz).
   *  jobs  = Monitor-Einträge (jobSummary) mit fileKey
   *  index = [{ key, uid, shopId, src, ts, hasKeys }]   (key = fileKeyOf(Dateiname) des Suchindex-Eintrags)
   *  sp    = Map(key → true/false) für die geprüften Dateien (nicht geprüft = fehlt in der Map)
   * → { issues: [{ code, level, key, archiveId, uid, shopId, repair }], counts }
   * repair: 'owner-device' = wird vom Gerät des Eigentümers automatisch und sicher nachgeholt; 'admin' = Prüfung nötig.
   * Es wird NIE ein Mitarbeiter automatisch neu zugeordnet.
   */
  function reconcile(input, now, pol) {
    input = input || {};
    pol = pol || POLICY;
    now = typeof now === 'number' ? now : Date.now();
    var jobs = (input.jobs || []).filter(function (j) { return j && j.fileKey; });
    var index = (input.index || []).filter(function (e) { return e && e.key; });
    var sp = input.sp || new Map();
    var issues = [];
    var idxBy = new Map();
    index.forEach(function (e) { idxBy.set(e.key, e); });
    var jobsBy = new Map();
    jobs.forEach(function (j) { if (!jobsBy.has(j.fileKey)) jobsBy.set(j.fileKey, []); jobsBy.get(j.fileKey).push(j); });
    var add = function (code, level, j, e, repair) {
      issues.push({ code: code, level: level, key: (j && j.fileKey) || (e && e.key) || '', archiveId: j ? j.archiveId : '', uid: (j && j.uid) || (e && e.uid) || '', shopId: (j && j.shopId) || (e && e.shopId) || '', repair: repair || 'admin' });
    };
    jobsBy.forEach(function (list, key) {
      var live = list.filter(function (j) { return j.status !== STATUS.DISCARDED; });
      if (live.length > 1) add('duplicate', 'warn', live[0], null, 'admin');
      var j = live[0] || list[0];
      if (j.status === STATUS.DISCARDED) return;
      var e = idxBy.get(key);
      var old = now - (j.handedAt || j.createdAt || now) >= pol.verifyGraceMs;
      if (sp.has(key) && sp.get(key) === false && old && j.status !== STATUS.PENDING && j.status !== STATUS.SENDING) add('job-missing-pdf', 'error', j, e, j.pdfLocal ? 'owner-device' : 'admin');
      if (sp.get(key) === true && !e) add('pdf-no-index', 'warn', j, null, 'backup');
      if (j.status === STATUS.VERIFIED && !e && !sp.has(key)) add('verified-not-searchable', 'warn', j, null, 'backup');
      if (e && e.hasKeys === false && j.status === STATUS.VERIFIED) add('verified-not-searchable', 'warn', j, e, 'backup');
      if (j.integrity === 'mismatch') add('integrity-mismatch', 'error', j, e, 'admin');
      if (e && e.shopId && j.shopId && e.shopId !== j.shopId) add('wrong-shop', 'error', j, e, 'admin');
      if (e && e.uid && j.uid && e.uid !== j.uid) add('wrong-employee', 'error', j, e, 'admin');
    });
    index.forEach(function (e) {
      if (sp.has(e.key) && sp.get(e.key) === false && now - (e.ts || now) >= pol.verifyGraceMs) {
        var hasJob = jobsBy.has(e.key);
        if (!hasJob || !issues.some(function (i) { return i.key === e.key && i.code === 'job-missing-pdf'; })) add('index-no-pdf', 'error', null, e, 'admin');
      }
    });
    var counts = {};
    issues.forEach(function (i) { counts[i.code] = (counts[i.code] || 0) + 1; });
    return { issues: issues, counts: counts };
  }

  /** Statustexte für die Oberfläche (einheitlich). */
  var LABEL = {
    sending: 'Archivierung läuft',
    handed: 'An Archiv übergeben – Bestätigung ausstehend',
    verified: 'In SharePoint abgelegt – Suchindex wird geprüft',
    complete: 'Erfolgreich archiviert',
    pending: 'Lokal gesichert – Versand ausstehend',
    failed: 'Archivierung fehlgeschlagen – Eingriff erforderlich',
    discarded: 'Bewusst verworfen'
  };

  /** Alte und neue Suchindex-Einträge auf ein Format bringen (abwärtskompatibel, ändert nichts in der Datenbank). */
  function normalizeIndexEntry(e) {
    e = e || {};
    var ts = Number(e.ts);
    if (!isFinite(ts) || ts <= 0) {
      var t2 = e.ts && typeof e.ts.toMillis === 'function' ? e.ts.toMillis() : Date.parse(e.ts || e.datum || '');
      ts = isFinite(t2) ? t2 : 0;
    }
    var typ = String(e.typ || e.type || '').toLowerCase();
    return {
      fileName: String(e.fileName || e.name || ''),
      typ: typ === 'abschluss' ? 'abschluss' : 'angebot',
      shopId: String(e.shopId || e.shop || '').toLowerCase(),
      uid: String(e.uid || e.userUid || e.archivedByUserId || ''),
      agent: String(e.agent || e.employeeName || ''),
      kunde: String(e.kunde || ''),
      ruf: String(e.ruf || ''),
      datum: String(e.datum || ''),
      src: e.src === 'import' ? 'import' : 'app',
      ts: ts,
      token: fileToken(e.fileName || e.name),
      legacyName: !fileToken(e.fileName || e.name)
    };
  }

  // ── technisches Protokoll (ohne Kundendaten) ───────────────────────────────
  var memLog = [];
  function logStore() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function logRead() {
    var ls = logStore();
    if (!ls) return memLog.slice();
    try { var a = JSON.parse(ls.getItem(LOG_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function log(evt) {
    var e = {
      t: Date.now(),
      archiveId: String(evt && evt.archiveId || '').slice(0, 40),
      uid: String(evt && evt.uid || '').slice(0, 64),
      shopId: String(evt && evt.shopId || '').slice(0, 40),
      step: String(evt && evt.step || '').slice(0, 30),
      status: String(evt && evt.status || '').slice(0, 20),
      code: String(evt && evt.code || '').slice(0, 60),
      attempt: Number(evt && evt.attempt) || 0
    };
    var cut = Date.now() - LOG_MAX_AGE_MS;
    var a = logRead().filter(function (x) { return x && x.t > cut; });
    a.push(e);
    a = a.slice(-LOG_MAX);
    var ls = logStore();
    if (ls) { try { ls.setItem(LOG_KEY, JSON.stringify(a)); } catch (er) {} } else memLog = a;
    return e;
  }

  // ── Speicher (IndexedDB; in Tests austauschbar) ──────────────────────────────
  function idbStore(name) {
    var dbP = null;
    function open() {
      if (dbP) return dbP;
      dbP = new Promise(function (resolve, reject) {
        if (!root.indexedDB) return reject(new Error('IndexedDB nicht verfügbar'));
        var req = root.indexedDB.open(name, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var s = db.createObjectStore(STORE, { keyPath: 'archiveId' });
            s.createIndex('byUid', 'uid');
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('IndexedDB blockiert')); };
      });
      dbP.catch(function () { dbP = null; });
      return dbP;
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(STORE, mode);
          var out;
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('abort')); };
          var r = fn(t.objectStore(STORE));
          if (r) r.onsuccess = function () { out = r.result; };
        });
      });
    }
    return {
      get: function (id) { return run('readonly', function (s) { return s.get(id); }); },
      put: function (rec) { return run('readwrite', function (s) { return s.put(rec); }).then(function () { return rec; }); },
      del: function (id) { return run('readwrite', function (s) { return s.delete(id); }); },
      all: function () { return run('readonly', function (s) { return s.getAll(); }).then(function (a) { return a || []; }); }
    };
  }
  function memoryStore() {
    var m = new Map();
    var clone = function (o) { return o ? Object.assign({}, o) : o; };
    return {
      get: function (id) { return Promise.resolve(clone(m.get(id))); },
      put: function (rec) { m.set(rec.archiveId, clone(rec)); return Promise.resolve(rec); },
      del: function (id) { m.delete(id); return Promise.resolve(); },
      all: function () { return Promise.resolve(Array.from(m.values()).map(clone)); },
      _map: m
    };
  }

  // ── Warteschlange ────────────────────────────────────────────────────────
  function createQueue(opts) {
    opts = opts || {};
    var store = opts.store || idbStore(opts.dbName || DB_NAME);
    var pol = Object.assign({}, POLICY, opts.policy || {});
    var clock = opts.now || function () { return Date.now(); };
    var rnd = opts.random || defaultRandom;
    var processing = null;
    var inflight = {}; // archiveId → true, solange in DIESEM Fenster ein Versand läuft (keine Doppelübertragung)

    // Felder, deren Änderung zentral gemeldet wird (Monitor). Reine Prüf-Zeitstempel lösen keine Meldung aus.
    var REV_FIELDS = ['status', 'sends', 'pendingRetries', 'manualRetries', 'errorKind', 'lastError', 'indexed', 'verifyAvailable', 'pdfRemoved', 'blockedReason', 'complete', 'indexIssue', 'backup', 'integrity'];
    var IMMUTABLE = ['archiveId', 'uid', 'email', 'employeeName', 'shopId', 'createdAt', 'fileName', 'consultationId', 'createdByUserId', 'fileKey', 'checksum', 'fileSize'];

    function upd(id, patch) {
      return store.get(id).then(function (cur) {
        if (!cur) return null;
        var next = Object.assign({}, cur, patch, { updatedAt: clock() });
        // Eigentümer und Identität eines Eintrags sind unveränderlich (nachträglich berechnete Schlüssel dürfen EINMAL gesetzt werden)
        IMMUTABLE.forEach(function (k) { if (cur[k] !== undefined && cur[k] !== '' && cur[k] !== 0) next[k] = cur[k]; });
        next.archiveStatus = next.status;
        if (REV_FIELDS.some(function (k) { return cur[k] !== next[k]; })) next.rev = (cur.rev || 0) + 1;
        return store.put(next);
      });
    }

    function createOne(rec) {
      var now = clock();
      return store.all().then(function (all) {
        var dup = all.find(function (x) { return x && x.fileName === rec.fileName && x.uid === rec.uid && x.status !== STATUS.DISCARDED; });
        if (dup) return Object.assign({ duplicate: true }, dup);
        var blob = rec.pdfBlob;
        return Promise.all([sha256Blob(blob), fileKeyOf(rec.fileName)]).then(function (h) {
          var r = Object.assign({
            archiveId: rec.archiveId || makeArchiveId(now, rnd),
            schemaVersion: SCHEMA_VERSION,
            status: STATUS.SENDING,
            sends: 0,
            pendingRetries: 0,
            createdAt: now,
            updatedAt: now,
            archivedAt: now,
            documentVersion: 1,
            documentType: rec.type === 'abschluss' ? 'abschluss' : 'angebot',
            retryCount: 0,
            rev: 1
          }, rec);
          r.archiveId = r.archiveId || makeArchiveId(now, rnd);
          r.createdByUserId = r.createdByUserId || r.uid;
          r.fileSize = blob && typeof blob.size === 'number' ? blob.size : 0;
          r.checksum = h[0] ? 'sha256:' + h[0] : '';
          r.fileKey = h[1] || '';
          r.archiveStatus = r.status;
          return store.put(r).then(function () {
            log({ archiveId: r.archiveId, uid: r.uid, shopId: r.shopId, step: 'create', status: r.status });
            return r;
          });
        });
      });
    }
    var createChain = Promise.resolve();
    // Datensparsamkeit: nach Bestätigung (PDF gelöscht) und vorhandenem Suchindex-Eintrag werden auch Kundenname und
    // Rufnummer aus dem lokalen Eintrag entfernt – angezeigt wird dann aus dem Suchindex.
    // v4: erst wenn vollständig archiviert UND eine Sicherungskopie des Suchindex-Eintrags im Backend liegt – sonst gingen
    //     Name/Nummer für eine spätere Reparatur verloren (Abschluss: Kundenname steht nicht im Dateinamen).
    function minimize(r) {
      if (!r || !isComplete(r) || !r.backup || (!r.kunde && !r.ruf)) return r;
      return upd(r.archiveId, { kunde: '', ruf: '' });
    }
    function mayAct(actor, r) { return !!actor && (actor.uid === r.uid || !!actor.isAdmin); }
    function forbidden() { return Object.assign(new Error('forbidden'), { code: 'forbidden' }); }

    var api = {
      store: store,
      policy: pol,
      /**
       * Neuen Eintrag anlegen (VOR dem Versand). Gleicher Dateiname eines noch nicht verworfenen Eintrags desselben
       * Benutzers → vorhandener Eintrag wird zurückgegeben (Schutz vor Doppelklick/doppelter Archivierung).
       */
      create: function (rec) {
        // nacheinander anlegen: zwei gleichzeitige Aufrufe (Doppeltipp) ergeben genau einen Eintrag
        var job = createChain.then(function () { return createOne(rec); });
        createChain = job.catch(function () {});
        return job;
      },
      get: function (id) { return store.get(id); },
      update: upd,
      all: function () { return store.all(); },
      /** Nur Einträge dieses Benutzers (Trennung der Mitarbeiterkonten auf geteilten Geräten). */
      listForUser: function (uid) {
        uid = String(uid || '');
        return store.all().then(function (a) { return a.filter(function (x) { return x && uid && x.uid === uid; }).sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); }); });
      },
      /** Zähler ohne Kundendaten (für Hinweise/Diagnose). */
      counts: function (uid) {
        return store.all().then(function (a) {
          var c = { own: {}, foreignOpen: 0 };
          a.forEach(function (x) {
            if (!x) return;
            if (uid && x.uid === uid) c.own[x.status] = (c.own[x.status] || 0) + 1;
            else if (isOpen(x)) c.foreignOpen++;
          });
          return c;
        });
      },
      /** Warnungen für einen Benutzer (eigene Einträge) bzw. alle (uid leer, Admin). */
      alerts: function (uid, storage) {
        return store.all().then(function (a) {
          return alerts(a.filter(function (x) { return x && (!uid || x.uid === uid); }), clock(), pol, storage);
        });
      },
      /** Manuell erneut senden (fehlgeschlagen/ausstehend). Nur Eigentümer oder Admin. */
      retry: function (id, actor) {
        return store.get(id).then(function (r) {
          if (!r) return null;
          if (!mayAct(actor, r)) throw forbidden();
          if (!r.pdfBlob) throw Object.assign(new Error('Keine PDF mehr gespeichert'), { code: 'nopdf' });
          if (r.status === STATUS.VERIFIED || r.status === STATUS.DISCARDED) return r;
          log({ archiveId: r.archiveId, uid: r.uid, shopId: r.shopId, step: 'retry-manual', status: STATUS.PENDING, attempt: r.sends });
          return upd(id, { status: STATUS.PENDING, pendingRetries: 0, lastTryAt: 0, nextTryAt: 0, blockedReason: '', errorKind: '', manualRetries: (r.manualRetries || 0) + 1, retryCount: (r.retryCount || 0) + 1, sends: Math.min(r.sends || 0, pol.maxSends - 1), lastVerifyOk: false });
        });
      },
      /**
       * Bewusst verwerfen (Bestätigung in der Oberfläche). Nur Eigentümer oder Admin, nie für bestätigte Einträge.
       * PDF und Kundendaten werden entfernt, der Eintrag bleibt als "verworfen" (mit wer/wann/Grund) 31 Tage sichtbar
       * und wird zentral gemeldet – so zählt er im Monitor nicht als Erfolg und ist nachvollziehbar.
       */
      discard: function (id, actor, reason) {
        return store.get(id).then(function (r) {
          if (!r) return false;
          if (!mayAct(actor, r)) throw forbidden();
          if (r.status === STATUS.VERIFIED) throw Object.assign(new Error('bereits archiviert'), { code: 'verified' });
          if (r.status === STATUS.DISCARDED) return true;
          var by = actor.uid === r.uid ? 'owner' : 'admin';
          log({ archiveId: r.archiveId, uid: r.uid, shopId: r.shopId, step: 'discard', status: r.status, code: by + ':' + String(reason || '').slice(0, 40) });
          return upd(id, { status: STATUS.DISCARDED, prevStatus: r.status, pdfBlob: null, pdfRemoved: true, kunde: '', ruf: '', discardedAt: clock(), discardedBy: String(actor.uid || ''), discardedRole: by, discardReason: String(reason || '').slice(0, 120) }).then(function () { return true; });
        });
      },
      /**
       * Admin: gesicherte PDF eines nicht bestätigbaren Eintrags von diesem Gerät entfernen (z. B. Speicher voll),
       * Metadaten bleiben, Status bleibt offen (zählt nicht als Erfolg). Protokolliert.
       */
      releasePdf: function (id, actor, reason) {
        return store.get(id).then(function (r) {
          if (!r) return null;
          if (!actor || !actor.isAdmin) throw forbidden();
          if (!r.pdfBlob) return r;
          log({ archiveId: r.archiveId, uid: r.uid, shopId: r.shopId, step: 'release-pdf', status: r.status, code: 'admin:' + String(reason || '').slice(0, 40) });
          return upd(id, { pdfBlob: null, pdfRemoved: true, pdfReleasedAt: clock(), pdfReleasedBy: String(actor.uid || ''), releaseReason: String(reason || '').slice(0, 120) });
        });
      },
      /**
       * Einen Durchlauf ausführen.
       * deps: {
       *   uid,                          aktuell angemeldeter Benutzer
       *   online: () => bool,
       *   send: rec => Promise<{ok, error?, code?}>,     Übergabe an den Archiv-Flow
       *   verify: names => Promise<{available, found:Set<id>}>,
       *   recordIndex: rec => Promise<bool>,             Suchindex-Eintrag mit uid/Shop DES EIGENTÜMERS
       *   indexCheck: rec => Promise<{exists,uid,shopId,searchable,backup}|null>  (v4) Suchindex prüfen (null = unbekannt)
       *   restoreIndex: rec => Promise<bool>,           (v4) Suchindex-Eintrag aus der Sicherung (pdf_index_backup) wiederherstellen
       *   syncJob: summary => Promise<bool>,             (optional) Statusmeldung an den zentralen Monitor (ohne Kundendaten)
       *   onEvent: ({type, rec}) => void
       * }
       * Fremde Einträge (anderer Benutzer am selben Gerät) werden mit ihren ORIGINALEN Angaben übergeben,
       * damit nichts verloren geht – die Zuordnung bleibt beim Eigentümer. Benachrichtigt wird nur der Eigentümer.
       */
      process: function (deps) {
        if (processing) return processing;
        deps = deps || {};
        var run = function () { return runProcess(deps); };
        // Mehrere Tabs/Fenster: nur einer arbeitet gleichzeitig (Web Locks, wo verfügbar)
        var locks = null;
        try { locks = opts.useLocks !== false && root.navigator && root.navigator.locks; } catch (e) { locks = null; }
        var job = locks ? locks.request('ps-archiv-queue', { ifAvailable: true }, function (lock) { return lock ? run() : { skipped: true }; }) : run();
        processing = Promise.resolve(job).then(function (r) { processing = null; return r; }, function (e) { processing = null; throw e; });
        return processing;
      }
    };

    function emit(deps, type, rec) {
      try { if (deps.onEvent && rec && rec.uid === deps.uid) deps.onEvent({ type: type, rec: rec }); } catch (e) {}
    }

    function failPatch(code, extra) {
      return Object.assign({ status: STATUS.FAILED, lastError: String(code).slice(0, 80), errorKind: classifyError(code) }, extra || {});
    }

    function doSend(deps, rec0) {
      var id = rec0.archiveId;
      if (inflight[id]) return store.get(id);
      inflight[id] = true;
      var release = function (x) { delete inflight[id]; return x; };
      return store.get(id).then(function (rec) {
        if (!rec) return null;
        var now = clock();
        // frischer Stand: inzwischen übergeben/bestätigt/verworfen oder sendet gerade ein anderes Fenster → nichts tun
        if (rec.status === STATUS.HANDED || rec.status === STATUS.VERIFIED || rec.status === STATUS.DISCARDED) return rec;
        if (rec.status === STATUS.SENDING && rec.sendStartedAt && now - rec.sendStartedAt < pol.staleSendingMs) return rec;
        if (!rec.pdfBlob) {
          log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'send', status: STATUS.FAILED, code: 'pdf-missing' });
          return upd(id, failPatch('pdf-missing', { blockedReason: 'nopdf' })).then(function (r) { emit(deps, 'failed', r); return r; });
        }
        var errs = validate(rec);
        if (errs.length) {
          log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'validate', status: STATUS.FAILED, code: errs.join(',') });
          return upd(id, failPatch('validation:' + errs.join(','), { blockedReason: 'validation' })).then(function (r) { emit(deps, 'failed', r); return r; });
        }
        if (deps.online && !deps.online()) {
          var n0 = (rec.pendingRetries || 0) + 1;
          return upd(id, { status: STATUS.PENDING, lastTryAt: now, nextTryAt: now + backoffDelay(n0, pol, rnd), lastError: 'offline', errorKind: 'offline', pendingRetries: n0 });
        }
        var attempt = (rec.sends || 0) + 1;
        return upd(id, { status: STATUS.SENDING, lastTryAt: now, sendStartedAt: now }).then(function () {
          log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'send', status: STATUS.SENDING, attempt: attempt });
          return Promise.resolve().then(function () { return deps.send(rec); }).catch(function (e) { return { ok: false, error: e }; });
        }).then(function (res) {
          if (res && res.ok === true) {
            log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'handed', status: STATUS.HANDED, attempt: attempt });
            return upd(id, { status: STATUS.HANDED, sends: attempt, retryCount: Math.max(0, attempt - 1) + (rec.manualRetries || 0), handedAt: clock(), lastError: '', errorKind: '', pendingRetries: 0, nextTryAt: 0, lastVerifyAt: 0, lastVerifyOk: false, sendStartedAt: 0 }).then(function (r) {
              // Suchindex nur unter der Anmeldung des Eigentümers schreiben (ein anderer Benutzer würde – je nach
              // Backend – als Eigentümer eingetragen). Fremde Einträge holt der Eigentümer bei seiner nächsten Anmeldung nach.
              if (r && !r.indexed && deps.recordIndex && r.uid === deps.uid) {
                return Promise.resolve().then(function () { return deps.recordIndex(r); }).catch(function () { return false; }).then(function (ok) {
                  return ok ? upd(id, { indexed: true, indexCheckedAt: clock() }) : r;
                });
              }
              return r;
            });
          }
          var code = (res && (res.code || (res.error && (res.error.code || res.error.name)))) || 'send-failed';
          var n = (rec.pendingRetries || 0) + 1;
          log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'send', status: STATUS.PENDING, code: String(code), attempt: attempt });
          return upd(id, { status: STATUS.PENDING, lastError: String(code).slice(0, 80), errorKind: classifyError(code), pendingRetries: n, lastTryAt: clock(), nextTryAt: clock() + backoffDelay(n, pol, rnd), sendStartedAt: 0 });
        });
      }).then(release, function (e) { release(); throw e; });
    }

    function applyVerify(deps, rec, v, stats) {
      var found = (v && v.found) || new Set();
      var avail = !!(v && v.available);
      var t = clock();
      var id = idOf(rec.fileName);
      if (avail && found.has(id)) {
        // v4: Integrität – Dateigröße und (falls vom Prüfdienst geliefert) SHA-256 müssen zur gesendeten PDF passen
        var integ = judgeIntegrity(rec, v.meta && typeof v.meta.get === 'function' ? v.meta.get(id) : null);
        if (integ === 'mismatch') {
          log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'verify', status: STATUS.FAILED, code: 'integrity-mismatch', attempt: rec.sends });
          return upd(rec.archiveId, failPatch('integrity-mismatch', { blockedReason: 'integrity', integrity: 'mismatch', verifyAvailable: true, lastVerifyOk: true, lastVerifyAt: t })).then(function (r) { if (stats) stats.failed++; emit(deps, 'failed', r); return r; });
        }
        log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'verify', status: STATUS.VERIFIED, code: 'integrity:' + integ, attempt: rec.sends });
        // PDF wird erst gelöscht, wenn die Ablage bestätigt ist (unverändert); Kundendaten bleiben bis "vollständig" + Sicherung
        return upd(rec.archiveId, { status: STATUS.VERIFIED, verifiedAt: t, durationMs: t - (rec.createdAt || t), verifyAvailable: true, lastVerifyOk: true, lastVerifyAt: t, pdfBlob: null, pdfRemoved: true, lastError: '', errorKind: '', integrity: integ, complete: false, lastIndexCheckAt: 0 }).then(function (r) {
          if (stats) stats.verified++;
          emit(deps, 'verified', r);
          return r;
        });
      }
      return upd(rec.archiveId, { lastVerifyAt: t, lastVerifyOk: avail, verifyAvailable: avail ? true : (rec.verifyAvailable === true ? true : false) });
    }

    /**
     * v4: Vollständigkeit eines in SharePoint bestätigten Eintrags prüfen und – nur sicher – reparieren.
     *  1) Suchindex korrekt → complete (Meldung "complete" an den Eigentümer); fehlt die Sicherungskopie und ist dies der
     *     Eigentümer, wird der Eintrag (mit Sicherung) neu geschrieben.
     *  2) fehlt/fehlerhaft → Wiederherstellung aus der unveränderlichen Sicherung (jeder berechtigte Mitarbeiter des Standorts),
     *     sonst – nur Eigentümer – neu schreiben. Eine falsche Zuordnung wird nie aus lokalen Angaben überschrieben.
     */
    function completeCheck(deps, rec, stats, noRepair) {
      var own = rec.uid === deps.uid;
      return Promise.resolve().then(function () { return deps.indexCheck(rec); }).catch(function () { return null; }).then(function (chk) {
        var t = clock();
        if (!chk) return upd(rec.archiveId, { lastIndexCheckAt: t });
        var j = judgeIndex(rec, chk);
        if (j.ok) {
          var was = rec.complete === true;
          return upd(rec.archiveId, { complete: true, completedAt: rec.completedAt || t, indexed: true, indexIssue: '', backup: !!chk.backup, lastIndexCheckAt: t, indexCheckedAt: t }).then(function (r) {
            if (!was) { log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'complete', status: STATUS.VERIFIED }); emit(deps, 'complete', r); }
            if (!chk.backup && own && deps.recordIndex && (r.kunde || r.ruf || !r.backup)) {
              return Promise.resolve().then(function () { return deps.recordIndex(r); }).catch(function () { return false; }).then(function () { return r; });
            }
            return minimize(r);
          });
        }
        log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'index-check', status: STATUS.VERIFIED, code: j.issue });
        var repair = Promise.resolve(false);
        if (noRepair) repair = Promise.resolve('skip');
        else if (chk.backup && deps.restoreIndex) repair = Promise.resolve().then(function () { return deps.restoreIndex(rec); }).catch(function () { return false; });
        return repair.then(function (ok) {
          if (ok === 'skip') return '';
          if (ok) return 'backup';
          if (own && deps.recordIndex && j.issue !== 'wrong-employee') return Promise.resolve().then(function () { return deps.recordIndex(rec); }).catch(function () { return false; }).then(function (x) { return x ? 'owner' : ''; });
          return '';
        }).then(function (how) {
          if (how) { if (stats) stats.indexRepaired++; log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'index-repair', status: STATUS.VERIFIED, code: how + ':' + j.issue }); }
          var wasC = rec.complete === true;
          return upd(rec.archiveId, { complete: false, indexIssue: j.issue, lastIndexCheckAt: t, indexCheckedAt: t, indexRepairs: (rec.indexRepairs || 0) + (how ? 1 : 0), backup: !!chk.backup }).then(function (r) {
            if (wasC && !how) emit(deps, 'incomplete', r);
            // nach erfolgreicher Reparatur sofort nachprüfen (ohne erneute Reparatur) – "vollständig" nur mit echtem Befund
            return how ? completeCheck(deps, r, stats, true) : r;
          });
        });
      });
    }

    function runProcess(deps) {
      var stats = { sent: 0, verified: 0, failed: 0, pending: 0, purged: 0, indexRepaired: 0, synced: 0 };
      var online = !(deps.online && !deps.online());
      return store.all().then(function (all) {
        var now = clock();
        var work = all.filter(Boolean).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        var chain = Promise.resolve();
        // 1) Versand / Wiederholung / Aufräumen
        var toVerify = [];
        var indexChecks = 0;
        work.forEach(function (rec) {
          var act = nextAction(rec, now, pol, { online: online });
          if (act === 'send' || act === 'resend') {
            chain = chain.then(function () {
              var pre = Promise.resolve();
              if (act === 'resend') {
                log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'resend', status: STATUS.PENDING, code: 'not-found-after-grace', attempt: rec.sends });
                // gleicher Dateiname → idempotent (keine zweite, abweichende Archivierung)
                pre = upd(rec.archiveId, { status: STATUS.PENDING, lastError: 'not-found-after-grace', errorKind: 'temporary', nextTryAt: 0, lastVerifyOk: false });
              }
              return pre.then(function () { return doSend(deps, rec); }).then(function (r) { if (r && r.status === STATUS.HANDED) stats.sent++; else if (r && r.status === STATUS.PENDING) stats.pending++; });
            });
          } else if (act === 'verify') {
            toVerify.push(rec);
          } else if (act === 'fail') {
            chain = chain.then(function () {
              var code = rec.pdfBlob ? 'not-found-in-archive' : 'pdf-missing';
              log({ archiveId: rec.archiveId, uid: rec.uid, shopId: rec.shopId, step: 'verify', status: STATUS.FAILED, code: code, attempt: rec.sends });
              return upd(rec.archiveId, failPatch(code)).then(function (r) { stats.failed++; emit(deps, 'failed', r); });
            });
          } else if (act === 'purgePdf') {
            chain = chain.then(function () {
              return upd(rec.archiveId, { pdfBlob: null, pdfRemoved: true, pdfRemovedAt: clock() }).then(function () { stats.purged++; });
            });
          } else if (act === 'purge') {
            chain = chain.then(function () { return store.del(rec.archiveId).then(function () { stats.purged++; }); });
          }
          var own = rec.uid === deps.uid;
          // Suchindex für eigene, bereits übergebene Einträge nachholen (z. B. war beim Archivieren Firestore nicht erreichbar)
          if (act !== 'send' && act !== 'resend' && act !== 'purge' && own && !rec.indexed && (rec.status === STATUS.HANDED || rec.status === STATUS.VERIFIED) && deps.recordIndex && online) {
            chain = chain.then(function () {
              return Promise.resolve().then(function () { return deps.recordIndex(rec); }).catch(function () { return false; }).then(function (ok) { if (ok) return upd(rec.archiveId, { indexed: true, indexCheckedAt: clock() }).then(minimize); });
            });
          }
          // v4: Vollständigkeit prüfen (Suchindex vorhanden, richtige Zuordnung, auffindbar) und ggf. reparieren.
          //     Auch für Einträge anderer Mitarbeiter dieses Geräts: Wiederherstellung aus der Sicherung ist für jeden
          //     berechtigten Mitarbeiter des Standorts erlaubt (Regeln), nie mit fremder Zuordnung.
          if (rec.status === STATUS.VERIFIED && act !== 'purge' && deps.indexCheck && online && indexChecks < pol.perRunLimit) {
            var due = rec.complete
              ? now - (rec.indexCheckedAt || 0) >= pol.indexCheckEveryMs
              : now - (rec.lastIndexCheckAt || 0) >= (now - (rec.verifiedAt || now) > pol.verifySlowAfterMs ? pol.verifySlowEveryMs : pol.verifyEveryMs);
            if (due) {
              indexChecks++;
              chain = chain.then(function () { return store.get(rec.archiveId); }).then(function (cur) {
                return cur && cur.status === STATUS.VERIFIED ? completeCheck(deps, cur, stats) : null;
              });
            }
          }
        });
        // 2) Ablage prüfen (gebündelt: EIN Aufruf für bis zu 40 Dateien)
        return chain.then(function () {
          if (!toVerify.length || !deps.verify || !online) return;
          var names = toVerify.map(function (r) { return r.fileName; });
          return Promise.resolve().then(function () { return deps.verify(names); }).catch(function () { return { available: false, found: new Set() }; }).then(function (v) {
            return toVerify.reduce(function (p, rec) {
              return p.then(function () { return store.get(rec.archiveId); }).then(function (cur) {
                if (!cur || cur.status !== STATUS.HANDED) return null; // inzwischen anders erledigt
                return applyVerify(deps, cur, v, stats).then(function (r) {
                  // v4: frisch abgelegt → Vollständigkeit gleich im selben Durchlauf prüfen
                  return r && r.status === STATUS.VERIFIED && deps.indexCheck ? completeCheck(deps, r, stats) : r;
                });
              });
            }, Promise.resolve());
          });
        });
      }).then(function () {
        // 3) Statusmeldung an den zentralen Monitor (nur eigene Einträge, nur bei Änderung, begrenzt je Durchlauf)
        if (!deps.syncJob || !online) return;
        return store.all().then(function (all) {
          var todo = all.filter(function (r) { return r && r.uid === deps.uid && (r.rev || 1) !== r.syncedRev; }).slice(0, pol.perRunLimit);
          return todo.reduce(function (p, r) {
            return p.then(function () {
              var keyP = r.fileKey ? Promise.resolve(r.fileKey) : fileKeyOf(r.fileName);
              return keyP.then(function (k) {
                var rr = k && !r.fileKey ? Object.assign({}, r, { fileKey: k }) : r;
                return Promise.resolve().then(function () { return deps.syncJob(jobSummary(rr)); }).catch(function () { return false; }).then(function (ok) {
                  if (!ok) return null;
                  stats.synced++;
                  // syncedRev setzen OHNE neue Revision auszulösen (direkt speichern, Identität bleibt)
                  return store.get(r.archiveId).then(function (cur) {
                    if (!cur) return null;
                    var next = Object.assign({}, cur, { syncedRev: r.rev || 1, syncedAt: clock() });
                    if (!cur.fileKey && k) next.fileKey = k;
                    return store.put(next);
                  });
                });
              });
            });
          }, Promise.resolve());
        });
      }).then(function () { return stats; });
    }

    /** Einen einzelnen Eintrag sofort prüfen (Bestätigungsanzeige direkt nach dem Archivieren). */
    api.verifyNow = function (id, deps) {
      return store.get(id).then(function (rec) {
        if (!rec) return null;
        var finish = function (r) {
          // v4: direkt nach der Ablage auch die Vollständigkeit prüfen (Anzeige "Erfolgreich archiviert" erst danach)
          if (r && r.status === STATUS.VERIFIED && !r.complete && deps && deps.indexCheck) return completeCheck(deps, r, null);
          return r;
        };
        if (rec.status === STATUS.VERIFIED) return finish(rec);
        if (rec.status !== STATUS.HANDED || !deps || !deps.verify) return rec;
        return Promise.resolve().then(function () { return deps.verify([rec.fileName]); }).catch(function () { return { available: false, found: new Set() }; }).then(function (v) {
          return applyVerify(deps, rec, v, null);
        }).then(finish);
      });
    };
    /** Einen einzelnen Eintrag sofort senden (erster Versuch direkt beim Archivieren). */
    api.sendNow = function (id, deps) {
      return store.get(id).then(function (rec) {
        if (!rec) return null;
        if (rec.status === STATUS.HANDED || rec.status === STATUS.VERIFIED || rec.status === STATUS.DISCARDED) return rec;
        return doSend(deps || {}, rec);
      });
    };
    return api;
  }

  var API = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STATUS: STATUS,
    LABEL: LABEL,
    POLICY: POLICY,
    localDate: localDate,
    makeToken: makeToken,
    makeArchiveId: makeArchiveId,
    uniqueFileName: uniqueFileName,
    fileToken: fileToken,
    stripToken: stripToken,
    kennungOf: kennungOf,
    baseFileName: baseFileName,
    idOf: idOf,
    validate: validate,
    isPdfBlob: isPdfBlob,
    checkPdf: checkPdf,
    nextAction: nextAction,
    isOpen: isOpen,
    isComplete: isComplete,
    judgeIndex: judgeIndex,
    judgeIntegrity: judgeIntegrity,
    backoffDelay: backoffDelay,
    classifyError: classifyError,
    alerts: alerts,
    jobSummary: jobSummary,
    filterJobs: filterJobs,
    computeMetrics: computeMetrics,
    reconcile: reconcile,
    sha256Text: sha256Text,
    sha256Blob: sha256Blob,
    fileKeyOf: fileKeyOf,
    normalizeIndexEntry: normalizeIndexEntry,
    log: log,
    readLog: logRead,
    memoryStore: memoryStore,
    idbStore: idbStore,
    createQueue: createQueue
  };
  var _default = null;
  /** Standard-Warteschlange des Browsers (IndexedDB, je Marke eigene Datenbank). */
  API.queue = function (brand) {
    if (!_default) _default = createQueue({ dbName: DB_NAME + '_' + String(brand || 'o2') });
    return _default;
  };
  /** Speicherstand des Geräts für diese App (null = unbekannt). */
  API.storageInfo = function () {
    try {
      var st = root.navigator && root.navigator.storage;
      if (!st || typeof st.estimate !== 'function') return Promise.resolve(null);
      return st.estimate().then(function (e) { return e && e.quota ? { usage: e.usage || 0, quota: e.quota } : null; }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  };
  /**
   * Dauerhaften Speicher anfordern: ohne diese Freigabe darf der Browser IndexedDB bei Speichermangel (und Safari bei
   * nicht installierten Seiten nach 7 Tagen ohne Nutzung) leeren – dann wären gesicherte, unbestätigte PDFs weg.
   * → Promise<true|false|null>  (null = nicht unterstützt)
   */
  API.requestPersistence = function () {
    try {
      var st = root.navigator && root.navigator.storage;
      if (!st || typeof st.persist !== 'function') return Promise.resolve(null);
      return (typeof st.persisted === 'function' ? st.persisted() : Promise.resolve(false)).then(function (p) { return p ? true : st.persist(); }).then(function (x) { return !!x; }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  };
  root.PSArchivQueue = API;
})(typeof window !== 'undefined' ? window : globalThis);
