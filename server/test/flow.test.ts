import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup, createActiveStore, startSession } from './helpers.js';
import { gs1CheckDigit } from '../src/lib/barcode.js';

let env: Awaited<ReturnType<typeof setup>>;
let cookie: string;
let storeId: string;
let rnd = 0.99;

before(async () => {
  env = await setup({ random: () => rnd });
  cookie = await signup(env.app);
  storeId = await createActiveStore(env.app, cookie);
});
after(async () => env.close());

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function buyAndPay(token: string, items: { code: string; qty: number }[]) {
  const co = await env.app.inject({ method: 'POST', url: '/v1/checkout', headers: bearer(token), payload: { items } });
  assert.equal(co.statusCode, 201, co.body);
  const { order_id } = co.json();
  const paid = await env.app.inject({ method: 'POST', url: `/v1/orders/${order_id}/mock-pay`, headers: bearer(token) });
  assert.equal(paid.statusCode, 200, paid.body);
  return paid.json();
}

async function gateKey() {
  const res = await env.app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/gate-key`, headers: { cookie } });
  return decodeURIComponent(String(res.headers.location).split('gate_key=')[1]);
}

test('Öffentliche Markt-Infos und Katalog mit ETag', async () => {
  const info = await env.app.inject({ url: '/v1/stores/hofladen-sonnenberg' });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().accepting_payments, true);
  const cat = await env.app.inject({ url: '/v1/stores/hofladen-sonnenberg/catalog' });
  assert.equal(cat.json().products.length, 5);
  const again = await env.app.inject({ url: '/v1/stores/hofladen-sonnenberg/catalog', headers: { 'if-none-match': String(cat.headers.etag) } });
  assert.equal(again.statusCode, 304);
});

test('Kompletter Einkauf: scannen → bezahlen → Bon → Schranke', async () => {
  const token = await startSession(env.app);
  // Waagen-Etikett: Äpfel PLU 00123 für 2,17 €
  const w = '2100123' + '0' + '0217';
  const weightCode = w + gs1CheckDigit(w);
  const lookup = await env.app.inject({ url: `/v1/stores/hofladen-sonnenberg/products/${weightCode}` });
  assert.equal(lookup.json().unit_cents, 217);
  assert.equal(lookup.json().weighed, true);

  const order = await buyAndPay(token, [
    { code: '4006381333931', qty: 2 },
    { code: '4029764001807', qty: 1 },
    { code: weightCode, qty: 1 },
    { code: '4006381333931', qty: 1 }, // wird zusammengefasst
  ]);
  // 3 × 1,49 + 0,89 + 0,25 Pfand + 2,17 = 7,78
  assert.equal(order.status, 'paid');
  assert.equal(order.total_cents, 778);
  assert.equal(order.deposit_cents, 25);
  assert.equal(order.receipt_number, 1);
  assert.deepEqual(order.checks, []);
  assert.ok(order.fiscal.ok);
  assert.ok(order.exit_token.startsWith('PI1.'));
  const vat19 = order.vat_breakdown.find((v: any) => v.rate === 19);
  assert.equal(vat19.gross_cents, 447 + 89 + 25);

  const svg = await env.app.inject({ url: `/v1/orders/${order.id}/exit-qr.svg`, headers: bearer(token) });
  assert.match(svg.body, /<svg/);

  const key = await gateKey();
  const first = await env.app.inject({ method: 'POST', url: '/v1/gate/verify', headers: bearer(key), payload: { token: order.exit_token } });
  assert.equal(first.json().result, 'open', first.body);
  const second = await env.app.inject({ method: 'POST', url: '/v1/gate/verify', headers: bearer(key), payload: { token: order.exit_token } });
  assert.equal(second.json().result, 'deny');
  assert.equal(second.json().reason, 'used');

  const after = await env.app.inject({ url: `/v1/orders/${order.id}`, headers: bearer(token) });
  assert.equal(after.json().exit_status, 'used');
  assert.equal(after.json().exit_token, null);
});

test('Preise kommen immer vom Server, unbekannte Artikel werden abgelehnt', async () => {
  const token = await startSession(env.app);
  const res = await env.app.inject({
    method: 'POST',
    url: '/v1/checkout',
    headers: bearer(token),
    payload: { items: [{ code: '4006381333931', qty: 1, price_cents: 1 }, { code: '1234567890128', qty: 1 }] },
  });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'unknown_products');
  assert.deepEqual(res.json().details.unknown, ['1234567890128']);
});

test('Mindestbetrag, leerer Warenkorb und fehlende Session', async () => {
  const token = await startSession(env.app);
  const tooSmall = await env.app.inject({ method: 'POST', url: '/v1/checkout', headers: bearer(token), payload: { items: [] } });
  assert.equal(tooSmall.statusCode, 422);
  const noAuth = await env.app.inject({ method: 'POST', url: '/v1/checkout', payload: { items: [{ code: '4006381333931', qty: 1 }] } });
  assert.equal(noAuth.statusCode, 401);
  const foreign = await env.app.inject({ url: '/v1/orders/00000000-0000-0000-0000-000000000000', headers: bearer(token) });
  assert.equal(foreign.statusCode, 404);
});

test('Altersfreigabe: Schranke verlangt Personal, Freigabe öffnet', async () => {
  const token = await startSession(env.app);
  const order = await buyAndPay(token, [{ code: '4008167102427', qty: 2 }]);
  assert.deepEqual(order.checks, ['age']);
  const key = await gateKey();
  const gate = await env.app.inject({ method: 'POST', url: '/v1/gate/verify', headers: bearer(key), payload: { token: order.exit_token } });
  assert.equal(gate.json().result, 'check');

  const inspect = await env.app.inject({
    method: 'POST',
    url: '/v1/staff/verify',
    headers: { cookie },
    payload: { store_id: storeId, token: order.exit_token, action: 'inspect' },
  });
  assert.equal(inspect.json().result, 'check');
  const clear = await env.app.inject({
    method: 'POST',
    url: '/v1/staff/verify',
    headers: { cookie },
    payload: { store_id: storeId, token: order.exit_token, action: 'clear' },
  });
  assert.equal(clear.json().result, 'open');
  // Laden hat eine Schranke → jetzt öffnet sie beim erneuten Scan
  const gate2 = await env.app.inject({ method: 'POST', url: '/v1/gate/verify', headers: bearer(key), payload: { token: order.exit_token } });
  assert.equal(gate2.json().result, 'open');
});

test('Zufällige Stichprobe wird markiert', async () => {
  rnd = 0.001;
  const token = await startSession(env.app);
  const order = await buyAndPay(token, [{ code: '4000417025005', qty: 1 }]);
  rnd = 0.99;
  assert.deepEqual(order.checks, ['audit']);
});

test('Fremder Laden und manipulierte Codes werden abgelehnt', async () => {
  const otherCookie = await signup(env.app, 'andere@example.com');
  const res = await env.app.inject({ method: 'POST', url: '/dashboard/stores', headers: { cookie: otherCookie }, payload: { name: 'Anderer Laden' } });
  const otherId = String(res.headers.location).split('/')[3].split('?')[0];
  const keyRes = await env.app.inject({ method: 'POST', url: `/dashboard/stores/${otherId}/gate-key`, headers: { cookie: otherCookie } });
  const otherKey = decodeURIComponent(String(keyRes.headers.location).split('gate_key=')[1]);

  const token = await startSession(env.app);
  const order = await buyAndPay(token, [{ code: '4000417025005', qty: 1 }]);
  const wrong = await env.app.inject({ method: 'POST', url: '/v1/gate/verify', headers: bearer(otherKey), payload: { token: order.exit_token } });
  assert.equal(wrong.json().reason, 'wrong_store');

  const forged = order.exit_token.slice(0, -4) + 'AAAA';
  const key = await gateKey();
  const bad = await env.app.inject({ method: 'POST', url: '/v1/gate/verify', headers: bearer(key), payload: { token: forged } });
  assert.equal(bad.json().result, 'deny');

  // Fremder Händler sieht den Laden nicht
  const peek = await env.app.inject({ url: `/dashboard/stores/${storeId}`, headers: { cookie: otherCookie } });
  assert.equal(peek.statusCode, 404);
  const staff = await env.app.inject({
    method: 'POST',
    url: '/v1/staff/verify',
    headers: { cookie: otherCookie },
    payload: { store_id: storeId, token: order.exit_token, action: 'clear' },
  });
  assert.equal(staff.statusCode, 404);
});

test('Erstattung macht den Ausgangscode ungültig', async () => {
  const token = await startSession(env.app);
  const order = await buyAndPay(token, [{ code: '4000417025005', qty: 1 }]);
  const r = await env.app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/orders/${order.id}/refund`, headers: { cookie } });
  assert.match(String(r.headers.location), /ok=/);
  const key = await gateKey();
  const gate = await env.app.inject({ method: 'POST', url: '/v1/gate/verify', headers: bearer(key), payload: { token: order.exit_token } });
  assert.equal(gate.json().reason, 'refunded');
});

