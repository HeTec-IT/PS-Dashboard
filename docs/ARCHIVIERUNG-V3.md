# Archivierung v3 – Datensicherheit, Standort-Synchronisation, Monitor

Stand: 28.11.2026 · o2 `index.html` 55.170 · Hall `index-neu.html` 56.0-beta.7 · Telekom/Fachhandel `index.html` 57.10
Baut auf dem Archiv-Ausgang vom 27.11.2026 (55.169 / 56.0-beta.6 / 57.9) auf. Backup vor v3: Branch `backup/vor-archiv-v2-20261128`.

## 1. Verarbeitungskette

```
Archivieren → archiveId + eindeutiger Dateiname (…--HHMMxyz) → PDF-Prüfung (%PDF … %%EOF, Größe, SHA-256)
  → Eintrag in IndexedDB (PDF + Metadaten, VOR dem Versand)            Status: läuft
  → Archiv-Flow (no-cors, Antwort unlesbar)                            Status: An Archiv übergeben – Bestätigung ausstehend
  → Prüfflow "PDF Archiv API V3" Aktion exists findet GENAU diese Datei Status: Erfolgreich archiviert → PDF lokal gelöscht
  → Suchindex pdf_index (uid + Standort des Eigentümers) + Monitor archiv_jobs (ohne Kundendaten)
```

Kein Netz → *Lokal gesichert – Versand ausstehend*; Fehler → *Automatischer Wiederholungsversuch* (Backoff 30 s … 30 Min. ± 25 %);
nach Frist nicht gefunden → gleicher Dateiname erneut (max. 3 Versände) → *Archivierung fehlgeschlagen – Eingriff erforderlich*
(PDF bleibt, „Erneut senden“).

## 2. Was v3 ändert

| Bereich | Vorher (27.11.) | Jetzt |
|---|---|---|
| Unbestätigte PDFs | ohne Prüfmöglichkeit nach 7 Tagen gelöscht (`keepUnverifiablePdfMs`) | **nie** altersbedingt gelöscht; Warnung (2 h / 24 h), Eskalation (72 h) im Monitor, Speicher-Warnung, dauerhafter Speicher angefordert (`navigator.storage.persist`) |
| Erneuter Versand | auch wenn der Prüfdienst nur gestört war | nur nach einer echten Antwort „nicht gefunden“ |
| Wiederholung | feste Abstände | Backoff + Jitter, Fehlerklassen (vorübergehend / Anmeldung / Eingriff), sofort bei Rückkehr der Verbindung |
| o2: 90-s-Dublettenschutz | konnte eine Wiederholung als „übergeben“ melden, ohne zu senden | gilt nicht mehr für den Archiv-Ausgang (der verhindert Dubletten selbst) |
| PDF-Prüfung | nur `%PDF`-Kopf | Kopf **und** `%%EOF` (abgeschnittene Dateien), Größe, SHA-256, Dateigröße in den Metadaten |
| Verwerfen | Rückfrage | Grund Pflicht + Rückfrage, Eintrag bleibt 31 Tage als „verworfen“, protokolliert, im Monitor sichtbar |
| Suchindex fehlt nachträglich | blieb unbemerkt | Gerät des Eigentümers prüft alle 6 h und schreibt ihn neu (nur eigene Archivierungen) |
| Monitor | nur lokale IndexedDB | zentral: Firestore `archiv_jobs` (ohne Kundendaten), Kennzahlen, Filter, Abgleich |
| Telekom-Bestätigung | fester Schalter `PS_ARCH_EXISTS_AKTIV = false` | automatische Erkennung: nur eine gültige Antwort `{ok:true, found:[…]}` zählt; Ergebnis gemerkt (ja 24 h, nein 1 h) |
| Telekom-Suche | jeder Mitarbeiter im eingestellten Gerätestandort | nur freigegebene Standorte (Profil-Filiale + Zusatzfilialen; Springer/Admin alle) |
| Hall-Suche | ohne Standortbegrenzung (v55.44 fehlte), ohne Sicherheitsnetz (v55.41) | wie `index.html` |

## 3. Firestore (extern – bitte einspielen)

Die App funktioniert ohne diese Regeln weiter; der Monitor bleibt dann leer (Meldungen pausieren nach „permission-denied“ 6 h).

### 3.1 `archiv_jobs` (Projekte `o2-pencil-selling` und `pencil-selling-telekom`)

