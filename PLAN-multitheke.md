# Plan: Multi-Theken, Theken-Filterung & Kategorie-Navigation

Status: **Planung abgeschlossen, Umsetzung noch nicht gestartet.**
Stand: 2026-06-08 · Ausgangsversion: 2.10.4

## Ziel

Das System von einer einzelnen Theke auf **mehrere Theken** erweitern, Produkte
gezielt Theken zuordnen, die Quittierung pro Theke filtern, und im Auswahlgrid
eine **zweistufige Kategorie-Navigation** (z.B. Essen / Getränke → Produkte)
einführen.

## Drei unabhängige Dimensionen pro Produkt

| Dimension     | Anzahl   | Zweck                                   | Migration bestehender Produkte |
|---------------|----------|-----------------------------------------|--------------------------------|
| **Theke(n)**  | mehrfach | wo wird verkauft / quittiert            | leer = „alle Theken" (implizit)|
| **Station**   | 1        | wo wird zubereitet (Unterfilter)        | unverändert                    |
| **Kategorie** | 1        | Navigationsebene im Auswahlgrid         | keine → flaches Grid           |

## Finale Designentscheidungen

- **1A** Theken-Zuordnung filtert auch die **Quittierung**: eine Theke sieht nur
  Order-Items, deren Produkt zu ihr gehört (echte Arbeitsteilung, Item-Ebene).
- **2A** Stationen bleiben **globale, unabhängige** Unterebene (zwei Achsen).
- **3A** **Gemeinsamer** `ready`-Status: egal welche Theke quittiert, das Item
  ist global ready (eine `ready`-Spalte wie bisher).
- **4A** Bediener sehen **alle** Produkte (nicht an eine Theke gebunden).
- **5A / impliziter Default** Produkt ohne Theken-Zuordnung (`theken` leer/NULL)
  gilt als „an allen Theken". Migrationsfreundlich; neue Produkte ohne explizite
  Wahl erscheinen überall.
- **6B** **Kategorie ist eine eigene Dimension** (unabhängig von Station).
- **7C** Kategorie-Navigation in **beiden** Grids (Bediener + POS).
- **8A** **Eine** Navigationsebene: Kategorie → Produkte.
- **9A** Bei ≤1 Kategorie (oder unkategorisierten Produkten) Zwischenebene
  **überspringen** → direkt flaches Grid.
- **10A** **Eine** Kategorie pro Produkt.

### Detailentscheidungen

- **Theke in History (Detail 1):** Theken werden in der History mitgeführt.
  - POS-Direktverkauf: Order bekommt eine **eindeutige** Theke (`orders.theke`).
  - Bediener-Order: „betrifft" eine Theke, wenn sie mind. ein nicht-storniertes
    Item mit Produkt-zu-Theke-Zugehörigkeit enthält (aus Produktdaten abgeleitet).
  - Jede Theke sieht in der History alles, was sie betrifft.
- **Implizite Theken-Semantik (Detail 2):** `products.theken` NULL/`[]` = alle
  Theken. Sonst explizite Namensliste.
- **Gemeinsames Menü (Detail 3):** Das bestehende **Station-Auswahl-Modal** wird
  zum kombinierten **„Theke & Station"-Menü** erweitert (nicht neu gebaut).
  Beim Login einmalig zur Theke-Wahl (bei >1 Theke), im Betrieb für Theke- und
  Station-Wechsel.

## Datenmodell

Neue/erweiterte Felder:

- `products.theken` TEXT — JSON-Array von Theken-Namen; NULL/`[]` = alle. **neu**
- `products.kategorie` TEXT — ein Kategorie-Name; NULL = keine. **neu**
- `products.station` TEXT — unverändert (bestehend).
- `orders.theke` TEXT — NULL bei Bediener-Orders; gesetzt bei POS-Direktverkauf. **neu**
- `config.theken` — Array von Theken-Namen (analog `config.stations`). **neu**
- `config.kategorien` — Array von Kategorie-Namen. **neu**

### Theken-Zugehörigkeit (Helper-Regel)

Ein Produkt `p` gehört zu Theke `T`, wenn:
`p.theken` ist leer/NULL  **oder**  `p.theken` enthält `T`.

Eine Order „betrifft" Theke `T`, wenn:
`order.theke === T` (POS)  **oder**  mind. ein nicht-storniertes Item ein Produkt
hat, das zu `T` gehört.

---

# Phasenplan (drei deploybare Versionen)

Jede Phase ist in sich testbar und einzeln auf den Pi deploybar.

