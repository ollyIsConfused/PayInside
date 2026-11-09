// Geldbeträge werden überall als ganze Cent (integer) geführt – niemals als Fließkommazahl.
// Preise im Einzelhandel sind Bruttopreise (inkl. MwSt.).

export type VatRate = 0 | 7 | 19;

export interface VatLine {
  rate: VatRate;
  gross_cents: number;
  net_cents: number;
  vat_cents: number;
}

/** Rechnet aus einem Bruttobetrag Netto und MwSt. heraus (kaufmännisch gerundet). */
export function splitGross(grossCents: number, rate: VatRate): { net: number; vat: number } {
  const net = Math.round((grossCents * 100) / (100 + rate));
  return { net, vat: grossCents - net };
}

/** Summiert Bruttobeträge je Steuersatz und berechnet Netto/MwSt. je Satz. */
export function vatBreakdown(lines: { gross_cents: number; vat_rate: VatRate }[]): VatLine[] {
  const sums = new Map<VatRate, number>();
  for (const l of lines) sums.set(l.vat_rate, (sums.get(l.vat_rate) ?? 0) + l.gross_cents);
  return [...sums.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, gross]) => {
      const { net, vat } = splitGross(gross, rate);
      return { rate, gross_cents: gross, net_cents: net, vat_cents: vat };
    });
}

/** Plattformgebühr: Prozentsatz in Basispunkten plus fixer Betrag – nie mehr als der Einkauf selbst. */
export function platformFee(totalCents: number, bps: number, fixedCents: number): number {
  if (totalCents <= 0) return 0;
  const fee = Math.round((totalCents * bps) / 10_000) + fixedCents;
  return Math.min(Math.max(fee, 0), totalCents);
}

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export function formatEur(cents: number): string {
  return eur.format(cents / 100);
}

/**
 * Liest einen Preis wie "1,99", "1.99", "1.299,00", "€ 2,50" oder "199ct" und gibt Cent zurück.
 * Gibt null zurück, wenn der Wert nicht eindeutig ist.
 */
export function parsePriceToCents(input: string): number | null {
  let s = input.trim().replace(/€|eur/gi, '').replace(/\s/g, '');
  if (s === '') return null;
  if (/^\d+ct$/i.test(s)) return Number.parseInt(s, 10);
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10) * 100;
  // Format mit Tausendertrennzeichen erkennen
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else if (!/^\d+\.\d{1,2}$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number.parseInt(whole, 10) * 100 + Number.parseInt(frac.padEnd(2, '0'), 10);
}