```
match /archiv_jobs/{archiveId} {
  // Mitarbeiter schreiben NUR eigene Vorgänge, keine fremde uid, keine Kundendaten-Felder
  allow create, update: if request.auth != null
    && request.resource.data.uid == request.auth.uid
    && request.resource.data.archiveId == archiveId
    && !request.resource.data.keys().hasAny(['kunde', 'ruf', 'fileName', 'email', 'pdf'])
    && (resource == null || resource.data.uid == request.auth.uid);
  allow read: if isAdmin();          // nur Administratoren (Monitor)
  allow delete: if false;
}
```

`isAdmin()` = vorhandene Admin-Prüfung der Regeln (z. B. `get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'`).
Index (optional, für große Zeiträume): `archiv_jobs (createdAt ↑)` – Einzelfeld, wird automatisch angelegt.

### 3.2 `pdf_index` – serverseitige Standortprüfung (Vorschlag, bestehende Regeln prüfen!)

Die Kundensuche filtert in der App nach Standort. **Schutz gegen Manipulation bietet nur die Regel.** Die aktuellen Regeln lagen
nicht vor und konnten nicht geprüft werden. Empfohlen (Felder wie im Profil `users/{uid}`):

```
function prof() { return get(/databases/$(database)/documents/users/$(request.auth.uid)).data; }
function shopOk(shop) {
  return prof().role == 'admin' || prof().springer == true || prof().shopwechsel == true
      || prof().shopId == shop || (prof().extraShopIds is list && shop in prof().extraShopIds);
}
match /pdf_index/{id} {
  allow read: if request.auth != null && (shopOk(resource.data.shopId) || resource.data.uid == request.auth.uid);
  allow create: if request.auth != null && request.resource.data.uid == request.auth.uid && shopOk(request.resource.data.shopId);
  allow update: if request.auth != null && resource.data.uid == request.auth.uid
                && request.resource.data.uid == resource.data.uid;            // Zuordnung unveränderlich
  allow delete: if prof().role == 'admin';
}
```

Abfragen der App (`where('shopId','==',X)`, `where('uid','==',ich)`) sind mit dieser Regel kompatibel. Vor dem Einspielen im
Regel-Simulator testen: Mitarbeiter Crailsheim liest Aalen → verweigert; liest Crailsheim → erlaubt; Admin → erlaubt.

## 4. Telekom: Prüfflow „PDF Archiv API V3 Telekom“ – Aktion `exists`

Die App erkennt selbst, ob der Flow `exists` kann. **Keine App-Änderung nötig**, sobald der Flow korrekt antwortet.
Nicht getestet (kein Zugriff auf den Flow). Bis dahin: „An Archiv übergeben – Bestätigung ausstehend“, PDF bleibt auf dem Tablet.

**Empfohlen:** im o2-Flow „PDF Archiv API V3“ den Zweig `exists` (Switch-Fall) kopieren („In Zwischenablage kopieren“) und im
Telekom-Flow als neuen Fall einfügen; nur Website-Adresse (`/sites/PencilSellingArchivierungFachhandel`) und Bibliothek anpassen.

Falls neu gebaut:

1. **Flow:** PDF Archiv API V3 Telekom (HTTP-Trigger, gleiche URL). Bestehende Login-Prüfung (idToken) bleibt **vor** dem Switch.
2. **Trigger-Schema** um `names` ergänzen:
   `{"type":"object","properties":{"action":{"type":"string"},"idToken":{"type":"string"},"names":{"type":"array","items":{"type":"string"}}}}`
3. **Switch** auf `triggerBody()?['action']`, neuer Fall `exists`.
4. **Begrenzen:** `take(coalesce(triggerBody()?['names'], createArray()), 40)`; jeden Namen prüfen: nur `^PENCIL_[A-Za-z0-9_+\-]+\.pdf$`.
5. **SharePoint-Abfrage** je Name (Apply to each, Parallelität 10) – „HTTP-Anforderung an SharePoint senden“, GET:
   `_api/web/lists/GetByTitle('Dokumente')/items?$select=FileLeafRef,File/Length&$expand=File&$filter=FileLeafRef eq '@{replace(items('Apply_to_each'),'''','''''')}'&$top=1`
   (Bibliothek ggf. anders benannt; bei > 5000 Dateien stattdessen den Ordner aus dem Dateinamen bilden – Shop/Typ/Datum stehen
   an fester Stelle – und `GetFileByServerRelativeUrl(…)` verwenden.)