test('Pausierter Laden nimmt keine Zahlungen an', async () => {
  await env.app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/status`, headers: { cookie }, payload: { status: 'paused' } });
  const token = await startSession(env.app);
  const res = await env.app.inject({ method: 'POST', url: '/v1/checkout', headers: bearer(token), payload: { items: [{ code: '4000417025005', qty: 1 }] } });
  assert.equal(res.statusCode, 409);
  await env.app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/status`, headers: { cookie }, payload: { status: 'active' } });
});

test('Portal-Seiten rendern und sind geschützt', async () => {
  for (const url of ['/', '/signup', '/login', '/impressum', '/datenschutz', '/agb', '/s/hofladen-sonnenberg', '/shop/hofladen-sonnenberg', '/.well-known/apple-app-site-association']) {
    const r = await env.app.inject({ url });
    assert.equal(r.statusCode, 200, url);
  }
  for (const p of ['', '/products', '/orders', '/settings', '/poster']) {
    const r = await env.app.inject({ url: `/dashboard/stores/${storeId}${p}`, headers: { cookie } });
    assert.equal(r.statusCode, 200, p);
    assert.match(r.body, /Hofladen Sonnenberg/);
  }
  const csv = await env.app.inject({ url: `/dashboard/stores/${storeId}/products.csv`, headers: { cookie } });
  assert.match(csv.body, /Vollmilch/);
  const anon = await env.app.inject({ url: '/dashboard' });
  assert.equal(anon.statusCode, 303);
  assert.equal(anon.headers.location, '/login');
  // XSS: Namen werden escaped
  await env.app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/products`, headers: { cookie }, payload: { code: '96385074', name: '<script>x</script>', price: '1' } });
  const list = await env.app.inject({ url: `/dashboard/stores/${storeId}/products`, headers: { cookie } });
  assert.ok(!list.body.includes('<script>x</script>'));
  assert.ok(list.body.includes('&lt;script&gt;'));
});

test('Fremde Formular-POSTs (CSRF) werden abgelehnt', async () => {
  const r = await env.app.inject({
    method: 'POST',
    url: `/dashboard/stores/${storeId}/status`,
    headers: { cookie, origin: 'https://boese.example', host: 'localhost:3000' },
    payload: { status: 'paused' },
  });
  assert.equal(r.statusCode, 403);
});

test('Login mit falschem Passwort scheitert, richtiges klappt', async () => {
  const bad = await env.app.inject({ method: 'POST', url: '/login', payload: { email: 'laden@example.com', password: 'falsch' } });
  assert.equal(bad.statusCode, 401);
  const good = await env.app.inject({ method: 'POST', url: '/login', payload: { email: 'LADEN@example.com', password: 'sehr-geheim-123' } });
  assert.equal(good.statusCode, 303);
});
