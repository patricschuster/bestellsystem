#!/bin/bash
# Generiert selbstsignierte SSL-Zertifikate für HTTPS

mkdir -p certs

# Generiere privaten Schlüssel und Zertifikat
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/server.key \
  -out certs/server.crt \
  -subj "/C=DE/ST=State/L=City/O=Bestellsystem/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:192.168.1.1,IP:127.0.0.1"

echo "✓ Zertifikate erstellt in ./certs/"
echo "  - certs/server.key"
echo "  - certs/server.crt"
echo ""
echo "WICHTIG für iPad/Safari:"
echo "1. Öffne https://<server-ip>:3443 im Safari"
echo "2. Tippe auf 'Erweitert' → 'Weiter zur Website'"
echo "3. Akzeptiere die Warnung"
echo ""
echo "Alternativ: Installiere das Zertifikat als vertrauenswürdig:"
echo "1. Sende certs/server.crt an dein iPad (per AirDrop/Email)"
echo "2. Installiere das Profil in Einstellungen → Allgemein → VPN & Geräteverwaltung"
echo "3. Aktiviere es unter Einstellungen → Allgemein → Info → Zertifikatvertrauenseinstellungen"
