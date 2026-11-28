# Archivierung V4 – vollständige Archivierung, zentrale Reparatur, Regeln, Absicherung

Stand 28.11.2026 · o2 `index.html` **55.171** · Hall `index-neu.html` **56.0-beta.8** · Telekom `index.html` **57.11**
Baut auf V3 auf (docs/ARCHIVIERUNG-V3.md). Backup vor V4: Branch `backup/vor-archiv-v4-20261128`.

## 1. Was V4 ändert

| Punkt | Lösung |
|---|---|
| 1 Quote | Zwei Stufen: **„In SharePoint abgelegt“** (Datei per `exists` bestätigt) und **„Erfolgreich archiviert“** = zusätzlich Suchindex vorhanden, Mitarbeiter **und** Standort stimmen, Eintrag über die Kundensuche auffindbar. Archivierungsquote = vollständig ÷ gestartet; Ablagequote getrennt. Anzeige, Toast und Monitor zeigen „Erfolgreich“ nur bei vollständiger Archivierung. |
| 2 Reparatur | Jeder Suchindex-Eintrag wird zusätzlich als **unveränderliche Sicherung** (`pdf_index_backup`, nur anlegen) gespeichert. Reparatur = exakte Kopie der Sicherung → Name/Nummer bleiben suchbar, Zuordnung bleibt original. Möglich durch **jedes berechtigte Gerät des Standorts** (auch über die Kundensuche: Treffer aus der Sicherung werden angezeigt und zurückgeschrieben) und durch den Admin („Suchindex aus Sicherung wiederherstellen“). Lokale Kundendaten werden erst entfernt, wenn die Sicherung existiert. |
| 3 Telekom | App erkennt `exists` selbst (seit V3). V4: vorübergehende Fehler (429/5xx/Netz) gelten nicht mehr als „Flow kann es nicht“. Der Monitor zeigt „Prüfdienst exists: verfügbar / nicht verfügbar“ → daran sehen Sie nach dem Flow-Update, ob es wirkt. |
| 4 Regeln | `firestore/firestore.rules` – im Firestore-Emulator getestet (11 Tests, GitHub Actions). |
| 5 Integrität | Prüfdienst darf `found: [{ name, size, sha256 }]` liefern. Größe/Prüfsumme werden mit der gesendeten PDF verglichen; Abweichung → „fehlgeschlagen – Eingriff erforderlich“, PDF bleibt. Liefert der Flow nur Namen, steht im Monitor ehrlich „Integrität: Name“. Der Upload sendet jetzt `fileSize` und `sha256` mit. |
| 6 IndexedDB | Kein ungesicherter Direktversand mehr. Zweiter Versuch nach 0,4 s; danach eindeutige Meldung, Vorgang bleibt geöffnet. |
| 7 Kennung | Uhrzeit + **8** Zufallszeichen (z. B. `--1415k7q2m9xa`), 36⁸ ≈ 2,8 Billionen je Minute. Gleiche Position im Dateinamen, nur `[0-9a-z]` → Flow-Teile unverändert; alte Kennzeichen bleiben gültig. |
| 8 Schnittstellen | Upload sendet zusätzlich `archiveId`, `ownerUid`, `senderUid`, `appVersion` und das **Firebase-Anmelde-Token** (`idToken`). Konsolenprotokoll ohne Dateinamen/Kundendaten. Absicherung im Flow: Abschnitt 4. |

## 2. Firebase – was Sie einstellen müssen (beide Projekte)

1. **Firebase-Konsole → Projekt `o2-pencil-selling` → Firestore → Regeln.** Den Abschnitt zwischen `BEGIN PENCIL ARCHIV` und
   `END PENCIL ARCHIV` aus `firestore/firestore.rules` **innerhalb** von `match /databases/{database}/documents { … }` einfügen.
   Vorhandene Blöcke für `pdf_index`, `pdf_index_backup`, `archiv_jobs`, `users` **ersetzen**. Alle anderen Blöcke stehen lassen.
2. **Prüfen, ob es einen Sammelblock gibt** wie `match /{document=**} { allow read, write: if request.auth != null; }`. Er hebt die
   Standortprüfung auf (Regeln werden ODER-verknüpft) → entfernen bzw. durch einzelne Blöcke je Sammlung ersetzen.
3. **Regel-Simulator** (Regeln → „Simulator“): `get /pdf_index/<Dokument eines anderen Shops>` als Mitarbeiter → *abgelehnt*.
4. **Veröffentlichen.** Dasselbe für `pencil-selling-telekom`.
5. **Profile prüfen:** App → Meine Statistik → Archiv → Archiv-Diagnose → „Suchindex analysieren“ → Abschnitt
   **„Mitarbeiter-Profile ohne gültige Filiale“**. Jede dort gelistete Person im Admin-Dashboard auf die richtige Shop-Kennung
   setzen (`users/{uid}.shopId`, z. B. `crailsheim`, `fh-ellwangen`) bzw. Springer markieren. *Telekom:* Bei der Registrierung
   wurde die damals am Tablet eingestellte Filiale gespeichert (Standard Telekom Crailsheim) – bitte besonders prüfen.
