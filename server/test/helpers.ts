import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createDb } from '../src/db.js';
import { MockPayments } from '../src/providers/payments.js';
import { MockFiscal } from '../src/providers/fiscal.js';

export const TEST_DB = process.env.DATABASE_URL_TEST ?? 'postgres://payinside:payinside@localhost:5432/payinside_test';

export async function setup(opts: { random?: () => number } = {}) {
  const db = createDb(TEST_DB);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const config = loadConfig({ env: 'test', databaseUrl: TEST_DB, publicUrl: 'http://localhost:3000', allowMockPayments: true });
  const { app, ctx } = await buildApp({
    config,
    db,
    payments: new MockPayments(),
    fiscal: new MockFiscal(),
    random: opts.random ?? (() => 0.99), // standardmäßig keine Stichprobe
    logger: false,
  });
  await app.ready();
  return {
    app,
    ctx,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

type App = Awaited<ReturnType<typeof setup>>['app'];

/** Registriert einen Händler und gibt das Session-Cookie zurück. */
export async function signup(app: App, email = 'laden@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/signup',
    payload: { name: 'Erika Muster', company: 'Hofladen', email, password: 'sehr-geheim-123', terms: '1' },
  });
  const cookie = res.cookies.find((c) => c.name === 'pi_sid');
  if (!cookie) throw new Error(`Signup fehlgeschlagen: ${res.statusCode} ${res.body.slice(0, 200)}`);
  return `pi_sid=${cookie.value}`;
}

export async function createActiveStore(app: App, cookie: string, csv?: string) {
  let res = await app.inject({
    method: 'POST',
    url: '/dashboard/stores',
    headers: { cookie },
    payload: { name: 'Hofladen Sonnenberg', address: 'Hauptstr. 1, 12345 Musterstadt', tax_number: '12/345/67890' },
  });
  const storeId = res.headers.location!.toString().split('/')[3].split('?')[0];
  await app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/payments/connect`, headers: { cookie } });
  await app.inject({ method: 'GET', url: `/dashboard/stores/${storeId}/payments/return`, headers: { cookie } });
  await app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/fiscal/setup`, headers: { cookie } });
  res = await app.inject({
    method: 'POST',
    url: `/dashboard/stores/${storeId}/products/import`,
    headers: { cookie },
    payload: {
      csv:
        csv ??
        'EAN;PLU;Name;Preis;MwSt;Pfand;Alter\n' +
          '4006381333931;;Kugelschreiber;1,49;19;;\n' +
          '4000417025005;;Vollmilch 1L;1,19;7;;\n' +
          '4029764001807;;Wasser 0,5L;0,89;19;0,25;\n' +
          '4008167102427;;Bier 0,5L;1,29;19;0,08;16\n' +
          ';00123;Äpfel lose;2,99;7;;\n',
    },
  });
  res = await app.inject({ method: 'POST', url: `/dashboard/stores/${storeId}/status`, headers: { cookie }, payload: { status: 'active' } });
  const loc = String(res.headers.location);
  if (!loc.includes('ok=')) throw new Error(`Aktivieren fehlgeschlagen: ${decodeURIComponent(loc)}`);
  return storeId;
}

export async function startSession(app: App, slug = 'hofladen-sonnenberg') {
  const res = await app.inject({ method: 'POST', url: '/v1/sessions', payload: { store: slug, client: 'test' } });
  return res.json().session_token as string;
}
