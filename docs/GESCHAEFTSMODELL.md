# Geschäftsmodell – wie Pay Inside Geld verdient

## Einnahmen: Gebühr pro Einkauf

Standard: **2,5 % + 0,35 € pro Einkauf**, keine Grundgebühr (einstellbar über `PLATFORM_FEE_BPS` / `PLATFORM_FEE_FIXED_CENTS`, pro Laden in der Datenbank anpassbar).

Stripe zieht die Gebühr automatisch ein. Davon bezahlst du die Stripe-Kosten, der Rest ist deine Marge:

| Einkauf | Deine Gebühr | Stripe (ca. 1,5 % + 0,25 €) | Bleibt dir |
|---:|---:|---:|---:|
| 5 € | 0,48 € | 0,33 € | **0,15 €** |
| 15 € | 0,73 € | 0,48 € | **0,25 €** |
| 30 € | 1,10 € | 0,70 € | **0,40 €** |

*Stripe-Preise sind Schätzwerte. Prüfe die aktuellen Preise für Connect und EU-Karten auf stripe.com/de/pricing. Dazu kommen kleine Connect-Monatsgebühren pro aktivem Händler.*

**Beispielrechnung:** Ein Hofladen mit 40 Einkäufen am Tag zu je 15 € bringt dir etwa 40 × 0,25 € × 30 = **300 € im Monat**. Mit zehn solchen Läden sind es etwa 3.000 € im Monat. Deine Fixkosten liegen bei etwa 10–60 € im Monat (Server, Backup, Domain, plus TSE-Kosten pro Laden, die du einpreisen musst).

> **Wichtig:** fiskaly kostet pro TSE bzw. Kasse und Monat. Hol dir ein Angebot und lege die Kosten entweder in die Prozent-Gebühr oder verlange einen kleinen Monatsbetrag ab dem 2. Monat (z. B. 9 €). Ohne das kann ein Laden mit wenig Umsatz dich Geld kosten.

## Warum Händler zahlen

- **Hofladen / Selbstbedienung:** Statt Vertrauenskasse (Schwund 10–30 %) ist jeder Einkauf bezahlt und dokumentiert.
- **Kiosk / kleiner Laden:** keine Schlange, kein Wechselgeld, kein teures Kassensystem
- **24/7-Container / Smart Store:** verkaufen, wenn niemand da ist
- **Unverpackt-Laden:** mit Waagen-Etiketten
- Kein Vertrag, keine Grundgebühr, kein Risiko: Das ist dein stärkstes Verkaufsargument.

## Zielgruppen in Reihenfolge

1. **Hofläden und Verkaufshütten** – leiden am meisten unter Schwund, haben wenig Technik und kaufen schnell.
2. **Kioske, Vereinsheime, Campingplatz-Läden**
3. **Unverpackt- und Bioläden**
4. **24/7-Smart-Stores** – brauchen eine Schranke (siehe [SCHRANKE.md](SCHRANKE.md)) und sind ein Upsell für Hardware-Installation.

Große Ketten (REWE, Edeka, Globus) haben eigene Lösungen oder Anbieter wie snabble. Mit denen konkurrierst du anfangs **nicht**.

## Was schon automatisch läuft (Selbstläufer)

- Händler registrieren sich selbst, legen Läden an, verbinden ihr Konto (Stripe übernimmt Identitätsprüfung und Geldwäschecheck) und laden Produkte hoch.
- Zahlungen, Gebühren und Auszahlungen laufen vollautomatisch.
- Die TSE richtet sich per Klick ein, jeder Bon wird automatisch signiert.
- Das QR-Poster erstellt sich selbst.
- Backups laufen täglich, hängengebliebene Zahlungen und abgelaufene Sessions werden stündlich aufgeräumt.
- Erstattungen erledigt der Händler selbst im Portal.

## Was du noch tun musst

- **Vertrieb:** Läden anrufen oder hinfahren. Die ersten 3–5 Läden persönlich begleiten, die machen dann Werbung für dich.
- **Support:** Fragen per E-Mail beantworten. Eine FAQ-Seite reduziert das stark.
- **Updates** einspielen und Monitoring beobachten.

## Wachstum später

- **Android-App:** mit der gleichen API. Bis dahin funktioniert der Browser.
- **Schranken-Komplettpaket** (Raspberry Pi, Scanner, Installation) als Hardware-Verkauf mit Marge
- **Empfehlungsprogramm:** Händler wirbt Händler und bekommt einen Monat gebührenfrei.
- **Statistiken und Bestseller-Auswertung** als Premium-Funktion
- **Kundenkarte und Rabatte** pro Laden
