# Hybrid-Modus für iPad (Querformat)

## Namensvorschläge:
- **"Theken-Modus"** (einfach, klar)
- **"Bar-Modus"** (passt zur Bar-Rolle)
- **"Hybrid-Ansicht"** (technisch)
- **"Split-Modus"** (beschreibt das Layout)
- **"Kompakt-Modus"** (zeigt alles auf einen Blick)

**Empfehlung: "Theken-Modus"** ✓

---

## Layout-Varianten

### Variante 1: Mehrere Bediener angemeldet (70/30)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Header: [← Abmelden] [Max, Anna] [Bestellsystem] [🔄 Theken-Modus: AN] │
├─────────────────────────────────────────────┬───────────────────────────┤
│                                             │                           │
│   BESTELLUNGEN DER BEDIENER (70%)          │   POS - THEKE (30%)       │
│                                             │                           │
│  ┌────────────┐  ┌────────────┐            │  ┌─────────────────────┐  │
│  │  Max       │  │  Anna      │            │  │  PRODUKTE (70%)     │  │
│  ├────────────┤  ├────────────┤            │  ├─────────────────────┤  │
│  │ ┌────────┐ │  │ ┌────────┐ │            │  │ [Pils]  [Weizen]   │  │
│  │ │Tisch 3 │ │  │ │Tisch 1 │ │            │  │ [Cola]  [Wasser]   │  │
│  │ │2x Pils │ │  │ │1x Cola │ │            │  │ [Burger] [Pommes]  │  │
│  │ │15 min  │ │  │ │5 min   │ │            │  │ [Steak]  [Salat]   │  │
│  │ │[Bereit]│ │  │ │[Bereit]│ │            │  │                     │  │
│  │ └────────┘ │  │ └────────┘ │            │  │                     │  │
│  │            │  │            │            │  └─────────────────────┘  │
│  │ ┌────────┐ │  │ ┌────────┐ │            │                           │
│  │ │Tisch 5 │ │  │ │Tisch 7 │ │            │  ┌─────────────────────┐  │
│  │ │1x Cola │ │  │ │3x Pils │ │            │  │  CHECKOUT (30%)     │  │
│  │ │8 min   │ │  │ │12 min  │ │            │  ├─────────────────────┤  │
│  │ │        │ │  │ │        │ │            │  │ 2x Pils      9,80€  │  │
│  │ └────────┘ │  │ └────────┘ │            │  │ 1x Cola      3,50€  │  │
│  └────────────┘  └────────────┘            │  │─────────────────────│  │
│                                             │  │ SUMME:      13,30€  │  │
│                                             │  │                     │  │
│                                             │  │ [Abbrechen]         │  │
│                                             │  │ [✓ Alles kassiert]  │  │
│                                             │  └─────────────────────┘  │
└─────────────────────────────────────────────┴───────────────────────────┘
```

**Breite:** 70% Bestellungen | 30% POS

---

### Variante 2: Nur EIN Bediener angemeldet (30/70)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Header: [← Abmelden] [Max] [Bestellsystem] [🔄 Theken-Modus: AN]       │
├─────────────────────┬───────────────────────────────────────────────────┤
│                     │                                                   │
│   MAX (30%)         │              POS - THEKE (70%)                   │
│                     │                                                   │
│  ┌────────────┐     │  ┌───────────────────────────────────────────┐   │
│  │ ┌────────┐ │     │  │         PRODUKTE (70%)                    │   │
│  │ │Tisch 3 │ │     │  ├───────────────────────────────────────────┤   │
│  │ │2x Pils │ │     │  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │   │
│  │ │15 min  │ │     │  │  │ Pils │ │Weizen│ │ Cola │ │Wasser│     │   │
│  │ │[Bereit]│ │     │  │  │ 4,90€│ │ 5,20€│ │ 3,50€│ │ 2,80€│     │   │
│  │ └────────┘ │     │  │  └──────┘ └──────┘ └──────┘ └──────┘     │   │
│  │            │     │  │                                           │   │
│  │ ┌────────┐ │     │  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │   │
│  │ │Tisch 5 │ │     │  │  │Burger│ │Pommes│ │Steak │ │Salat │     │   │
│  │ │1x Cola │ │     │  │  │12,90€│ │ 4,50€│ │18,90€│ │ 7,90€│     │   │
│  │ │8 min   │ │     │  │  └──────┘ └──────┘ └──────┘ └──────┘     │   │
│  │ │        │ │     │  │                                           │   │
│  │ └────────┘ │     │  └───────────────────────────────────────────┘   │
│  └────────────┘     │                                                   │
│                     │  ┌───────────────────────────────────────────┐   │
│                     │  │         CHECKOUT (30%)                    │   │
│                     │  ├───────────────────────────────────────────┤   │
│                     │  │  2x Pils                         9,80€    │   │
│                     │  │  1x Cola                         3,50€    │   │
│                     │  │  1x Burger                      12,90€    │   │
│                     │  │  ───────────────────────────────────────  │   │
│                     │  │  SUMME:                         26,20€    │   │
│                     │  │                                           │   │
│                     │  │  [Abbrechen]    [✓ Alles kassiert]        │   │
│                     │  └───────────────────────────────────────────┘   │
└─────────────────────┴───────────────────────────────────────────────────┘
```

