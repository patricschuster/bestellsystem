# Kommentar-Funktion für Bestellungen

## Visual: Bediener-Ansicht (Bestellung aufnehmen)

```
┌─────────────────────────────────────────────────────┐
│  Bestellung - Tisch 5                               │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Produktauswahl:                                    │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐              │
│  │ Bier │ │ Cola │ │Weizen│ │Schni-│              │
│  │ Maß  │ │      │ │      │ │tzel  │              │
│  │ 2x   │ │ 1x   │ │      │ │      │              │
│  └──────┘ └──────┘ └──────┘ └──────┘              │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ 📝 Kommentar zur Bestellung (optional)      │   │
│  │ ┌─────────────────────────────────────────┐ │   │
│  │ │ z.B. "ohne Zwiebeln", "extra scharf"    │ │   │
│  │ └─────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  Aktuelle Auswahl:                                  │
│  • 2× Bier Maß ........................... 10,00 €  │
│  • 1× Cola ................................ 3,00 €  │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  Gesamt: .................................. 13,00 €  │
│                                                     │
│  [Abbrechen]              [Bestellung aufgeben]     │
└─────────────────────────────────────────────────────┘
```

## Visual: Theke/Kitchen-Ansicht (POS:AUS)

```
┌──────────────────────────────────────────────────────┐
│                      Max                             │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌────────────────────────────────────────────┐     │
│  │ Tisch 5                    [offen] 8 min   │     │
│  ├────────────────────────────────────────────┤     │
│  │                                            │     │
│  │  💬 "ohne Zwiebeln, extra scharf"          │     │ ← KOMMENTAR
│  │                                            │     │
│  ├────────────────────────────────────────────┤     │
│  │  □ Bier Maß                                │     │
│  │  □ Bier Maß                                │     │
│  │  □ Cola                                    │     │
│  │  ☑ Schnitzel                               │     │
│  ├────────────────────────────────────────────┤     │
│  │  [Alle bereit]              [Abgeholt]     │     │
│  └────────────────────────────────────────────┘     │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## Visual: POS-Hybrid-Ansicht (Bediener-Spalte)

```
┌─────────────────────────┬─────────────────────────────┐
│       Max               │    POS Produktauswahl       │
├─────────────────────────┤                             │
│                         │    [Produktgrid...]         │
│ ┌─────────────────────┐ │                             │
│ │ Tisch 5  [offen] 8m │ │                             │
│ ├─────────────────────┤ │                             │
│ │                     │ │    ─────────────────────    │
│ │ 💬 "ohne Zwiebeln,  │ │    Aktuelle Bestellung      │
│ │    extra scharf"    │ │                             │
│ │                     │ │    • Bier Maß - 5,00€       │
│ ├─────────────────────┤ │    • Cola - 3,00€           │
│ │ □ Bier Maß          │ │                             │
│ │ □ Bier Maß          │ │    Gesamt: 8,00€            │
│ │ □ Cola              │ │                             │
│ │ ☑ Schnitzel         │ │    [Abbrechen] [Kassiert]   │
│ ├─────────────────────┤ │                             │
│ │ [Alle bereit]       │ │                             │
│ │     [Abgeholt]      │ │                             │
│ └─────────────────────┘ │                             │
└─────────────────────────┴─────────────────────────────┘
```

## Technische Umsetzung

### 1. Datenbank-Änderung

```sql
-- Neue Spalte in orders Tabelle
ALTER TABLE orders ADD COLUMN comment TEXT DEFAULT NULL;
```

### 2. UI-Komponente beim Bestellen

**Position:** Nach Produktauswahl, vor Gesamt-Summe

```html
<div class="order-comment-section">
  <label for="order-comment">
    <span class="material-symbols-outlined">comment</span>
    Kommentar (optional)
  </label>
  <textarea
    id="order-comment"
    placeholder="z.B. 'ohne Zwiebeln', 'extra scharf', 'Allergie: Nüsse'"
    maxlength="200"
    rows="2"
  ></textarea>
  <div class="char-counter">0/200</div>
