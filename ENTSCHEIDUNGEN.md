# Bestellsystem — Architektur & Entscheidungshistorie

Diese Datei fasst zusammen, **warum** das System so gebaut ist, wie es ist —
als Ergänzung zu den bestehenden Einzel-Docs (`WEBSOCKET_UPGRADE.md`,
`HYBRID-MODUS-VISUAL.md`, `KOMMENTAR-KONZEPT.md`, `PLAN-multitheke.md`,
`HTTPS-SETUP.md`), die jeweils ein Feature im Detail beschreiben, aber nicht
den Gesamtzusammenhang. Erstellt am 2026-08-04 als Absicherung vor einem
Claude-Account-Wechsel, damit der Werdegang nicht nur im Chatverlauf steckt.

> ⚠️ Hinweis: `README.txt` ist veraltet (nennt v2.3.20). Die tatsächliche
> Version laut `package.json` ist **v2.13.1**. Sollte bei Gelegenheit
> aktualisiert werden.

## Überblick

- **Zweck:** Bestell- und Kassensystem für Vereinsfeste (Vereinsfeste-Betrieb,
  nicht dauerhafter Gastro-Betrieb) — Bediener nehmen Tisch-Bestellungen auf,
  eine oder mehrere Theken/Küchen bearbeiten und quittieren sie, Kassierung
  läuft direkt im System.
- **Stack:** Node.js (ESM) / Express 4 / better-sqlite3 / WebSocket (`ws`) mit
  Polling-Fallback / Docker (+ eigenes Pi-Compose-Override) / Zod für
  Validierung / Helmet für Basis-Hardening.
- **Zielgerät:** primär iPad im Querformat (Bediener-, POS- und
  Admin-Ansicht), daher viele UI-Entscheidungen touch- und
  Tablet-Breakpoint-getrieben.
- **Deploy-Ziel:** Raspberry Pi (siehe Deploy-Hinweis unten).

## Zeitlicher Verlauf (grobe Phasen laut Commit-Historie)

1. **Okt–Nov 2025 – Grundgerüst:** Initial Commit, Tisch-Favoriten,
   Stations-Funktion, Standard-Kachel-Layout, Rückgeld-/Kassierfunktion.
2. **Nov 2025–Jan 2026 – Stabilisierung & UX:** Umstellung auf WebSockets
   (v2.4), PIN-Absicherung, Storno-Feature, Umsatzstatistik,
   Bediener-History, dynamisches POS-Grid.
3. **Feb–Mai 2026 – Betriebsreife:** Host-Metriken (CPU/RAM/Temp),
   Ampelsystem für System-Metriken, Last-/Workflow-Simulator im Admin-Tab,
   Pi-5/Bookworm-Kompatibilitätsfixes, iPad-spezifische Fixes (Pinch-Zoom,
   Viewport, Grid-Overflow).
4. **Jun 2026 – Multi-Theken-Ausbau:** Von einer einzelnen Theke auf
   Mehrfach-Theken-Betrieb mit Kategorie-Navigation erweitert (siehe unten,
   detailliert in `PLAN-multitheke.md`). Aktuellster Meilenstein: v2.13.1.

## Kernentscheidungen nach Bereich

### 1. Echtzeit-Kommunikation: WebSocket statt reinem Polling

**Warum:** Polling allein erzeugte bei 4 Clients ~14.400 Requests/Stunde und
0–1000ms Verzögerung bei Statusänderungen — spürbar bei Bestellungen, die
sofort an der Theke sichtbar sein müssen.

**Entscheidung:** WebSocket als primärer Kanal, mit Polling als Fallback
(alle 30s statt 1s), falls die Verbindung nicht zustande kommt oder abbricht.
Auto-Reconnect ist eingebaut.

**Resultat:** <50ms Update-Latenz, ~480 Requests/Stunde (statt 14.400),
~50 KB/h Datenvolumen (statt ~36 MB/h). Details, Event-Typen und
Troubleshooting: `WEBSOCKET_UPGRADE.md`.

### 2. Hybrid-/"Theken-Modus" für iPad im Querformat

**Warum:** An der Theke sollen sowohl eingehende Bediener-Bestellungen als
auch Direktverkauf (POS) gleichzeitig sichtbar sein, ohne manuellen
Moduswechsel — auf begrenztem iPad-Platz.

**Entscheidung:** Dynamisches Split-Layout, das sich automatisch an die
Anzahl angemeldeter Bediener anpasst:
- 0 Bediener aktiv → 100% POS (normaler Modus)
- 1 Bediener aktiv → 30% Bestellungen / 70% POS
- 2+ Bediener aktiv → 70% Bestellungen / 30% POS

Aktivierung nur für Rolle "Bar" nach Login, als Toggle im Header
("Theken-Modus"). Layout wechselt live bei An-/Abmeldung von Bedienern, kein
manuelles Umschalten nötig. Nur für Tablet-Querformat (768–1366px) aktiv.
Details, Mockups und CSS-Grid-Umsetzung: `HYBRID-MODUS-VISUAL.md`.

### 3. Kommentar-Funktion für Bestellungen

