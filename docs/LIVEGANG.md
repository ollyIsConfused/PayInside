# Livegang – Schritt für Schritt

Rechne mit einem Wochenende für die Technik. Die Verträge (Stripe-Prüfung, fiskaly, Steuerberater) dauern meist ein paar Tage.

## 1. Voraussetzungen

- **Gewerbe angemeldet** (Gewerbeamt deiner Stadt, ca. 20–60 €). Stripe verlangt ein Unternehmen oder Einzelunternehmen.
- **Eigene Domain**, z. B. `payinside.de` (ca. 1 €/Monat bei INWX, Strato, IONOS oder Hetzner)
- **Geschäftskonto** für deine Einnahmen

## 2. Server mieten

Empfehlung: **Hetzner Cloud CX22** (2 vCPU, 4 GB RAM, ca. 5 €/Monat, Standort Deutschland, DSGVO-freundlich).

1. Server mit **Ubuntu 24.04** anlegen und deinen SSH-Schlüssel hinterlegen.
2. Bei deiner Domain einen **A-Record** auf die IP des Servers setzen.
3. Auf dem Server einloggen:

```bash
ssh root@DEINE-SERVER-IP
```

4. Docker installieren:

```bash
curl -fsSL https://get.docker.com | sh
```

5. Code auf den Server bringen, am einfachsten über ein privates GitHub-Repo:

```bash
git clone https://github.com/DEIN-NAME/payinside.git && cd payinside
```

6. Konfiguration anlegen und ausfüllen:

```bash
cp .env.production.example .env && nano .env
```

Ein sicheres `SESSION_SECRET` erzeugst du so:

```bash
openssl rand -hex 32
```

7. Starten:

```bash
docker compose up -d --build
```

Nach etwa einer Minute ist `https://deine-domain.de` mit gültigem HTTPS-Zertifikat erreichbar.

**Updates einspielen:**

```bash
git pull && docker compose up -d --build
```

**Logs ansehen:**

```bash
docker compose logs -f app
```

## 3. Stripe (Zahlungen)

1. Konto auf [stripe.com](https://stripe.com/de) anlegen und Unternehmen verifizieren.
2. **Connect aktivieren:** Dashboard → Connect → „Plattform oder Marktplatz“. Typ: **Express**-Konten.
3. **API-Schlüssel** (Entwickler → API-Schlüssel) in `.env` eintragen. Zuerst **Test**-Schlüssel nehmen (`sk_test_…` / `pk_test_…`) und alles durchspielen, erst dann Live-Schlüssel.
4. **Webhooks** (Entwickler → Webhooks) anlegen:
   - Endpunkt `https://deine-domain.de/webhooks/stripe` für **Ereignisse in deinem Konto**: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`
   - Denselben Endpunkt noch einmal für **Ereignisse in verbundenen Konten**: `account.updated`
   - Beide Signing-Secrets kommagetrennt in `STRIPE_WEBHOOK_SECRET` eintragen.
5. **Apple Pay im Browser:** Einstellungen → Zahlungsmethoden → Zahlungsmethoden-Domains → Domain hinzufügen. Die angebotene Datei als `server/public/apple-developer-merchantid-domain-association` speichern und neu deployen.
6. **Testkarte:** `4242 4242 4242 4242`, beliebiges Datum in der Zukunft, beliebige Prüfnummer.

**Kosten:** Stripe berechnet für europäische Karten ca. 1,5 % + 0,25 € pro Zahlung (aktuelle Preise auf stripe.com/de/pricing prüfen) sowie für Connect-Express-Konten eine kleine Monatsgebühr pro aktivem Konto. Das bezahlst du aus deiner Plattformgebühr, siehe [GESCHAEFTSMODELL.md](GESCHAEFTSMODELL.md).

## 4. fiskaly (TSE)

1. Konto auf [fiskaly.com](https://www.fiskaly.com) anlegen und das Produkt **SIGN DE** wählen.
2. In der **Test-Umgebung** einen API-Key erzeugen und in `.env` eintragen.
3. Im Portal einen Test-Laden anlegen, auf „TSE einrichten“ klicken und einen Testeinkauf machen. Danach müssen auf dem Bon Seriennummer, Signaturzähler und Signatur stehen.
4. Wenn etwas fehlschlägt: Die Fehlermeldung steht im Portal und im Log. Die Anbindung ist in `server/src/providers/fiscal.ts`.
5. Danach den Live-Zugang bei fiskaly beantragen. Kosten: pro TSE bzw. Kasse und Monat, Preise bei fiskaly anfragen.

## 5. Überwachung (damit es ein Selbstläufer bleibt)

- **Erreichbarkeit:** kostenloses Monitoring, z. B. [UptimeRobot](https://uptimerobot.com) auf `https://deine-domain.de/healthz`, mit E-Mail- oder Push-Benachrichtigung.
- **Backups:** Laufen automatisch täglich nach `./backups`. Kopiere sie zusätzlich woanders hin, z. B. als Hetzner Storage Box (ca. 4 €/Monat) per `rsync`-Cronjob, oder schalte Hetzner-Server-Backups ein (+20 %).
- **Updates des Betriebssystems:** einmal einrichten:

```bash
apt install unattended-upgrades
```

## 6. iPhone-App veröffentlichen

Siehe [IOS.md](IOS.md). Bis die App im App Store ist, kaufen alle Kunden im Browser ein – das funktioniert sofort.

## 7. Erster Pilot-Laden

1. Den Ladenbesitzer im Portal registrieren lassen (oder gemeinsam vor Ort).
2. Auszahlungskonto verbinden: Stripe fragt Ausweis und IBAN ab.
3. Produkte per CSV hochladen. Die meisten Warenwirtschaften und Excel können CSV exportieren.
4. TSE einrichten.
5. Die **Kassenmeldung beim Finanzamt** macht der Händler über „Mein ELSTER“ (siehe [RECHTLICHES.md](RECHTLICHES.md)).
6. QR-Poster drucken, laminieren und am Eingang aufhängen.
7. Laden aktivieren und die ersten Tage dabei sein und zuschauen.
