# Plan: Systemzeit des Pi automatisch von Theken-Geräten übernehmen

Status: **Geplant, nicht umgesetzt**
Stand Planung: 2026-10-15 · Ausgangsversion: 2.27.2

## Problem

Der Pi 5 hat eine RTC, aber **keine Pufferbatterie** (`battery_voltage` = 0).
Die Zeit kommt ausschließlich per NTP (systemd-timesyncd) über wlan0. Das
AP-Netz an eth0 hat kein Internet, und Internet am Einsatzort ist nicht garantiert.

Nach einem Neustart/Stromausfall ohne Internet startet die Uhr mit dem zuletzt
gespeicherten Stand von timesyncd und bleibt falsch, bis NTP greift.
Beobachtet am 15.10.2026: Start mit `11.10. 03:01`, NTP-Sync erst um `15.10. 20:35`
(Docker meldete dadurch „Up 4 days" bei 1 h Uptime).

Folgen für Thekenflow:
- Bestellungen werden mit falscher Serverzeit gestempelt (`datetime('now')`
  in SQLite, `new Date()` in Node).
- Das Bestellalter rechnen die Clients mit **ihrer** Uhr gegen den Server-Stempel
  (`ageMinutes()` in `public/app.js`) → absurde Werte („5800 min").
- Verlauf und Auswertungen nach Datum stimmen nicht.

Während der Pi läuft, ist die Uhr unkritisch (Drift wenige Sekunden pro Tag).
**Das Problem entsteht nur durch einen Neustart des Pi ohne NTP.**

## Lösung in einem Satz

Nach einem Pi-Neustart ohne NTP übernimmt der Server **automatisch und ohne
Rückfrage** die Zeit des ersten Theken-Geräts, das sich verbindet, und stellt
damit die Systemuhr des Pi.

## Designentscheidungen

- **1** Keine Benutzerabfrage. iPads stellen ihre Uhr automatisch und haben
  eine Batterie, ihre Zeit ist genauer als jede manuelle Eingabe.
- **2** Nur **Theken-Geräte** (Rolle `bar`) sind Zeitquelle, keine Bediener-Handys.
- **3** **Systemuhr** des Pi stellen statt eines App-internen Offsets: Zeitstempel
  entstehen an vielen Stellen (SQLite `datetime('now')`, Node `Date`), mit der
  Systemuhr stimmen alle auf einmal.
- **4** Übernahme **einmal pro Pi-Boot**, erkannt über
  `/proc/sys/kernel/random/boot_id` (im Container sichtbar, identisch mit Host).
  Ein Container-Neustart (Deploy) löst damit nichts aus.
- **5** **NTP hat Vorrang**: Ist der Pi synchronisiert, wird nie übernommen.
  Kommt später Internet, korrigiert NTP wie gewohnt.
- **6** Bereits erfasste Bestellungen werden **nicht** nachträglich korrigiert.
  Die Theke verbindet sich nach einem Neustart in der Regel innerhalb von
  Sekunden, bevor neue Bestellungen eingehen.
- **7** Auslöser ist jede WebSocket-(Wieder-)Verbindung, nicht nur das Login:
  Nach einem Stromausfall im Betrieb verbinden sich die iPads automatisch neu,
  ohne sich neu anzumelden.

## Bedingungen für eine Übernahme

Der Server stellt die Uhr nur, wenn **alle** zutreffen:

1. Absender ist ein Theken-Gerät (`role === 'bar'` in `client:info`).
2. Pi ist nicht NTP-synchronisiert (`/run/systemd/timesync/synchronized` fehlt).
3. Für die aktuelle `boot_id` wurde noch keine Zeit übernommen
   (`settings.clock_boot_id` ≠ aktuelle `boot_id`).
4. Plausibilität: Die Gerätezeit liegt **nicht vor** der letzten bekannten Zeit
   (jüngster Zeitstempel in DB, z.B. `MAX(created_at)` aus `orders`/Log) und nicht
   vor dem Build-Datum. Die echte Zeit kann über einen Neustart nicht rückwärts laufen.
5. Abweichung zwischen Gerät und Pi > 2 Minuten (sonst nur `clock_boot_id`
   setzen, nichts stellen).

## Umsetzung

### Server (`server.js`)

- Hilfsfunktionen `getBootId()`, `isNtpSynced()`, `getClockStatus()`.
- Handler `client:info`: Feld `timestamp` (Client-ISO-Zeit, wird bereits
  mitgesendet) auswerten, Bedingungen prüfen, ggf. `setSystemClock(ms)`.
- `setSystemClock(ms)`: `date -s @<sek>` bzw. `settimeofday` im Container.
  Danach `settings.clock_boot_id`, `clock_source` (Gerätename/Benutzer),
  `clock_set_at`, `clock_delta_ms` speichern. Log-Eintrag mit alter/neuer
  Zeit und Abweichung.
- Weichen später verbundene Theken-Geräte um > 5 Minuten ab: **nicht** stellen,
  nur Warnung im Log / Hinweis im Admin-Bereich.
- `GET /api/time/status` → `{ serverTime, ntpSynced, bootId, confirmedThisBoot, source, setAt, deltaMs }`.
- `POST /api/time/set` `{ epochMs, pin }` (Admin-PIN) als manuelle Notlösung.
  Ignoriert die automatischen Bedingungen 2–5, prüft nur PIN und Plausibilität.
- Alles nur aktiv bei `ALLOW_SET_CLOCK=1`, sonst nur Status/Anzeige.

### Docker (`docker-compose.pi.yml`)

```yaml
    cap_add:
      - SYS_TIME
    environment:
      ALLOW_SET_CLOCK: "1"
    volumes:
      - /run/systemd/timesync:/run/systemd/timesync:ro
```

Hinweis: Die Systemuhr ist nicht pro Container getrennt. Mit `SYS_TIME` stellt
der Container die Uhr des Hosts, genau das ist gewollt. Lokal (Docker Desktop)
bleibt die Funktion aus, weil `ALLOW_SET_CLOCK` fehlt.

Prüfen, ob `date` im Image vorhanden ist (BusyBox/coreutils), sonst Node-Lösung
oder Paket nachinstallieren.

### Frontend (`public/app.js`)

- `sendClientInfo()` sendet bereits `timestamp`. Sicherstellen, dass es nach
  jedem WS-Connect **und** direkt nach dem Theken-Login (Rolle gesetzt) gesendet wird.
- Admin-Bereich: Anzeige Systemzeit, Quelle (NTP / Gerät „…" / ungeprüft),
  Zeitpunkt der Übernahme, Abweichung. Button „Zeit von diesem Gerät übernehmen"
  → `POST /api/time/set`.

## Risiken und Grenzen

- **Rolle ist selbst gemeldet:** WS-Clients authentifizieren sich nicht, ein Gerät
  im AP-Netz könnte `role: 'bar'` behaupten. Durch die Bedingungen (nur ohne NTP,
  nur einmal pro Boot, nicht rückwärts) ist der mögliche Schaden begrenzt. Für ein
  geschlossenes Thekennetz akzeptabel.
- **Theken-iPad mit falsch gestellter Uhr** (automatische Zeit aus): wird
  übernommen, sofern plausibel. Korrektur über den Admin-Button.
- **Zeitsprung im laufenden Server:** `waiter_sessions` werden über
  `datetime('now','-5 minutes')` aufgeräumt. Ein Vorwärtssprung löscht alle
  Sitzungen einmalig, der nächste Heartbeat legt sie neu an. Beim Testen prüfen.
  Timer (`setInterval`/`setTimeout`) laufen monoton und sind nicht betroffen.
- **Ergänzende Hardware-Lösung:** Offizielle RTC-Pufferbatterie (J5) macht den
  Fall praktisch selten. Diese Software-Lösung bleibt als Absicherung sinnvoll.

## Test

1. Lokal: Status-Endpunkt und Anzeige ohne `ALLOW_SET_CLOCK`.
2. Pi: `sudo systemctl stop systemd-timesyncd`, `sudo date -s '2026-01-01 12:00'`,
   `rm /run/systemd/timesync/synchronized`, `settings.clock_boot_id` leeren →
   Theken-iPad verbinden → Uhr muss springen, Log-Eintrag vorhanden.
3. Zweites Theken-Gerät verbinden → keine erneute Übernahme.
4. Container neu starten → keine erneute Übernahme (gleiche `boot_id`).
5. Gerätezeit vor letzter DB-Zeit simulieren → wird abgelehnt.
6. timesyncd wieder starten → NTP übernimmt, Status zeigt „NTP".
