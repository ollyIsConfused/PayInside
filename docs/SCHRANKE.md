# Schranke / Drehkreuz mit Raspberry Pi

Ohne Schranke prüft dein Personal den Ausgangscode mit jedem Handy über die **Kontroll-Seite** (Portal → „Kontrolle ↗“). Eine Schranke ist für Läden gedacht, in denen zeitweise niemand da ist.

## Wie es funktioniert

1. Der Kunde hält den Ausgangscode an den QR-Scanner.
2. Der Raspberry Pi fragt den Server: Ist der Code echt, bezahlt und noch nicht benutzt?
3. Ja → das Relais schaltet → die Schranke öffnet. Der Code ist danach verbraucht.
4. Ausweis- oder Stichprobenkontrolle nötig → gelbe LED leuchtet, Personal prüft auf der Kontroll-Seite und klickt „Freigeben“. Beim nächsten Scan öffnet die Schranke.
5. **Internet weg?** Dann prüft der Pi die digitale Signatur selbst (offline), merkt sich benutzte Codes und meldet sie nach, sobald das Netz wieder da ist.

## Einkaufsliste (ca. 120–200 €)

| Teil | Hinweis |
|---|---|
| Raspberry Pi 4 oder 5 + Netzteil + SD-Karte (32 GB) | Raspberry Pi OS Lite |
| USB-QR-Scanner (2D, „Presentation Scanner“) | z. B. Netum, Eyoyo. Muss **QR-Codes vom Handy-Display** lesen können. |
| Relaismodul 5 V, 1 Kanal | schaltet den „Öffnen“-Kontakt der Schranke |
| optional 3 LEDs (grün/gelb/rot) + Widerstände | Statusanzeige |
| Schranke/Drehkreuz mit potentialfreiem Öffnen-Eingang | die meisten haben einen „Taster“- oder „Impuls“-Eingang |

> ⚠️ **Strom:** Arbeite nur an Kleinspannung (Relais-Kontakt ↔ Taster-Eingang der Schranke). Alles mit 230 V gehört in die Hände einer Elektrofachkraft.

## Verkabelung

- Relais: VCC → Pin 2 (5 V), GND → Pin 6, IN → **GPIO 17** (Pin 11)
- Relais-Kontakte COM + NO → an den Taster-/Öffnen-Eingang der Schranke (wie ein Taster parallel)
- LEDs (optional): GPIO 22 grün, GPIO 27 gelb, GPIO 23 rot, jeweils mit 330-Ω-Widerstand gegen GND

## Installation auf dem Pi

Alle Befehle auf dem Pi ausführen (per SSH). Zuerst die Programme:

```bash
sudo apt update && sudo apt install -y python3-venv git
```

Code holen und Python-Umgebung anlegen:

```bash
sudo git clone https://github.com/DEIN-NAME/payinside.git /opt/payinside-src
```

```bash
sudo mkdir -p /opt/payinside-gate && sudo cp /opt/payinside-src/gate/* /opt/payinside-gate/
```

```bash
sudo python3 -m venv /opt/payinside-gate/venv && sudo /opt/payinside-gate/venv/bin/pip install -r /opt/payinside-gate/requirements.txt
```

Konfiguration anlegen:

```bash
sudo nano /etc/payinside-gate.env
```

Inhalt (den Schlüssel bekommst du im Portal unter Einstellungen → Schranke → „Schlüssel erzeugen“):

```
PAYINSIDE_URL=https://deine-domain.de
GATE_KEY=gk_...
GATE_INPUT=evdev:/dev/input/by-id/usb-DEIN_SCANNER-event-kbd
RELAY_PIN=17
GREEN_PIN=22
YELLOW_PIN=27
RED_PIN=23
OPEN_SECONDS=3
GATE_STATE_DIR=/var/lib/payinside-gate
```

Den Scanner-Namen findest du so:

```bash
ls /dev/input/by-id/
```

**Scanner-Einstellung:** Stelle den Scanner auf **US-Tastaturlayout** und „Enter als Suffix“ ein. Dafür liegen Einstell-Barcodes im Handbuch. Alternativ den USB-Seriell-Modus (USB-CDC) nutzen: `GATE_INPUT=serial:/dev/ttyACM0`.

Zuerst von Hand testen (im Terminal):

```bash
sudo bash -c 'set -a; . /etc/payinside-gate.env; /opt/payinside-gate/venv/bin/python /opt/payinside-gate/gate.py --input stdin'
```

Einen Ausgangscode scannen oder einfügen und Enter drücken. Wenn alles klappt, als Dienst einrichten, der beim Start automatisch läuft:

```bash
sudo cp /opt/payinside-gate/payinside-gate.service /etc/systemd/system/ && sudo systemctl enable --now payinside-gate
```

Log ansehen:

```bash
journalctl -u payinside-gate -f
```