## Phase 1 — Datenmodell + Admin-Verwaltung (v2.11.0)

Reine Datenpflege, **keine** Verhaltensänderung an Theke/Grid → risikoarm.

**DB (`src/db.js`)** — neue Spalten-Migrationen:
- `products.theken` TEXT
- `products.kategorie` TEXT
- `orders.theke` TEXT

**Config / Backend (`server.js`)**:
- `config.theken`, `config.kategorien` über bestehendes `/api/config`.
- Produkt-Endpoints (`POST`, `PUT /:id`, `PUT /bulk`) um `theken` + `kategorie`
  erweitern; `getProductsList` + alle Produkt-`SELECT`s ergänzen.

**Admin-UI (`index.html` + `app.js`)**:
- Neuer Tab **„Theken"** (anlegen/löschen, identisch zu „Stationen").
- Neuer Tab **„Kategorien"** (dito).
- Produkttabelle: zwei neue Spalten
  - **Theke(n)** → Mehrfachauswahl, nur sichtbar wenn ≥2 Theken existieren.
  - **Kategorie** → Dropdown, nur sichtbar wenn ≥1 Kategorie existiert.

**UI-Detail:** Mehrfachauswahl „Theke(n)" in der Tabellenzelle als kompaktes
Checkbox-Popover / Multi-Chip-Feld (iPad-Breite beachten).

**Testkriterien:** Theken/Kategorien anlegen, Produkten zuordnen, persistiert;
bestehender Theken-/Bedienerbetrieb läuft unverändert.

## Phase 2 — Theke-Auswahl + Quittierungs- & History-Filterung (v2.12.0)

Die Theken-Zuordnung wird wirksam.

**Login-Flow:** Nach `bar`-Login → **Theke-Auswahl** über das erweiterte
„Theke & Station"-Modal. Bei genau **einer** Theke automatisch gewählt.
→ `state.selectedTheke`.

**Theke-Ansicht — Filterung auf Item-Ebene (Kernstück, Umsetzung 1A):**
- *Kitchen Mode* zeigt nur Items, deren Produkt zur `selectedTheke` gehört.
  Bediener-Spalten-Layout bleibt; Theke-Filter wird **vor** der Batch-Bildung
  (`getRenderableBatches` / `buildBatchCard`) eingezogen.
- *POS-Direktverkauf* und *Station Mode* erben dieselbe Theke-Filterung.

**POS-Order-Zuordnung:** Direktverkauf schreibt `orders.theke = selectedTheke`.

**History (Detail 1):** History-Abfrage/-Anzeige nach Theke filterbar
(Order betrifft Theke → siehe Helper-Regel). Jede Theke sieht ihren Teil.

**Kombiniertes Menü (Detail 3):** Station-Modal → „Theke & Station": oben Theke
wählen, darunter Station-Unterfilter.

**Testkriterien:** Zwei Theken, Produkte aufgeteilt; Bediener bestellt gemischt
→ jede Theke sieht nur ihren Teil; gemeinsamer ready-Status; History pro Theke.

## Phase 3 — Zweistufige Kategorie-Navigation im Grid (v2.13.0)

**Bediener-Grid (`renderProducts`) + POS-Grid (`renderPOSColumn`)** (7C):
- Bei **≥2 Kategorien**: erst Kategorie-Kacheln; Klick → Produktgrid der
  Kategorie + Zurück-Button. `state.selectedCategory` für die Ebene.
- Bei **≤1 Kategorie** / unkategorisiert: direkt flaches Grid (9A).

**Testkriterien:** Kategorien „Essen"/„Getränke" anlegen, Produkte zuordnen →
zweistufige Auswahl in beiden Grids; Skip bei einer Kategorie.

---

## Risiken / Kernpunkte

- **Phase 2 ist der heikelste Eingriff:** Item-Level-Theke-Filterung berührt die
  Kern-Render-Logik (`getRenderableBatches`, `buildBatchCard`). Plan: Theke-Filter
  als Vorfilter, sodass Batch-Cards nur theken-relevante Items enthalten.
- **History-Ableitung** für Bediener-Orders erfordert Produkt-zu-Theke-Lookup zur
  Filterzeit (Produktdaten + `orders.theke`).
- **Reihenfolge:** Phase 1 (viel UI, risikoarm) → Phase 2 (Kern) → Phase 3 (isoliert).

## Deploy-Hinweis

Wie etabliert: kein direkter Pi-Push während der Entwicklung. Lokal bauen/testen,
gebündelt deployen, wenn der User grünes Licht gibt (eth0 down → pull → rebuild →
eth0 up).