6. **Gefundene sammeln:** Bedingung `length(body('HTTP')?['d']?['results']) > 0` → Array-Variable `found` um den Namen ergänzen.
7. **Antwort** (Aktion „Antwort“), Status 200, Header `Access-Control-Allow-Origin: *`, `Content-Type: application/json`:
   `{"ok": true, "found": @{variables('found')}}` – `found` enthält die **Original-Dateinamen**.
8. **Fehler** (Bereich „Catch“, ausführen bei Fehler/Zeitüberschreitung): Status 500, `{"ok": false, "error": "server"}`.
   Unbekannte Aktion: Status 400, `{"ok": false, "error": "action"}`. Niemals `{"ok": true}` ohne `found` liefern.
9. **Tests:** (a) vorhandene Datei → in `found`; (b) erfundener Name → nicht in `found`; (c) 40 Namen gemischt; (d) ohne/abgelaufenes
   idToken → 401; (e) Name mit `'` → kein Fehler; (f) App: Archivieren → nach ≤ 1 Min. „Erfolgreich archiviert“.

## 5. Sicherheitsbefunde

| # | Befund | Risiko | Empfehlung |
|---|---|---|---|
| S1 | Archiv-Upload-Flow ist nur durch URL-Signatur + festen Schlüssel geschützt; beides steht im öffentlich ausgelieferten Code (GitHub Pages, Repos öffentlich). | Fremde könnten PDFs/Dateinamen ins Archiv schreiben (Spam, irreführende Dateien). | Im Upload-Flow – wie im V3-Flow – das Firebase-idToken prüfen; Schlüssel danach entfernen. Bei vorhandenem Dateinamen nicht überschreiben. |
| S2 | Serverseitige Standortregeln für `pdf_index` nicht einsehbar. | Clientseitiger Filter allein schützt nicht. | Regeln aus 3.2 prüfen/einspielen. |
| S3 | Repos `PS-Dashboard`, `PS-Dashboard-Telekom` (und `Sales.HeTec`) sind öffentlich. | Code, Flow-Adressen, Konfiguration einsehbar. | Repos privat stellen (GitHub Pages braucht dafür einen kostenpflichtigen Plan) bzw. Umzug Azure. |
| S4 | Lokale PDFs liegen unverschlüsselt in IndexedDB (nur bis zur Bestätigung). | Zugriff nur mit entsperrtem Gerät + Browserprofil. | Geräte-PIN/MDM; v3 löscht nach Bestätigung, Kundendaten werden minimiert. |

Keine neuen Endpunkte, keine neuen Secrets, keine Kundendaten im Monitor oder im technischen Protokoll.

## 6. Tests

```
node --test tests/*.test.mjs                       # Modul (47 Tests, ohne Abhängigkeiten)
npm i --no-save playwright@1.63.0 react@18.3.1 react-dom@18.3.1 html2pdf.js@0.10.1 pdf-lib@1.17.1 pdfjs-dist@2.16.105
PW_CHROME=/pfad/zu/chrome PS_BRAND=o2 PS_FILE=index.html     node --test tests/e2e/archiv-v3.e2e.mjs
PW_CHROME=/pfad/zu/chrome PS_BRAND=o2 PS_FILE=index-neu.html node --test tests/e2e/archiv-v3.e2e.mjs
PW_CHROME=/pfad/zu/chrome PS_BRAND=telekom PS_FILE=index.html node --test tests/e2e/archiv-v3.e2e.mjs   # im Telekom-Repo
```

Browser-Tests laufen gegen die echte `index.html` in Chromium, mit Firebase-Testersatz (**ohne** Firestore-Regeln) und
Power-Automate-/SharePoint-Attrappen. Nicht abgedeckt: echte Flows, echtes SharePoint, Firestore-Regeln, Safari/iPadOS,
Samsung-Browser, geschlossene PWA.

## 7. Rückweg

`git revert` des v3-Commits oder `main` auf `backup/vor-archiv-v2-20261128` setzen. IndexedDB-Einträge v3 sind abwärtskompatibel
(v2 liest sie; v2 würde unbestätigte PDFs ohne Prüfmöglichkeit wieder nach 7 Tagen löschen).
