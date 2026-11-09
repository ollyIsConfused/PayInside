# Pay Inside – Einkaufen ohne Kasse

Kunden scannen am Eingang einen QR-Code, scannen ihre Produkte mit dem Handy, zahlen mit Apple Pay, Google Pay oder Karte und gehen mit einem Ausgangscode durch die Schranke. Der Bon kommt digital und TSE-signiert aufs Handy.

Händler melden sich **selbst** an, verbinden ihr Auszahlungskonto, laden ihre Produkte per CSV hoch, drucken das QR-Poster und sind live. Du verdienst an jedem Einkauf automatisch mit. Dein Aufwand: Server laufen lassen und Support.

```
 Eingangs-QR ─▶ Kunden-App / Browser ◀──HTTPS──▶ Pay-Inside-Server ◀── Händler-Portal (Web)
 (nur Laden-ID)   scannen · zahlen · Bon          Preise · Zahlung · TSE        Produkte · Einkäufe · Poster
                        │ Ausgangscode (signiert, einmalig)   │
                        ▼                                     ▼
                  Schranke (Raspberry Pi) ──prüft──▶ /v1/gate/verify     Stripe Connect · fiskaly TSE
```

## Was drin ist

| Teil | Ordner | Stand |
|---|---|---|
| **Server + API** (Node.js, TypeScript, PostgreSQL) | `server/` | fertig, 19 automatische Tests grün |
| **Händler-Portal**: Registrierung, Läden, CSV-Import, Einkäufe, Erstattung, QR-Poster, Einstellungen | `server/src/routes/merchant.ts` | fertig, im Browser getestet |
| **Web-Shopper**: Einkaufen im Browser, ohne App (iPhone + Android) | `server/public/js/shop.js` | fertig, im Browser getestet |
| **Kontroll-Seite fürs Personal** (Ausweis, Stichprobe) | `server/public/js/staff.js` | fertig, im Browser getestet |
| **iPhone-App** (SwiftUI, Apple Pay über Stripe) | `ios/` | geschrieben, **noch nicht in Xcode kompiliert** (siehe unten) |
| **Schranken-Steuerung** (Raspberry Pi, mit Offline-Modus) | `gate/` | fertig, online + offline getestet |
| **Livegang**: Docker, HTTPS, tägliche Backups, CI | `docker-compose.yml`, `.github/` | Image gebaut und gestartet |

Eingebaut sind außerdem: Waagen-Etiketten (Barcodes mit 2…), Pfand, MwSt 19/7/0 %, Altersfreigabe 16/18 mit Ausweisprüfung, zufällige Stichproben, einmalig gültige signierte Ausgangscodes, Erstattungen, Katalog-Cache für schlechtes Netz im Laden, Schutz gegen Preismanipulation (der Server rechnet immer selbst), CSRF- und XSS-Schutz und Rate-Limits.

## In 5 Minuten auf deinem Mac ausprobieren

Du brauchst [Homebrew](https://brew.sh):

```bash
brew install node@22 postgresql@16
```

```bash
brew services start postgresql@16
```

```bash
createuser -s payinside && createdb -O payinside payinside && createdb -O payinside payinside_test
```

```bash
psql -d payinside -c "ALTER USER payinside WITH PASSWORD 'payinside';"
```

```bash
cd server && npm install && npm run seed && npm run dev
```

Dann im Browser:

- **Startseite:** http://localhost:3000
- **Händler-Portal:** http://localhost:3000/login, Login `demo@payinside.local` / `demo-passwort-123`
- **Als Kunde einkaufen:** http://localhost:3000/s/demo-laden. Test-Barcodes zum Eintippen: `4006381333931`, `4000417025005`, `4029764001807`, `4008167102427` (Bier, ab 16)
- **Kontrolle:** im Portal oben auf „Kontrolle ↗“ klicken und den Ausgangscode einfügen bzw. scannen

Ohne Stripe-Schlüssel läuft alles im **Testmodus**: Zahlungen und TSE werden simuliert, und Bons tragen den Vermerk „SIMULIERT“.

Tests laufen lassen:

```bash
cd server && npm test
```

## Wie es weitergeht

1. **Ausprobieren** wie oben, zusammen mit jemandem, der einen Laden hat. Hofläden, Kioske und Unverpackt-Läden sind die besten ersten Kunden ([docs/GESCHAEFTSMODELL.md](docs/GESCHAEFTSMODELL.md)).
2. **iPhone-App in Xcode bauen** ([docs/IOS.md](docs/IOS.md)). Dafür brauchst du deinen Mac und deinen Apple-Developer-Account.
3. **Rechtliches klären:** Gewerbe, Steuerberater, AGB/Datenschutz prüfen lassen, TSE und Kassenmeldung ([docs/RECHTLICHES.md](docs/RECHTLICHES.md)).
4. **Live gehen:** Server, Domain, Stripe, fiskaly ([docs/LIVEGANG.md](docs/LIVEGANG.md)).
5. **Optional eine Schranke** mit Raspberry Pi ([docs/SCHRANKE.md](docs/SCHRANKE.md)).

## Ehrlicher Stand – was noch offen ist

- **iOS-App:** In dieser Umgebung gab es keinen Swift-Compiler. Der Code wurde nur auf Syntax geprüft, nicht kompiliert. Rechne beim ersten Build in Xcode mit kleinen Korrekturen (z. B. Imports oder API-Details von Stripe).
- **Stripe live:** Die Anbindung folgt der offiziellen Stripe-API, wurde aber nur im Testmodus (simuliert) durchgespielt. Teste vor dem Livegang mit Stripe-**Test**-Schlüsseln (`sk_test_…`).
- **fiskaly TSE:** Die Implementierung folgt der Dokumentation von SIGN DE v2, wurde aber **nicht gegen die echte API getestet**. Prüfe sie in der fiskaly-Sandbox.
- **Noch nicht eingebaut:** Passwort-vergessen-E-Mail, DSFinV-K-Export für die Betriebsprüfung, Android-App (Android-Nutzer kaufen solange im Browser ein), Mehrbenutzer pro Laden.

## Ordnerstruktur

```
server/            Backend, Händler-Portal, Web-Shopper (Fastify + PostgreSQL)
  src/routes/      api.ts (App-API), merchant.ts (Portal), web.ts (öffentliche Seiten)
  src/services/    orders.ts – Preisberechnung, Checkout, Ausgangscodes
  src/providers/   payments.ts (Stripe Connect), fiscal.ts (fiskaly TSE)
  migrations/      Datenbankschema
  public/          CSS, JavaScript für Web-Shopper und Kontrolle
  test/            automatische Tests
ios/               iPhone-App (SwiftUI), Projekt über XcodeGen
gate/              Raspberry-Pi-Schranke
docs/              Anleitungen
```