**Breite:** 30% Bestellungen | 70% POS

---

## Logik & Regeln

### Aktivierung:
```
┌─────────────────────────────────────────┐
│  Rolle = "Bar" UND Login erfolgreich    │
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│  Theken-Modus Toggle erscheint im Header│
└─────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────┐
│  Nutzer aktiviert "Theken-Modus"                        │
│  → Button zeigt: "🔄 Theken-Modus: AN"                  │
└─────────────────────────────────────────────────────────┘
              ↓
        ┌─────────────┐
        │ Warte auf    │
        │ Bediener...  │
        └─────────────┘
              ↓
    ╔═══════════════════════╗
    ║ Bediener meldet sich  ║
    ║ (z.B. "Max")          ║
    ╚═══════════════════════╝
              ↓
        ┌─────────────────────────┐
        │ Anzahl Bediener = ?     │
        └─────────────────────────┘
              ↓
    ┌─────────┴──────────┐
    ↓                    ↓
┌───────────┐      ┌──────────────┐
│ Nur EINER │      │ MEHRERE (2+) │
└───────────┘      └──────────────┘
    ↓                    ↓
┌───────────┐      ┌──────────────┐
│ 30 / 70   │      │ 70 / 30      │
│ Layout    │      │ Layout       │
└───────────┘      └──────────────┘
```

### Dynamische Anpassung:
- **Kein Bediener**: Normaler POS-Modus (aktuell)
- **1 Bediener**: 30% Bestellungen / 70% POS
- **2+ Bediener**: 70% Bestellungen / 30% POS
- **Live-Update**: Layout wechselt automatisch bei An-/Abmeldung

---

## Header-Button Design

### Variante A: Text + Icon
```
┌────────────────────────────┐
│ 🔄 Theken-Modus: AN        │
└────────────────────────────┘
```

### Variante B: Nur Text (kompakt)
```
┌──────────────────┐
│ Theken-Modus: AN │
└──────────────────┘
```

### Variante C: Icon + Kurz (Empfehlung)
```
┌──────────────┐
│ 🔄 Theke: AN │
└──────────────┘
```

**Zustand AUS:**
```
┌──────────────┐
│ 🔄 Theke: AUS│
└──────────────┘
```

---

## Verhalten der rechten Spalte (POS)

### Produktauswahl (obere 70%):
- Grid-Layout mit großen Touch-Buttons
- Produktname + Preis
- Touch: Produkt wird zum Warenkorb hinzugefügt
- Visuelles Feedback bei Klick

### Checkout (untere 30%):
- Liste der ausgewählten Produkte
- Anzahl × Produktname = Preis
- Gesamtsumme hervorgehoben
- **[Abbrechen]**: Warenkorb leeren
- **[✓ Alles kassiert]**: Bestellung erstellen + sofort bezahlen

---

## Responsive Breakpoints

```css
/* Nur für Tablets im Querformat */
@media (orientation: landscape) and (min-width: 768px) and (max-width: 1366px) {
  /* Hybrid-Modus Layout */
}

/* iPad Pro 11" (Querformat): 1194 × 834 px */
/* iPad Pro 12.9" (Querformat): 1366 × 1024 px */
```

---

## Technische Umsetzung

### State-Erweiterung:
```javascript
state.thekenMode = false;  // Toggle für Theken-Modus
state.hybridLayout = '70/30'; // oder '30/70'
```

### Layout-Berechnung:
```javascript
function calculateHybridLayout() {
  const activeBediener = state.sessions.filter(s => s.waiter !== 'Theke').length;

  if (activeBediener === 0) {
    return 'full-pos'; // 100% POS
  } else if (activeBediener === 1) {
    return '30/70'; // 30% Bediener, 70% POS
  } else {
    return '70/30'; // 70% Bediener, 30% POS
  }
}
```

### CSS-Grid:
```css
.hybrid-layout {
  display: grid;
  height: calc(100vh - 60px); /* Minus Header */
}

.hybrid-layout.split-70-30 {
  grid-template-columns: 70% 30%;
}

.hybrid-layout.split-30-70 {
  grid-template-columns: 30% 70%;
}

.pos-column {
  display: grid;
  grid-template-rows: 70% 30%;
}
```

---

## Vorteile dieser Lösung:

✅ **Alles auf einen Blick** - Bediener-Bestellungen + direkter Verkauf
✅ **Flexibel** - Passt sich automatisch der Bediener-Anzahl an
✅ **Platzsparend** - Optimal für iPad-Querformat
✅ **Effizient** - Kein Modus-Wechsel nötig
✅ **Touch-optimiert** - Große Buttons für schnelle Bedienung

---

## Nächste Schritte:

1. ✅ Visuals erstellen (erledigt)
2. ⏳ Modus-Name festlegen: **"Theken-Modus"**
3. ⏳ UI implementieren
4. ⏳ Dynamische Layout-Berechnung
5. ⏳ Header-Button hinzufügen
6. ⏳ POS-Spalte mit 70/30 Split
7. ⏳ Auto-Switching bei Bediener-Änderung
