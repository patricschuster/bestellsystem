# HTTPS Setup für iPad Wake Lock

## Warum HTTPS?
Die Screen Wake Lock API funktioniert nur über HTTPS (oder localhost). Um das Display auf dem iPad wach zu halten, muss die Anwendung über HTTPS aufgerufen werden.

## Schritt 1: Zertifikate generieren

### Windows:
```bash
generate-certs.bat
```

### Linux/Mac:
```bash
chmod +x generate-certs.sh
./generate-certs.sh
```

Dies erstellt:
- `certs/server.key` - Privater Schlüssel
- `certs/server.crt` - Selbstsigniertes Zertifikat

## Schritt 2: Docker Container neu starten

```bash
docker compose down
docker compose up --build -d
```

Der Server läuft jetzt auf:
- **HTTP**: http://localhost:3000
- **HTTPS**: https://localhost:3443

## Schritt 3: iPad konfigurieren

### Option A: Warnung akzeptieren (schnell, aber Warnung bei jedem Start)
1. Öffne Safari auf dem iPad
2. Gehe zu `https://<server-ip>:3443` (z.B. `https://192.168.1.100:3443`)
3. Tippe auf **"Erweitert"**
4. Tippe auf **"Weiter zur Website"**

### Option B: Zertifikat installieren (empfohlen, keine Warnungen)

#### 1. Zertifikat auf iPad übertragen:
- **Per AirDrop**: Sende `certs/server.crt` vom Computer an iPad
- **Per Email**: Sende die Datei an deine Email und öffne sie auf dem iPad
- **Per USB**: Kopiere die Datei mit iTunes/Finder

#### 2. Profil installieren:
1. Öffne die `.crt` Datei auf dem iPad
2. Gehe zu **Einstellungen** → **Allgemein** → **VPN & Geräteverwaltung**
3. Tippe auf das **Bestellsystem-Profil**
4. Tippe auf **Installieren**
5. Gib deinen Passcode ein

#### 3. Zertifikat als vertrauenswürdig markieren:
1. Gehe zu **Einstellungen** → **Allgemein** → **Info** → **Zertifikatvertrauenseinstellungen**
2. Aktiviere den Schalter für **localhost**

## Schritt 4: App über HTTPS aufrufen

Öffne Safari und gehe zu:
```
https://<deine-server-ip>:3443
```

Beispiel: `https://192.168.1.100:3443`

## Wake Lock Funktion testen

1. Melde dich in der App an (Waiter, Bar oder Admin)
2. Öffne die **Browser-Konsole** (Safari → Entwickler → Konsole)
3. Du solltest sehen: `Wake Lock aktiv - Display bleibt eingeschaltet`
4. Das Display sollte nun nicht mehr dimmen oder in Standby gehen

## Troubleshooting

### "OpenSSL ist nicht installiert"
**Windows:**
```bash
choco install openssl
```
Oder Download: https://slproweb.com/products/Win32OpenSSL.html

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install openssl
```

**Mac:**
```bash
brew install openssl
```

### "Wake Lock nicht verfügbar"
- Stelle sicher, dass du **HTTPS** verwendest (nicht HTTP)
- Wake Lock funktioniert nur in Safari, nicht in anderen Browsern
- iOS/iPadOS muss mindestens Version 16.4 sein

### "Zertifikatfehler" im Browser
- Stelle sicher, dass die Zertifikate korrekt generiert wurden
- Prüfe, dass das `certs` Verzeichnis gemountet ist (`docker compose logs`)
- Verwende Option B (Zertifikat installieren) statt nur die Warnung zu akzeptieren

### Docker findet Zertifikate nicht
Prüfe die Volumes in `docker-compose.yml`:
```yaml
volumes:
  - ./certs:/app/certs
```

Server-Logs prüfen:
```bash
docker compose logs bestellsystem
```

Du solltest sehen:
```
HTTPS Server on https://localhost:3443
```

## Server-IP herausfinden

**Windows:**
```bash
ipconfig
```
Suche nach "IPv4-Adresse" (z.B. 192.168.1.100)

**Linux/Mac:**
```bash
ifconfig
# oder
ip addr show
```

## Sicherheitshinweis

Selbstsignierte Zertifikate sind für Entwicklung und lokale Netzwerke geeignet. Für den produktiven Einsatz im Internet solltest du ein von einer Certificate Authority (CA) signiertes Zertifikat verwenden (z.B. Let's Encrypt).