</div>
```

### 3. Anzeige in Kitchen/Theke-View

**Position:** Direkt unter Tisch-Nummer, vor Produktliste

```html
<!-- Wenn Kommentar vorhanden -->
<div class="order-comment">
  <span class="material-symbols-outlined">comment</span>
  <span class="comment-text">ohne Zwiebeln, extra scharf</span>
</div>
```

### 4. CSS-Styling

```css
/* Kommentar-Eingabe beim Bestellen */
.order-comment-section {
  background: #fff8e1;
  border: 1px solid #ffe082;
  border-radius: 8px;
  padding: 12px;
  margin: 12px 0;
}

.order-comment-section label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  margin-bottom: 6px;
  color: #f57c00;
}

.order-comment-section textarea {
  width: 100%;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 8px;
  font-family: inherit;
  font-size: 14px;
  resize: vertical;
}

.order-comment-section .char-counter {
  text-align: right;
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}

/* Kommentar-Anzeige in Theke/Kitchen */
.order-comment {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: #fff8e1;
  border-left: 4px solid #ff9800;
  padding: 10px 12px;
  margin: 8px 0 12px 0;
  border-radius: 4px;
}

.order-comment .material-symbols-outlined {
  color: #ff9800;
  font-size: 20px;
  flex-shrink: 0;
}

.order-comment .comment-text {
  color: #e65100;
  font-weight: 600;
  font-size: 13px;
  line-height: 1.4;
  word-wrap: break-word;
}

/* Kompakte Version für Hybrid-Modus */
.bediener-column .order-comment {
  padding: 8px 10px;
  margin: 6px 0 10px 0;
}

.bediener-column .order-comment .comment-text {
  font-size: 12px;
}
```

### 5. API-Anpassungen

```javascript
// POST /api/orders - Kommentar speichern
{
  table_id: 5,
  waiter: "Max",
  items: [...],
  comment: "ohne Zwiebeln, extra scharf"  // NEU
}

// GET /api/orders - Kommentar mitliefern
{
  id: 123,
  table_id: 5,
  waiter: "Max",
  comment: "ohne Zwiebeln, extra scharf",  // NEU
  items: [...],
  ...
}
```

## User Flow

### Bediener erstellt Bestellung:
1. Produktauswahl wie gewohnt
2. Optional: Kommentar eingeben
3. "Bestellung aufgeben" klicken
4. Kommentar wird mit Bestellung gespeichert

### Theke/Kitchen sieht Bestellung:
1. Bestellung erscheint in Kitchen/Theke-View
2. **Kommentar prominent dargestellt** (gelber Hintergrund)
3. Bediener sieht sofort wichtige Hinweise
4. Produkte werden wie gewohnt abgearbeitet

## Vorteile

✅ **Klar sichtbar:** Gelber Hintergrund mit Icon fällt auf
✅ **Kompakt:** Nimmt nicht zu viel Platz weg
✅ **Optional:** Nur angezeigt wenn vorhanden
✅ **Flexibel:** 200 Zeichen für ausführliche Hinweise
✅ **Responsive:** Funktioniert in allen Ansichten

## Alternative Positionen

### Option A: Über der Produktliste (empfohlen)
- ✅ Wird zuerst gelesen
- ✅ Wichtige Info direkt sichtbar

### Option B: Unter der Produktliste
- ⚠️ Könnte übersehen werden
- ⚠️ Bei langer Liste aus Sicht

### Option C: Als Tooltip beim Hover
- ❌ Auf Touch-Geräten schwierig
- ❌ Nicht permanent sichtbar

## Weitere Überlegungen

### Quick-Kommentare / Templates
```
[ohne Zwiebeln]  [extra scharf]  [gut durch]
[Allergie]       [eilig]         [zum Mitnehmen]
```
→ Buttons für häufige Kommentare zum schnellen Auswählen

### Kommentar bearbeiten
- Nur bearbeitbar solange Status = 'open'
- Nach "bereit" nicht mehr änderbar

### Kommentar-History
- In Admin-Bereich: Alle Kommentare eines Tisches anzeigen
- Für wiederkehrende Sonderwünsche
