// Barcode-Hilfen: EAN-8/EAN-13/UPC-A prüfen und normalisieren, Waagen-Etiketten (EAN-13 mit Präfix 2x) auslesen.

export type WeightBarcodeFormat = 'none' | 'price4_check' | 'price5';

/** GS1-Prüfziffer für die ersten n-1 Stellen berechnen. */
export function gs1CheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  const len = digitsWithoutCheck.length;
  for (let i = 0; i < len; i++) {
    const d = digitsWithoutCheck.charCodeAt(len - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}

/**
 * Bringt einen gescannten Code in die Form, in der er in der Datenbank steht:
 * - UPC-A (12 Stellen) → EAN-13 mit führender 0
 * - GTIN-14 mit führender 0 → EAN-13
 * - Leerzeichen/Bindestriche entfernt
 * Nicht-numerische Codes (z. B. eigene Artikelnummern) bleiben unverändert (getrimmt).
 */
export function normalizeCode(raw: string): string {
  const s = raw.trim().replace(/[\s-]/g, '');
  if (/^\d{12}$/.test(s)) return '0' + s;
  if (/^0\d{13}$/.test(s)) return s.slice(1);
  return s;
}

export interface WeightBarcode {
  plu: string;        // Artikelnummer der Waage (5-stellig)
  priceCents: number; // auf dem Etikett codierter Gesamtpreis
}

/**
 * Liest ein In-Store-Etikett von der Waage (EAN-13, beginnt mit 2).
 * Aufbau (häufigstes Format in Deutschland, 'price4_check'):
 *   Stelle 1-2  Präfix (20–29)
 *   Stelle 3-7  Artikelnummer (PLU), 5-stellig
 *   Stelle 8    Preis-Prüfziffer
 *   Stelle 9-12 Preis in Cent (max. 99,99 €)
 *   Stelle 13   EAN-Prüfziffer
 * 'price5': Stelle 8-12 Preis in Cent (5-stellig, max. 999,99 €), keine Preis-Prüfziffer.
 * Die tatsächliche Belegung hängt von der Waagen-Konfiguration ab – im Händler-Portal einstellbar.
 */
export function parseWeightBarcode(code: string, format: WeightBarcodeFormat): WeightBarcode | null {
  if (format === 'none') return null;
  if (!/^2\d{12}$/.test(code) || !isValidGtin(code)) return null;
  const plu = code.slice(2, 7);
  const priceDigits = format === 'price4_check' ? code.slice(8, 12) : code.slice(7, 12);
  return { plu, priceCents: Number.parseInt(priceDigits, 10) };
}

export function pluCode(plu: string): string {
  return `PLU:${plu.padStart(5, '0')}`;
}
