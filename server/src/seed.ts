// Legt einen Demo-Händler mit fertig eingerichtetem Demo-Laden an – zum Ausprobieren auf dem eigenen Rechner.
//   npm run seed
// Login: demo@payinside.local / demo-passwort-123   ·   Laden: http://localhost:3000/s/demo-laden
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { hashPassword } from './lib/security.js';
import { importProductsCsv, CSV_TEMPLATE } from './lib/csv.js';
import { MockFiscal } from './providers/fiscal.js';

const config = loadConfig();
if (config.env === 'production') {
  console.error('Seed ist nur für Entwicklung gedacht.');
  process.exit(1);
}
const db = createDb(config.databaseUrl);
await migrate(db);

const email = 'demo@payinside.local';
let merchant = await db.one<{ id: string }>('SELECT id FROM merchants WHERE email = $1', [email]);
if (!merchant) {
  merchant = await db.one<{ id: string }>(
    `INSERT INTO merchants (email, password_hash, name, company, accepted_terms_at) VALUES ($1, $2, 'Demo Händler', 'Demo GmbH', now()) RETURNING id`,
    [email, await hashPassword('demo-passwort-123')],
  );
}

const fiscal = await new MockFiscal().provision();
const store = await db.one<{ id: string }>(
  `INSERT INTO stores (merchant_id, slug, name, address, tax_number, status, payment_account_id, charges_enabled,
     fee_bps, fee_fixed_cents, audit_rate, fiscal_status, fiscal_tss_id, fiscal_client_id, fiscal_admin_pin)
   VALUES ($1, 'demo-laden', 'Demo-Laden', 'Musterstraße 1, 12345 Musterstadt', '12/345/67890', 'active', 'acct_mock_demo', true,
     $2, $3, 0.05, 'active', $4, $5, $6)
   ON CONFLICT (slug) DO UPDATE SET status = 'active' RETURNING id`,
  [merchant!.id, config.platformFeeBps, config.platformFeeFixedCents, fiscal.tssId, fiscal.clientId, fiscal.adminPin],
);

const { products } = importProductsCsv(CSV_TEMPLATE);
for (const p of products) {
  await db.query(
    `INSERT INTO products (store_id, code, name, price_cents, vat_rate, deposit_cents, min_age)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (store_id, code) DO NOTHING`,
    [store!.id, p.code, p.name, p.price_cents, p.vat_rate, p.deposit_cents, p.min_age],
  );
}
await db.close();
console.log(`Demo bereit:
  Händler-Portal: ${config.publicUrl}/login   (${email} / demo-passwort-123)
  Kunden-Einstieg: ${config.publicUrl}/s/demo-laden
  Test-Barcodes:   ${products.filter((p) => !p.code.startsWith('PLU')).map((p) => p.code).join(', ')}`);
