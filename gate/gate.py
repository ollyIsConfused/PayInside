#!/usr/bin/env python3
"""
Pay Inside – Schranken-/Drehkreuz-Steuerung für Raspberry Pi.

Ablauf: QR-Scanner liest den Ausgangscode → Server prüft ihn (einmalig gültig) → Relais öffnet die Schranke.
Fällt das Internet aus, prüft das Skript die digitale Signatur offline und merkt sich benutzte Codes,
die es später an den Server nachmeldet.

Eingabe-Quellen für den Scanner:
  --input stdin                 Scanner als Tastatur, Programm läuft im Terminal (zum Testen)
  --input serial:/dev/ttyACM0   Scanner im USB-Seriell-Modus (empfohlen für Dauerbetrieb)
  --input evdev:/dev/input/by-id/usb-...-event-kbd   Scanner als Tastatur, Programm läuft als Dienst

Konfiguration über Umgebungsvariablen (oder /etc/payinside-gate.env, siehe README):
  PAYINSIDE_URL   z. B. https://payinside.de
  GATE_KEY        Schranken-Schlüssel aus dem Händler-Portal (Einstellungen → Schranke)
  RELAY_PIN       GPIO für das Relais der Schranke (Standard 17)
  GREEN_PIN / RED_PIN / YELLOW_PIN   optionale Status-LEDs
  OPEN_SECONDS    wie lange das Relais anzieht (Standard 3)
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

STATE_DIR = Path(os.environ.get("GATE_STATE_DIR", Path.home() / ".payinside-gate"))
CONFIG_CACHE = STATE_DIR / "config.json"
USED_FILE = STATE_DIR / "offline-used.json"
QUEUE_FILE = STATE_DIR / "offline-queue.json"


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- Hardware
class Outputs:
    """Relais + LEDs über gpiozero. Ohne Raspberry Pi wird nur geloggt (Simulationsmodus)."""

    def __init__(self) -> None:
        self.open_seconds = float(os.environ.get("OPEN_SECONDS", "3"))
        self.relay = self.green = self.red = self.yellow = None
        try:
            from gpiozero import LED, OutputDevice  # type: ignore

            self.relay = OutputDevice(int(os.environ.get("RELAY_PIN", "17")), active_high=True, initial_value=False)
            for name in ("green", "red", "yellow"):
                pin = os.environ.get(f"{name.upper()}_PIN")
                if pin:
                    setattr(self, name, LED(int(pin)))
            log("GPIO aktiv")
        except Exception as e:  # kein Pi / keine Bibliothek
            log(f"GPIO nicht verfügbar ({e.__class__.__name__}) – Simulationsmodus")

    def _blink(self, led, seconds: float) -> None:
        if led is None:
            return
        led.on()
        threading.Timer(seconds, led.off).start()

    def open(self) -> None:
        log(">>> SCHRANKE AUF")
        self._blink(self.green, self.open_seconds)
        if self.relay is not None:
            self.relay.on()
            threading.Timer(self.open_seconds, self.relay.off).start()

    def check(self) -> None:
        log(">>> BITTE PERSONAL (Ausweis/Stichprobe)")
        self._blink(self.yellow, 5)

    def deny(self) -> None:
        log(">>> ABGELEHNT")
        self._blink(self.red, 2)


# ---------------------------------------------------------------- Server
class Server:
    def __init__(self, url: str, key: str) -> None:
        self.url = url.rstrip("/")
        self.key = key

    def _req(self, method: str, path: str, body: dict | None = None, timeout: float = 3.0) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.url + path,
            data=data,
            method=method,
            headers={"authorization": f"Bearer {self.key}", "content-type": "application/json", "user-agent": "payinside-gate/1"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 409, 422):
                payload = json.loads(e.read().decode() or "{}")
                raise PermissionError(payload.get("message", f"HTTP {e.code}")) from e
            raise ConnectionError(f"HTTP {e.code}") from e
        except (urllib.error.URLError, OSError, ValueError) as e:
            # Netzwerkfehler/Timeout/kaputte Antwort → als Verbindungsproblem behandeln (Offline-Modus)
            raise ConnectionError(str(e)) from e

    def config(self) -> dict:
        return self._req("GET", "/v1/gate/config", timeout=10)

    def verify(self, token: str) -> dict:
        return self._req("POST", "/v1/gate/verify", {"token": token})


# ---------------------------------------------------------------- Offline-Prüfung
def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def offline_verify(token: str, public_key_raw_b64: str, store_id: str) -> tuple[str, str, str | None]:
    """Gibt (result, grund, nonce) zurück. Prüft Signatur, Ablauf und Laden – nicht ob schon benutzt."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey  # type: ignore
    except ImportError:
        return "deny", "offline-Prüfung nicht installiert (pip install cryptography)", None
    parts = token.strip().split(".")
    if len(parts) != 3 or parts[0] != "PI1":
        return "deny", "kein Pay-Inside-Code", None
    try:
        pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_raw_b64))
        pub.verify(b64url_decode(parts[2]), f"PI1.{parts[1]}".encode())
        payload = b64url_decode(parts[1])
    except Exception:
        return "deny", "Signatur ungültig", None
    if len(payload) != 47 or payload[0] != 1:
        return "deny", "unbekanntes Format", None
    store = payload[17:33].hex()
    if store != store_id.replace("-", ""):
        return "deny", "anderer Markt", None
    (exp,) = struct.unpack(">I", payload[42:46])
    if exp < time.time():
        return "deny", "Code abgelaufen", None
    nonce = payload[33:42].hex()
    flags = payload[46]
    if flags & 3:
        return "check", "Kontrolle durch Personal nötig", nonce
    return "open", "offline geprüft", nonce


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value))
    tmp.replace(path)


