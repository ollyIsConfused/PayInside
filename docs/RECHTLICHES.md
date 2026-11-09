# Recht & Steuern – Checkliste

> Das ist keine Rechtsberatung. Lass das mit einem **Steuerberater** und für AGB/Datenschutz mit einem **Anwalt** (oder einem guten Generator wie e-recht24) abklären. Plane dafür einmalig ein paar hundert Euro ein. Das ist gut investiert.

## Für dich als Plattform-Betreiber

| Thema | Was zu tun ist |
|---|---|
| Gewerbe | Gewerbeanmeldung (Software/IT-Dienstleistung). Danach kommt der Fragebogen zur steuerlichen Erfassung vom Finanzamt. |
| Kleinunternehmer? | Bis 25.000 € Umsatz im Vorjahr möglich (Stand 2025). Bei einer Plattform mit Händlern als Kunden ist oft die Regelbesteuerung sinnvoll, weil Händler die Vorsteuer ziehen wollen. Mit dem Steuerberater klären. |
| Zahlungsabwicklung | Du fasst **kein Kundengeld** an: Stripe Connect zahlt direkt an die Händler aus und behält deine Gebühr ein. Deshalb brauchst du keine eigene BaFin-Lizenz. Lass dir das von Stripe bestätigen (Connect-Plattformvertrag). |
| Impressum | Pflicht. Wird aus `.env` erzeugt (`COMPANY_*`), erreichbar unter `/impressum`. |
| Datenschutzerklärung | Vorlage unter `/datenschutz`, muss geprüft werden. Nenne Stripe, fiskaly und deinen Hoster. |
| Auftragsverarbeitung (AVV) | Mit Hetzner, Stripe und fiskaly AV-Verträge abschließen (meist per Klick im jeweiligen Dashboard). Für Händler bist du selbst Auftragsverarbeiter, also einen AVV in die AGB aufnehmen oder separat anbieten. |
| AGB für Händler | Vorlage unter `/agb`, muss geprüft werden. Wichtig: Haftung, Verfügbarkeit, Pflichten des Händlers (Preise, Altersprüfung, Kassenmeldung), Kündigung. |
| Versicherung | Eine Berufs- bzw. IT-Haftpflicht ist für Software, an der Geld hängt, sehr empfehlenswert. |

## Für die Händler (die Ladenbesitzer)

| Thema | Was gilt |
|---|---|
| **Kassensicherungsverordnung (KassenSichV)** | Jedes elektronische Aufzeichnungssystem braucht eine zertifizierte **TSE**. Pay Inside signiert jeden Verkauf über die Cloud-TSE von fiskaly. |
| **Kassenmeldung (§ 146a Abs. 4 AO)** | Elektronische Kassensysteme müssen dem Finanzamt gemeldet werden, über „Mein ELSTER“ (Formular „Mitteilung über elektronische Aufzeichnungssysteme“). Der Händler meldet Pay Inside als Kassensystem mit der TSE-Seriennummer aus dem Portal. Fristen beim Steuerberater erfragen. |
| **Belegausgabepflicht** | Ein Bon muss ausgegeben werden, ein **elektronischer Bon** ist erlaubt. Pay Inside zeigt ihn in der App bzw. im Browser und speichert ihn. |
| Aufbewahrung | Einkäufe bleiben 10 Jahre in der Datenbank (GoBD). Die Aufräum-Jobs löschen keine Bestellungen. |
| **DSFinV-K-Export** | Bei einer Kassennachschau oder Betriebsprüfung muss ein standardisierter Export möglich sein. **Ist noch nicht eingebaut** und steht als nächste Ausbaustufe an (fiskaly bietet dafür eine eigene API). Bis dahin: Export der Einkäufe aus der Datenbank. |
| **Jugendschutz** | Alkohol und Tabak gehen nur mit Ausweisprüfung. Pay Inside markiert solche Einkäufe, und die Schranke öffnet erst nach Bestätigung durch das Personal. Die Verantwortung bleibt beim Händler. **Ganz ohne Personal (24/7) keine altersbeschränkten Waren verkaufen**, außer mit einer zugelassenen Altersverifikation. |
| Preisangaben | Preise im Laden und in der App müssen übereinstimmen. Die App zeigt immer die Preise aus dem Portal. |

## App Store

Apple verlangt für **physische Waren** sogar externe Zahlungen wie Apple Pay oder Karte. In-App-Käufe sind hier **nicht** erlaubt bzw. nötig (App Store Review Guideline 3.1.3(e)). Gib im Review einen Demo-Laden an, siehe [IOS.md](IOS.md).
