import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gs1CheckDigit, isValidGtin, normalizeCode, parseWeightBarcode } from '../src/lib/barcode.js';
import { parsePriceToCents, platformFee, splitGross, vatBreakdown } from '../src/lib/money.js';
import { importProductsCsv, parseCsv } from '../src/lib/csv.js';
import { createExitSigner, decodePayload, encodePayload, generateExitKeyPem, newNonce } from '../src/lib/exitToken.js';
import { hashPassword, slugify, verifyPassword } from '../src/lib/security.js';

test('EAN-Prüfziffer und Normalisierung', () => {
  assert.equal(gs1CheckDigit('400638133393'), 1);
  assert.ok(isValidGtin('4006381333931'));
  assert.ok(!isValidGtin('4006381333932'));
  assert.ok(isValidGtin('96385074'));
  assert.equal(normalizeCode('036000291452'), '0036000291452'); // UPC-A → EAN-13
  assert.equal(normalizeCode(' 4006381-333931 '), '4006381333931');
  assert.equal(normalizeCode('04006381333931'), '4006381333931'); // GTIN-14
});

test('Waagen-Etikett lesen', () => {
  // 21 00123 P 0217 C  → PLU 00123, 2,17 €
  const base = '2100123' + '0' + '0217';
  const code = base + gs1CheckDigit(base);
  assert.deepEqual(parseWeightBarcode(code, 'price4_check'), { plu: '00123', priceCents: 217 });
  assert.deepEqual(parseWeightBarcode(code, 'price5'), { plu: '00123', priceCents: 217 });
  assert.equal(parseWeightBarcode(code, 'none'), null);
  assert.equal(parseWeightBarcode('4006381333931', 'price4_check'), null);
});

test('Preise lesen', () => {
  assert.equal(parsePriceToCents('1,99'), 199);
  assert.equal(parsePriceToCents('1.99'), 199);
  assert.equal(parsePriceToCents('€ 2,5'), 250);
  assert.equal(parsePriceToCents('1.299,00'), 129900);
  assert.equal(parsePriceToCents('3'), 300);
  assert.equal(parsePriceToCents('abc'), null);
});

test('MwSt-Aufteilung und Gebühr', () => {
  assert.deepEqual(splitGross(119, 19), { net: 100, vat: 19 });
  assert.deepEqual(splitGross(107, 7), { net: 100, vat: 7 });
  const b = vatBreakdown([
    { gross_cents: 119, vat_rate: 19 },
    { gross_cents: 214, vat_rate: 7 },
    { gross_cents: 119, vat_rate: 19 },
  ]);
  assert.deepEqual(b, [
    { rate: 19, gross_cents: 238, net_cents: 200, vat_cents: 38 },
    { rate: 7, gross_cents: 214, net_cents: 200, vat_cents: 14 },
  ]);
  assert.equal(platformFee(1000, 250, 35), 60);
  assert.equal(platformFee(20, 250, 35), 20); // nie mehr als der Betrag
});

test('CSV-Import (deutsches Excel-Format)', () => {
  assert.deepEqual(parseCsv('a;b\n"x;y";"he said ""hi"""\n'), [['a', 'b'], ['x;y', 'he said "hi"']]);
  const r = importProductsCsv(
    '﻿EAN;Bezeichnung;VK-Preis;MwSt;Pfand;FSK\r\n4006381333931;Stift;1,49;19%;;\r\n4006381333932;Kaputt;1;19;;\r\n4029764001807;Wasser;0,89;7;0,25;\r\n4008167102427;Bier;1,29;19;0,08;18\r\n',
  );
  assert.equal(r.products.length, 3);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /Prüfziffer/);
  assert.deepEqual(r.products[1], {
    code: '4029764001807',
    name: 'Wasser',
    price_cents: 89,
    vat_rate: 7,
    deposit_cents: 25,
    min_age: 0,
    active: true,
  });
  assert.equal(r.products[2].min_age, 18);
  const comma = importProductsCsv('ean,name,price,vat\n4006381333931,Pen,1.49,19\n');
  assert.equal(comma.products[0].price_cents, 149);
  const bad = importProductsCsv('foo;bar\n1;2\n');
  assert.equal(bad.products.length, 0);
});

test('Exit-Token signieren und prüfen', () => {
  const signer = createExitSigner(generateExitKeyPem());
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    o: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    s: 'a1b2c3d4-0000-4000-8000-000000000001',
    n: newNonce(),
    e: now + 60,
    c: ['age', 'audit'],
  };
  const token = signer.sign(payload);
  assert.ok(token.length < 160, `Token zu lang: ${token.length}`);
  const ok = signer.verify(token);
  assert.ok(ok.ok);
  assert.deepEqual(ok.payload, payload);
  assert.deepEqual(signer.verify(token, now + 120), { ok: false, reason: 'expired' });
  // Manipulierte Payload (andere Bestellung) → Signatur ungültig
  const [p, , sig] = token.split('.');
  const forged = encodePayload({ ...payload, o: '3f2504e0-4f89-11d3-9a0c-0305e82c3302' }).toString('base64url');
  assert.deepEqual(signer.verify(`${p}.${forged}.${sig}`), { ok: false, reason: 'signature' });
  assert.deepEqual(signer.verify('kaputt'), { ok: false, reason: 'format' });
  const other = createExitSigner(generateExitKeyPem());
  assert.equal(other.verify(token).ok, false);
  assert.equal(Buffer.from(signer.publicKeyRawBase64, 'base64').length, 32);
  assert.deepEqual(decodePayload(encodePayload({ ...payload, c: [] }))?.c, []);
});

test('Passwörter und Slugs', async () => {
  const h = await hashPassword('geheim-geheim');
  assert.ok(await verifyPassword('geheim-geheim', h));
  assert.ok(!(await verifyPassword('falsch', h)));
  assert.equal(slugify('Hofladen Müller & Söhne'), 'hofladen-mueller-soehne');
  assert.equal(slugify('!!!'), 'laden');
});