6. **In der App testen** (Mitarbeiter-Login): Archivsuche → Systemprüfung → „Fremde Standorte gesperrt: ok“.
7. Danach in der Archiv-Diagnose „Monitor laden“ – Vorgänge erscheinen ab jetzt; „Suchindex aus Sicherung wiederherstellen“ wirkt
   für Archivierungen ab V4 (ältere haben keine Sicherung; dafür bleibt der bisherige Admin-Abgleich aus der SharePoint-Dateiliste).

Was die Regeln durchsetzen: Kundensuche nur eigener/freigegebener Standort (Profil-Filiale, `extraShopIds`, `allowedShopIds`;
Springer/Shopwechsel/Admin alle), eigene Archivierungen immer; Suchindex schreiben nur mit eigener UID und freigegebenem Standort;
Sicherung nur anlegen; Wiederherstellung nur als exakte Kopie; Monitor schreiben nur eigene Vorgänge ohne Kundendaten, lesen nur
Admin; Profile: Standort/Rolle/Freigabe/Springer ändert nur der Admin. Kosten: jede Abfrage liest einmal das eigene Profil (1 Lesezugriff).

## 3. Power Automate – Prüfflows (`exists`)

### 3.1 Telekom: „PDF Archiv API V3 Telekom“ braucht die Aktion `exists`

Prüfen, ob sie schon da ist: Nach dem Update in der Telekom-App archivieren → Archiv-Diagnose → Monitor laden → Kachel
**„Prüfdienst exists“**. *verfügbar* = fertig. *nicht verfügbar* = folgende Schritte. (Von hier aus nicht prüfbar: der Flow ist
nur mit gültigem HeTec-Login erreichbar, das Testsystem hat keinen Zugang.)

**Weg A (empfohlen, ca. 10 Min.):** o2-Flow „PDF Archiv API V3“ öffnen → im Schalter (Switch) auf `action` den Fall **exists** →
„…“ → **In Zwischenablage kopieren**. Telekom-Flow öffnen → Switch → **Fall hinzufügen** → Wert `exists` → Einfügen. In den
eingefügten SharePoint-Aktionen **Websiteadresse** auf `…/sites/PencilSellingArchivierungFachhandel` und **Bibliothek** auf die
Telekom-Archivbibliothek umstellen. Speichern.

**Weg B (neu bauen), im Fall `exists`:**
1. *Compose* `Namen` = `take(coalesce(triggerBody()?['names'], createArray()), 40)`
2. *Variable initialisieren* `found`, Typ Array, Wert `[]` (vor dem Switch, sonst nicht erlaubt)
3. *Apply to each* über `outputs('Namen')`, Parallelität 10:
   - *Bedingung* `isMatch` ist in Power Automate nicht verfügbar → stattdessen *Bedingung*: `startsWith(items('Apply_to_each'), 'PENCIL_')` **und** `endsWith(items('Apply_to_each'), '.pdf')`
   - *HTTP-Anforderung an SharePoint senden*: Website = Fachhandel-Archiv, Methode GET, URI
     `_api/web/lists/GetByTitle('Dokumente')/items?$select=FileLeafRef,File/Length&$expand=File&$top=1&$filter=FileLeafRef eq '@{replace(items('Apply_to_each'),'''','''''')}'`
     (Bibliotheksname anpassen; bei mehr als 5.000 Dateien in der Bibliothek stattdessen `GetFileByServerRelativeUrl('/sites/…/<Ordner>/<Name>')` mit dem Ordner aus dem Dateinamen)
   - *Bedingung* `length(body('HTTP-Anforderung_an_SharePoint_senden')?['d']?['results'])` ist größer als 0 →
     *An Arrayvariable anfügen* `found` = `{"name": "@{items('Apply_to_each')}", "size": @{first(body('HTTP-Anforderung_an_SharePoint_senden')?['d']?['results'])?['File']?['Length']}}`
4. *Antwort*: Status 200, Header `Access-Control-Allow-Origin: *` und `Content-Type: application/json`, Text
   `{"ok": true, "found": @{variables('found')}}`
5. Fehlerzweig (*Bereich* „Catch“, „Ausführen nach“: fehlgeschlagen/Zeitüberschreitung): *Antwort* 500 `{"ok": false, "error": "server"}`.
   Unbekannte Aktion (Standardfall des Switch): 400 `{"ok": false, "error": "action"}`. **Nie** `{"ok": true}` ohne `found`.
6. Testfälle: vorhandene Datei → in `found` mit `size`; erfundener Name → nicht in `found`; 40 Namen gemischt; Name mit `'`;
   ohne/abgelaufenes `idToken` → 401; danach in der App archivieren → nach ≤ 1 Min. „Erfolgreich archiviert“, Monitor „verfügbar“.

