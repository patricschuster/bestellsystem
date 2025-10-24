@echo off
REM Generiert selbstsignierte SSL-Zertifikate für HTTPS

if not exist certs mkdir certs

echo Generiere SSL-Zertifikate...
echo.

openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout certs\server.key -out certs\server.crt -subj "/C=DE/ST=State/L=City/O=Bestellsystem/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:192.168.1.1,IP:127.0.0.1"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo FEHLER: OpenSSL ist nicht installiert oder nicht im PATH
    echo.
    echo Bitte installiere OpenSSL:
    echo   - Mit Chocolatey: choco install openssl
    echo   - Download: https://slproweb.com/products/Win32OpenSSL.html
    echo.
    pause
    exit /b 1
)

echo.
echo ✓ Zertifikate erstellt in .\certs\
echo   - certs\server.key
echo   - certs\server.crt
echo.
echo WICHTIG fuer iPad/Safari:
echo 1. Oeffne https://^<server-ip^>:3443 im Safari
echo 2. Tippe auf 'Erweitert' -^> 'Weiter zur Website'
echo 3. Akzeptiere die Warnung
echo.
echo Alternativ: Installiere das Zertifikat als vertrauenswuerdig:
echo 1. Sende certs\server.crt an dein iPad (per AirDrop/Email)
echo 2. Installiere das Profil in Einstellungen -^> Allgemein -^> VPN ^& Geraeteverwaltung
echo 3. Aktiviere es unter Einstellungen -^> Allgemein -^> Info -^> Zertifikatvertrauenseinstellungen
echo.
pause
