import { normalizeCode, isValidGtin } from './barcode.js';
import { parsePriceToCents, type VatRate } from './money.js';

// Produktimport aus CSV (z. B. Export aus der Warenwirtschaft oder Excel "CSV (Trennzeichen-getrennt)").
// Erkannt werden Semikolon, Komma und Tab als Trennzeichen sowie deutsche und englische Spaltennamen.

export interface ImportedProduct {
  code: string;
  name: string;
  price_cents: number;
  vat_rate: VatRate;
  deposit_cents: number;
  min_age: 0 | 16 | 18;
  active: boolean;
}

export interface ImportResult {
  products: ImportedProduct[];
  errors: { line: number; message: string }[];
}

const HEADER_ALIASES: Record<keyof ImportedProduct | 'plu', string[]> = {
  code: ['ean', 'gtin', 'barcode', 'code', 'artikelnummer', 'ean13', 'strichcode'],
  plu: ['plu', 'waagennummer', 'waage'],
  name: ['name', 'bezeichnung', 'artikel', 'produkt', 'artikelbezeichnung', 'description'],
  price_cents: ['preis', 'price', 'vk', 'verkaufspreis', 'vkpreis', 'brutto', 'bruttopreis'],
  vat_rate: ['mwst', 'ust', 'vat', 'steuer', 'steuersatz', 'mwstsatz', 'tax'],
  deposit_cents: ['pfand', 'deposit'],
  min_age: ['alter', 'fsk', 'minage', 'mindestalter', 'altersfreigabe', 'age'],
  active: ['aktiv', 'active'],
};

/** Zerlegt CSV-Text in Zeilen/Felder (unterstützt Anführungszeichen und Zeilenumbrüche in Feldern). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim =
    delimiter ??
    [';', '\t', ','].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ';');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function headerKey(h: string): keyof typeof HEADER_ALIASES | null {
  const k = h.toLowerCase().replace(/[^a-z0-9äöü]/g, '');
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(k)) return key as keyof typeof HEADER_ALIASES;
  }
  return null;
}

function parseVat(v: string): VatRate | null {
  const s = v.trim().replace('%', '').replace(',', '.').toLowerCase();
  if (s === '' ) return 19;
  if (['19', '0.19', 'a', 'voll', 'normal'].includes(s)) return 19;
  if (['7', '0.07', 'b', 'ermäßigt', 'ermaessigt', 'reduziert'].includes(s)) return 7;
  if (['0', '0.0', 'c', 'frei', 'steuerfrei'].includes(s)) return 0;
  return null;
}

function parseAge(v: string): 0 | 16 | 18 | null {
  const s = v.trim().toLowerCase();
  if (s === '' || s === '0' || s === 'nein' || s === 'no') return 0;
  if (s === '16') return 16;
  if (s === '18' || s === 'ja' || s === 'yes') return 18;
  return null;
}

function parseBool(v: string): boolean {
  return !['0', 'nein', 'no', 'false', 'inaktiv'].includes(v.trim().toLowerCase());
}

export function importProductsCsv(text: string): ImportResult {
  const rows = parseCsv(text);
  const errors: ImportResult['errors'] = [];
  if (rows.length === 0) return { products: [], errors: [{ line: 1, message: 'Datei ist leer' }] };

  const header = rows[0].map(headerKey);
  if (!header.includes('name') || !header.includes('price_cents') || !(header.includes('code') || header.includes('plu'))) {
    return {
      products: [],
      errors: [{ line: 1, message: 'Kopfzeile braucht mindestens die Spalten EAN (oder PLU), Name und Preis' }],
    };
  }

  const seen = new Map<string, number>();
  const products: ImportedProduct[] = [];
  rows.slice(1).forEach((cols, idx) => {
    const line = idx + 2;
    const get = (k: keyof typeof HEADER_ALIASES) => {
      const i = header.indexOf(k);
      return i >= 0 ? (cols[i] ?? '').trim() : '';
    };
    const plu = get('plu').replace(/\D/g, '');
    let code = normalizeCode(get('code'));
    if (!code && plu) code = `PLU:${plu.padStart(5, '0')}`;
    if (!code) return errors.push({ line, message: 'EAN/PLU fehlt' });
    if (/^\d+$/.test(code) && !isValidGtin(code)) {
      return errors.push({ line, message: `EAN ${code} hat eine ungültige Prüfziffer` });
    }
    const name = get('name');
    if (!name) return errors.push({ line, message: 'Name fehlt' });
    const price = parsePriceToCents(get('price_cents'));
    if (price === null) return errors.push({ line, message: `Preis "${get('price_cents')}" nicht lesbar` });
    const vat = parseVat(get('vat_rate'));
    if (vat === null) return errors.push({ line, message: `MwSt "${get('vat_rate')}" muss 19, 7 oder 0 sein` });
    const depositRaw = get('deposit_cents');
    const deposit = depositRaw ? parsePriceToCents(depositRaw) : 0;
    if (deposit === null) return errors.push({ line, message: `Pfand "${depositRaw}" nicht lesbar` });
    const age = parseAge(get('min_age'));
    if (age === null) return errors.push({ line, message: `Altersfreigabe "${get('min_age')}" muss leer, 16 oder 18 sein` });
    const activeRaw = get('active');

    if (seen.has(code)) {
      errors.push({ line, message: `Code ${code} doppelt (auch in Zeile ${seen.get(code)}) – letzte Zeile gilt` });
      const i = products.findIndex((p) => p.code === code);
      if (i >= 0) products.splice(i, 1);
    }
    seen.set(code, line);
    products.push({
      code,
      name: name.slice(0, 200),
      price_cents: price,
      vat_rate: vat,
      deposit_cents: deposit,
      min_age: age,
      active: activeRaw ? parseBool(activeRaw) : true,
    });
  });
  return { products, errors };
}

export const CSV_TEMPLATE =
  'EAN;PLU;Name;Preis;MwSt;Pfand;Alter\n' +
  '4006381333931;;Kugelschreiber blau;1,49;19;;\n' +
  '4000417025005;;Vollmilch 1L;1,19;7;;\n' +
  '4029764001807;;Mineralwasser 0,5L;0,89;19;0,25;\n' +
  '4008167102427;;Bier 0,5L;1,29;19;0,08;16\n' +
  ';00123;Äpfel lose (Waage);2,99;7;;\n';