**Warum:** Sonderwünsche ("ohne Zwiebeln", Allergien) mussten bislang mündlich
weitergegeben werden — Fehlerquelle beim Wechsel Bediener → Theke/Küche.

**Entscheidung:** Optionales Freitextfeld (max. 200 Zeichen) pro Bestellung,
das in Theke/Kitchen-Ansicht **prominent** (gelber Hintergrund, Icon) über
der Produktliste angezeigt wird — Position bewusst "oben, vor der Liste"
gewählt, da das zuverlässiger gelesen wird als unten oder als Hover-Tooltip
(Touch-Geräte). Kommentar ist nur bearbeitbar, solange die Bestellung offen
ist. Erwogen, aber (Stand Doku) noch nicht umgesetzt: Quick-Kommentar-Buttons
für häufige Sonderwünsche, Kommentar-History im Admin-Bereich. Details:
`KOMMENTAR-KONZEPT.md`.

### 4. Multi-Theken-Erweiterung + Kategorie-Navigation (größter Architektur-Umbau)

**Warum:** Das System war ursprünglich auf eine einzelne Theke ausgelegt.
Bei größeren Vereinsfesten mit mehreren Ausgabestellen sollten Produkte
gezielt Theken zugeordnet und die Quittierung pro Theke gefiltert werden
können, plus eine zweistufige Kategorie-Navigation im Auswahlgrid
(z. B. Essen/Getränke → Produkte) für übersichtlichere Grids.

**Kern-Designentscheidungen** (vollständige Liste inkl. Begründung in
`PLAN-multitheke.md`):
- Theken-Zuordnung filtert die Quittierung auf **Item-Ebene** — jede Theke
  sieht nur die Order-Items, deren Produkt zu ihr gehört (echte
  Arbeitsteilung).
- Stationen (Zubereitungsort) und Theken (Verkaufsort) sind **zwei
  unabhängige Achsen** — keine Vermischung.
- **Ein gemeinsamer** `ready`-Status pro Item, unabhängig davon, welche Theke
  quittiert — vermeidet inkonsistente Zustände.
- Bediener sehen weiterhin **alle** Produkte, unabhängig von Theken-Zuordnung
  — nur die Theken-Ansicht selbst filtert.
- Produkte ohne explizite Theken-Zuordnung gelten implizit als "an allen
  Theken" — migrationsfreundlich für Bestandsdaten.
- Kategorie-Navigation wird **übersprungen**, wenn nur ≤1 Kategorie existiert
  (kein unnötiger Klick).

**Umsetzung in drei Phasen** (bewusst so geschnitten, um das Risiko am
Kern-Rendering — `getRenderableBatches`/`buildBatchCard` — zu isolieren):
- Phase 1 (v2.11.0): Datenmodell + Admin-Verwaltung, keine
  Verhaltensänderung — risikoarm.
- Phase 2 (v2.13.0, Kernstück): Theke-Auswahl beim Login, Item-Level-Filterung
  der Quittierung, History pro Theke — als heikelster Eingriff bewusst nach
  Phase 1 gelegt.
- Phase 3 (v2.13.0): Zweistufige Kategorie-Navigation im Bediener- und
  POS-Grid.

### 5. HTTPS-Pflicht für Wake Lock (iPad-Display)

**Warum:** Die Screen Wake Lock API (verhindert Display-Standby auf dem
iPad während des Betriebs) funktioniert nur über HTTPS oder localhost.

**Entscheidung:** Selbstsigniertes Zertifikat für den lokalen Netzwerkbetrieb
(Docker liefert HTTP auf :3000 und HTTPS auf :3443 parallel aus). Für
produktiven Internet-Einsatz wäre ein CA-signiertes Zertifikat (z. B. Let's
Encrypt) nötig — aktuell aber lokaler Netzwerkbetrieb auf dem Pi. Details:
`HTTPS-SETUP.md`.

## Deployment-Konvention

Etabliertes Vorgehen (siehe `PLAN-multitheke.md`, gilt generell): **kein
direkter Push auf den Pi während der Entwicklung.** Lokal bauen und testen,
gebündelt deployen erst wenn grünes Licht gegeben wird — Ablauf dabei:
`eth0 down → pull → rebuild → eth0 up`.

Die SQLite-Datenbank wurde bewusst aus dem Git-Tracking entfernt (Commit
"DB aus Git-Tracking entfernt"), um Datenverlust beim Deploy zu verhindern —
die Produktivdaten auf dem Pi dürfen nicht durch einen Git-Pull überschrieben
werden.

## Offene Punkte (laut Docs, Stand dieser Zusammenfassung)

- `README.txt` aktualisieren (veraltete Versionsnummer).
- Quick-Kommentar-Buttons und Kommentar-History im Admin-Bereich (siehe
  Kommentar-Konzept) — geplant, aber noch nicht umgesetzt.
- WebSocket-Heartbeat (Ping/Pong) und Disconnect-Benachrichtigung für den
  User — als "optional" markiert, noch offen.
- Für Internet-Betrieb (statt nur lokales Netzwerk): CA-signiertes
  HTTPS-Zertifikat statt selbstsigniertem.
