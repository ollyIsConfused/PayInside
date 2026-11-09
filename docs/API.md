# API-Übersicht (für App, Android, Integrationen)

Basis: `https://deine-domain.de`. JSON, Feldnamen in snake_case. Fehler kommen immer als `{ "error": "code", "message": "Text für Menschen", "details"?: … }`.

## Kunden (App / Browser)

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/v1/stores/:slug` | – | Laden-Infos, ob Zahlungen möglich sind, Stripe-Publishable-Key |
| GET | `/v1/stores/:slug/catalog` | – | kompletter Katalog zum Zwischenspeichern, mit ETag bzw. `If-None-Match` → 304 |
| GET | `/v1/stores/:slug/products/:code` | – | einzelnen Barcode auflösen (auch Waagen-Etiketten) |
| POST | `/v1/sessions` | – | `{store, client}` → `{session_token, expires_at, store}`. Wird beim Scannen des Eingangs-QR gestartet. |
| POST | `/v1/cart/price` | Session | Warenkorb vom Server berechnen lassen (Vorschau) |
| POST | `/v1/checkout` | Session | `{items:[{code, qty}]}` → Bestellung + Zahlungsdaten (`payment.clientSecret` für Stripe) |
| GET | `/v1/orders/:id` | Session | Status, Bon, `exit_token` (frisch signiert) |
| GET | `/v1/orders/:id/exit-qr.svg` | Session | Ausgangscode als SVG |
| POST | `/v1/orders/:id/cancel` | Session | offene Zahlung abbrechen |
| POST | `/v1/orders/:id/mock-pay` | Session | nur im Testmodus: Zahlung simulieren |

Session-Auth: Header `Authorization: Bearer <session_token>`.

## Schranke

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/v1/gate/config` | Schranken-Schlüssel | Laden-ID und öffentlicher Schlüssel für die Offline-Prüfung |
| POST | `/v1/gate/verify` | Schranken-Schlüssel | `{token}` → `{result: open/check/deny, reason, message, order}`. Bei `open` gilt der Code als benutzt. |
| GET | `/v1/keys/exit` | – | öffentlicher Ed25519-Schlüssel |

## Ausgangscode-Format

`PI1.<base64url(47 Byte)>.<base64url(Ed25519-Signatur über "PI1.<payload>")>`

Payload: Version (1 Byte, =1) · Bestell-UUID (16) · Laden-UUID (16) · Nonce (9) · Ablauf Unix-Sekunden (4, big-endian) · Flags (1: Bit0 Ausweis, Bit1 Stichprobe).

## Webhooks

`POST /webhooks/stripe` – Stripe-Events (Signatur wird geprüft, jedes Event wird nur einmal verarbeitet).
