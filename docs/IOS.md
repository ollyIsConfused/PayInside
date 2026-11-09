# iPhone-App bauen und veröffentlichen

Die App liegt in `ios/`. Das Xcode-Projekt wird mit **XcodeGen** aus `ios/project.yml` erzeugt. So gibt es keine kaputten Projektdateien, und Änderungen sind leicht nachvollziehbar.

## 1. Einmalig einrichten (auf deinem Mac Studio oder MacBook)

1. **Xcode** aus dem Mac App Store installieren (Version 16 oder neuer).
2. XcodeGen installieren:

```bash
brew install xcodegen
```

3. Deine **Team-ID** findest du auf developer.apple.com → Account → Membership (10 Zeichen).
4. Projekt erzeugen und öffnen:

```bash
cd ios && APPLE_TEAM_ID=DEINETEAMID xcodegen && open PayInside.xcodeproj
```

5. Xcode lädt das Stripe-Paket automatisch herunter, das dauert beim ersten Mal ein paar Minuten.

> Wenn du `project.yml` änderst: `xcodegen` erneut ausführen. Das `.xcodeproj` selbst nicht von Hand bearbeiten.

## 2. Im Simulator mit dem lokalen Server testen

1. Server auf dem Mac starten: `cd server && npm run seed && npm run dev`
2. In Xcode das Ziel **iPhone 16 (Simulator)** wählen und mit ⌘R starten.
3. Debug-Builds sprechen mit `http://localhost:3000`.
4. Der Simulator hat keine Kamera. Tippe in der App „QR-Code am Eingang scannen“ an, gib unten `demo-laden` ein und füge Produkte über das Tastatur-Symbol hinzu (z. B. `4006381333931`).

**Auf deinem echten iPhone:** In der App unter Einstellungen → „Entwicklung: Server-Adresse“ die IP deines Macs eintragen, z. B. `http://192.168.178.20:3000`. Die IP findest du unter Systemeinstellungen → WLAN → Details. Mac und iPhone müssen im selben WLAN sein.

## 3. Wenn der erste Build Fehler zeigt

Der Swift-Code wurde ohne Xcode geschrieben und nur auf Syntax geprüft. Typische Kleinigkeiten:

- **Stripe-Import:** Wenn `StripeAPI` oder `STPAPIClient` „not found“ ist, in der betroffenen Datei zusätzlich `import StripeCore` bzw. `import StripePayments` hinzufügen.
- **PaymentSheet-API:** Falls Stripe eine Methode umbenannt hat, schlägt Xcode meist automatisch den neuen Namen vor („Fix“-Button).
- Warnungen zur Concurrency (Swift 6) kannst du ignorieren, das Projekt nutzt den Swift-5-Sprachmodus.

Diese Fehler kann ich dir sofort beheben, wenn du mir die Fehlermeldung schickst.

## 4. Apple Developer Portal (vor TestFlight)

Auf developer.apple.com → Certificates, IDs & Profiles:

1. **App-ID** `de.payinside.app` anlegen (oder deine eigene Bundle-ID, dann in `project.yml` ändern) mit den Fähigkeiten:
   - **Associated Domains** (für Universal Links: Eingangs-QR öffnet direkt die App)
   - **Apple Pay Payment Processing**
2. **Merchant-ID** `merchant.de.payinside` anlegen.
3. **Apple-Pay-Zertifikat für Stripe:** Im Stripe-Dashboard unter Einstellungen → Zahlungsmethoden → Apple Pay → „iOS-Zertifikat hinzufügen“. Stripe gibt dir eine CSR-Datei. Diese lädst du bei Apple zur Merchant-ID hoch und das Zertifikat wieder bei Stripe. Stripe führt dich durch die Schritte.
4. In `project.yml` `PI_DOMAIN` auf deine echte Domain setzen und `xcodegen` erneut ausführen.
5. Auf dem Server in `.env`: `APPLE_TEAM_ID` und `IOS_BUNDLE_ID` setzen. Dann liefert `https://deine-domain/.well-known/apple-app-site-association` die richtige Verknüpfung.

## 5. TestFlight und App Store

1. In Xcode: Product → Archive → Distribute App → App Store Connect.
2. In [App Store Connect](https://appstoreconnect.apple.com) die App anlegen und den Build über TestFlight an dich und Testkunden verteilen.
3. **Hinweise für die App-Prüfung** (App Review Information):
   - „Die App dient zum Bezahlen physischer Waren in Ladengeschäften (Scan & Go). Bezahlung über Apple Pay/Karte via Stripe, keine digitalen Güter.“
   - Demo: „Bitte im Startbildschirm ‚QR-Code am Eingang scannen‘ antippen und unten `demo-laden` eingeben. Barcodes über das Tastatur-Symbol: 4006381333931, 4000417025005.“
   - Lege dafür auf dem Live-Server einen Demo-Laden an und lass ihn mit Stripe-Testmodus oder einem 0,50-€-Produkt laufen.
4. Nach der Freigabe die **App-Store-ID** (Zahl in der App-Store-URL) in `.env` als `IOS_APP_STORE_ID` eintragen. Dann zeigt die Einstiegsseite den „App laden“-Button und das Smart-App-Banner.

## 6. Später: App Clip (Einkaufen ohne Installation, direkt aus dem QR-Code)

Für den Start ist das nicht nötig, weil Kunden ohne App im Browser einkaufen. Ein App Clip darf bei QR-Code-Aufruf nur ca. 15 MB groß sein. Das komplette Stripe-PaymentSheet ist dafür vermutlich zu groß. Der Weg wäre ein zweites Target, das statt `StripePaymentSheet` das schlanke Paket **`StripeApplePay`** nutzt (von Stripe genau für App Clips gedacht) und nur Apple Pay anbietet.
