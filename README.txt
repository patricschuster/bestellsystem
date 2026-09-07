Thekenflow — Bestell- und Kassensystem fuer Vereinsfeste

Die aktuelle Version steht in package.json und wird zur Laufzeit unter
/health sowie im Header der Bar- und Admin-Ansicht angezeigt. In dieser
Datei steht bewusst keine Nummer, damit sie nicht veralten kann.


Start (lokal)

  docker compose up --build -d
  -> http://localhost:3000

  Stoppen:      docker compose down
  Logs:         docker compose logs -f thekenflow
  Version:      curl http://localhost:3000/health


Start (Raspberry Pi)

  docker compose -f docker-compose.yml -f docker-compose.pi.yml \
    up --build -d --remove-orphans

  Das Pi-Override aktiviert network_mode: host, mountet vcgencmd fuer den
  Throttling-Status und reicht /dev/vcio durch.


Daten

  Die SQLite-Datenbank liegt unter data/bestellsystem.db und ist per
  Bind-Mount aus dem Container herausgereicht. Sie ist nicht in Git
  eingecheckt und ueberlebt Rebuilds und git reset --hard.

  ACHTUNG: git clean -xfd loescht sie, weil -x auch ignorierte Dateien
  entfernt. Vorher sichern.


HTTPS

  Ohne Zertifikate in certs/ startet nur HTTP auf Port 3000. HTTPS auf
  Port 3443 braucht Zertifikate, die generate-certs.bat (Windows) bzw.
  generate-certs.sh (Linux) erzeugen. Ohne HTTPS funktioniert der Wake
  Lock nicht, der das iPad-Display waehrend des Betriebs wach haelt.
  Details: HTTPS-SETUP.md


Version erhoehen

  npm version <x.y.z> --no-git-tag-version

  Nur package.json anfassen. Server und Frontend leiten die Nummer ab;
  scripts/check-version.js bricht den Docker-Build ab, sobald irgendwo
  eine Versionsnummer hartcodiert wird.


Weitere Doku

  ENTSCHEIDUNGEN.md        Architektur- und Entscheidungshistorie
  PLAN-multitheke.md       Multi-Theken-Umbau (umgesetzt)
  KOMMENTAR-KONZEPT.md     Kommentar-Funktion (teilweise umgesetzt)
  HYBRID-MODUS-VISUAL.md   Theken-/POS-Modus (umgesetzt)
  WEBSOCKET_UPGRADE.md     Umstellung auf WebSockets
  HTTPS-SETUP.md           Zertifikate und Wake Lock