### 3.2 Optional (o2 und Telekom): Integrität mit SHA-256

Der Upload sendet `sha256` und `fileSize` mit. Im **Ablage-Flow** (der die Datei in SharePoint anlegt) eine Bibliotheksspalte
`PS_SHA256` (Text) anlegen und beim Erstellen der Datei mit dem empfangenen `sha256` füllen. Im `exists`-Zweig zusätzlich `PS_SHA256`
auswählen (`$select=FileLeafRef,PS_SHA256,File/Length`) und als `"sha256"` in das Objekt aufnehmen. Hinweis: Power Automate kann
keine SHA-256 einer Datei selbst berechnen; die gespeicherte Prüfsumme belegt, dass genau die gesendete Datei abgelegt wurde,
die Dateigröße prüft zusätzlich die Vollständigkeit. Ohne diese Erweiterung prüft die App weiter den Namen (und Größe, falls geliefert).

## 4. Power Automate – Upload-Flows absichern und Schlüssel austauschen

**Befund:** Die Upload-Flows (o2 `…workflows/6e4980d3…`, Telekom `…workflows/68f976da…`) sind nur durch die Signatur in der URL
und den festen Schlüssel `hetec-ps-9f3k` geschützt. Beides steht im öffentlich ausgelieferten Code (GitHub Pages; die Repos sind
öffentlich). Jeder könnte damit Dateien ins Archiv einspielen.

**Vorbereitet (live seit 55.171 / 57.11):** Jeder Upload enthält `idToken` (Firebase-Login des Absenders), `senderUid`, `ownerUid`, `archiveId`.

**Schritte im Flow (je Upload-Flow), nach dem Trigger:**
1. *HTTP* (Premium, wie beim bestehenden HTTP-Trigger) POST
   `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=<Web-API-Schlüssel des Firebase-Projekts>`
   Body `{"idToken": "@{triggerBody()?['idToken']}"}` – Google prüft Signatur und Ablauf des Tokens.
   (Web-API-Schlüssel: o2 = `apiKey` aus `STATS_FB_CONFIG`; er ist kein Geheimnis.)
2. *Bedingung*: Statuscode = 200 **und** `body('HTTP')?['users']?[0]?['localId']` = `triggerBody()?['senderUid']` **und**
   `endsWith(toLower(body('HTTP')?['users']?[0]?['email']), '@hetec-gmbh.de')`.
   *Nein* → *Beenden* (Status „Abgebrochen“), Datei **nicht** anlegen. (Die App sieht wegen `no-cors` keine Antwort; sie
   bemerkt das Fehlen über `exists` und sendet nach 20 Min. erneut bzw. meldet „fehlgeschlagen“.)
3. Optional: Profil prüfen – *HTTP* GET `https://firestore.googleapis.com/v1/projects/<projekt>/databases/(default)/documents/users/<senderUid>`
   mit Header `Authorization: Bearer <idToken>` → `fields.active.booleanValue` = true.
4. **Übergangsphase:** Zuerst Schritt 2 nur **protokollieren** (fehlendes Token zulassen), bis im Archivierungsmonitor alle Geräte
   App-Version ≥ 55.171 (o2) bzw. ≥ 57.11 (Telekom) melden (Spalte `appVersion` in `archiv_jobs`). Dann erzwingen.
5. **Schlüssel austauschen:** Wenn das Token erzwungen wird, ist `key` überflüssig. Die alte URL ist trotzdem öffentlich bekannt:
   Flow mit **„Speichern unter“** kopieren (neue Trigger-URL), neue URL in `index.html` / `index-neu.html` (`ARCHIVE_FLOW_URL`) bzw.
   Telekom `PA_UPLOAD_URL` eintragen und veröffentlichen, nach Umstellung aller Geräte den alten Flow **deaktivieren**.
6. Im Ablage-Flow: vorhandene Datei gleichen Namens **nicht überschreiben** (Bedingung „Datei existiert“ → abbrechen + protokollieren).

## 5. Tests (tatsächlich ausgeführt am 28.11.2026)

| Art | Umfang | Ergebnis |
|---|---|---|
| Modul (Node, `node --test tests/*.test.mjs`) | 51 je Repo | alle bestanden |
| Browser-E2E (Chromium, echte App, Firebase-Testersatz **ohne** Regeln, Flow-/SharePoint-Attrappen) | o2 26 (+1 nur Hall), Hall 27, Telekom 26 (+1 nur Hall) | alle bestanden |
| Firestore-Regeln im **echten Firestore-Emulator** (GitHub Actions) | 11 Szenarien inkl. App-Datenformat | alle bestanden |

Nicht ausgeführt: echte Power-Automate-Flows, echtes SharePoint, echte Firebase-Projekte, Safari/iPadOS, Galaxy Tab S9 FE.

## 6. Rückweg

`main` auf `backup/vor-archiv-v4-20261128` setzen (= V3). Firestore-Regeln: vorherige Version in der Konsole („Verlauf“) wiederherstellen.
