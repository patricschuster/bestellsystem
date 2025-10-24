Bestellsystem v2.3.20

Neu/Fixes:
- Reihenfolge der Produkte persistent via config.product_order (sofortes Speichern bei ▲/▼).
- Löschen-Icon je Produkt (🗑️).
- "Aktiv"-Schalter funktioniert: inaktive Produkte erscheinen nicht im Bediener-Grid.
- "1/2"-Schalter: untere 50% der Kachel farbig, volle Füllung wenn deaktiviert.
- Dockerfile + docker-compose.yml enthalten.

Start:
  unzip bestellsystem_v2.3.20.zip
  cd bestellsystem_v2.3.20
  docker compose up --build
  → http://localhost:3000