# ---------------------------------------------------------------- Scanner-Eingabe
def read_stdin():
    for line in sys.stdin:
        yield line.strip()


def read_serial(device: str):
    import serial  # type: ignore

    with serial.Serial(device, 9600, timeout=1) as port:
        buf = b""
        while True:
            chunk = port.read(256)
            if not chunk:
                continue
            buf += chunk
            while b"\r" in buf or b"\n" in buf:
                for sep in (b"\r\n", b"\n", b"\r"):
                    if sep in buf:
                        line, buf = buf.split(sep, 1)
                        break
                yield line.decode(errors="ignore").strip()


def read_evdev(device: str):
    """Liest einen USB-Scanner im Tastatur-Modus (Scanner auf US-Tastaturlayout einstellen!)."""
    from evdev import InputDevice, categorize, ecodes  # type: ignore

    keymap = {f"KEY_{c}": c.lower() for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"}
    keymap.update({f"KEY_{d}": d for d in "0123456789"})
    keymap.update({"KEY_DOT": ".", "KEY_MINUS": "-", "KEY_SLASH": "/", "KEY_EQUAL": "="})
    shifted = {"-": "_", "=": "+"}
    dev = InputDevice(device)
    dev.grab()  # Eingaben nicht an die Konsole weitergeben
    buf, shift = "", False
    for event in dev.read_loop():
        if event.type != ecodes.EV_KEY:
            continue
        key = categorize(event)
        name = key.keycode if isinstance(key.keycode, str) else key.keycode[0]
        if name in ("KEY_LEFTSHIFT", "KEY_RIGHTSHIFT"):
            shift = key.keystate != key.key_up
            continue
        if key.keystate != key.key_down:
            continue
        if name == "KEY_ENTER":
            yield buf
            buf = ""
        elif name in keymap:
            ch = keymap[name]
            buf += (shifted.get(ch, ch.upper()) if shift else ch)


# ---------------------------------------------------------------- Hauptprogramm
def main() -> None:
    ap = argparse.ArgumentParser(description="Pay Inside Schranken-Steuerung")
    ap.add_argument("--input", default="stdin", help="stdin | serial:/dev/ttyACM0 | evdev:/dev/input/...")
    args = ap.parse_args()

    url = os.environ.get("PAYINSIDE_URL", "").strip()
    key = os.environ.get("GATE_KEY", "").strip()
    if not url or not key:
        sys.exit("PAYINSIDE_URL und GATE_KEY müssen gesetzt sein (siehe README).")

    server = Server(url, key)
    out = Outputs()
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    try:
        cfg = server.config()
        save_json(CONFIG_CACHE, cfg)
        log(f"Verbunden mit {url} – Markt: {cfg['store_name']}")
    except Exception as e:
        cfg = load_json(CONFIG_CACHE, None)
        if not cfg:
            sys.exit(f"Server nicht erreichbar und keine gespeicherte Konfiguration: {e}")
        log(f"Server nicht erreichbar ({e}) – nutze gespeicherte Konfiguration")

    used: dict[str, float] = load_json(USED_FILE, {})
    queue: list[str] = load_json(QUEUE_FILE, [])
    lock = threading.Lock()

    def flush_queue() -> None:
        while True:
            time.sleep(30)
            with lock:
                pending = list(queue)
            for token in pending:
                try:
                    server.verify(token)  # markiert den Code serverseitig als benutzt
                except ConnectionError:
                    break
                except Exception:
                    pass
                with lock:
                    queue.remove(token)
                    save_json(QUEUE_FILE, queue)
            # alte Offline-Einträge aufräumen (Codes sind höchstens Minuten gültig)
            with lock:
                cutoff = time.time() - 86400
                for n in [n for n, t in used.items() if t < cutoff]:
                    del used[n]
                save_json(USED_FILE, used)

    threading.Thread(target=flush_queue, daemon=True).start()

    if args.input == "stdin":
        source = read_stdin()
    elif args.input.startswith("serial:"):
        source = read_serial(args.input.split(":", 1)[1])
    elif args.input.startswith("evdev:"):
        source = read_evdev(args.input.split(":", 1)[1])
    else:
        sys.exit("Unbekannte Eingabe – stdin, serial:… oder evdev:…")

    log("Bereit – warte auf Ausgangscodes …")
    for token in source:
        if not token:
            continue
        if not token.startswith("PI1."):
            log(f"Unbekannter Code ignoriert ({token[:12]}…)")
            out.deny()
            continue
        try:
            r = server.verify(token)
            log(f"{r['result'].upper()}: {r['message']}")
            {"open": out.open, "check": out.check}.get(r["result"], out.deny)()
        except PermissionError as e:
            log(f"Abgelehnt: {e}")
            out.deny()
        except Exception as e:
            result, reason, nonce = offline_verify(token, cfg["public_key_raw"], cfg["store_id"])
            with lock:
                if result == "open" and nonce in used:
                    result, reason = "deny", "bereits benutzt (offline)"
                if result == "open":
                    used[nonce] = time.time()
                    queue.append(token)
                    save_json(USED_FILE, used)
                    save_json(QUEUE_FILE, queue)
            log(f"OFFLINE ({e.__class__.__name__}) {result.upper()}: {reason}")
            {"open": out.open, "check": out.check}.get(result, out.deny)()


if __name__ == "__main__":
    main()
