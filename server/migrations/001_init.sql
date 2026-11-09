-- Pay Inside – Grundschema

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Plattform-Geheimnisse (z. B. Signaturschlüssel für Exit-Codes), werden beim ersten Start erzeugt
CREATE TABLE platform_secrets (
  name text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Händler-Konten (Ladenbetreiber)
CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  company text NOT NULL DEFAULT '',
  accepted_terms_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_sessions (
  token_hash text PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchant_sessions_merchant_idx ON merchant_sessions(merchant_id);

-- Läden / Märkte
CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  tax_number text NOT NULL DEFAULT '',       -- Steuernummer oder USt-IdNr. (für Bon)
  status text NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'paused')),
  -- Zahlungen (Stripe Connect)
  payment_account_id text,
  charges_enabled boolean NOT NULL DEFAULT false,
  fee_bps integer NOT NULL,
  fee_fixed_cents integer NOT NULL,
  -- Kontrolle am Ausgang
  audit_rate numeric(5,4) NOT NULL DEFAULT 0.03 CHECK (audit_rate >= 0 AND audit_rate <= 1),
  gate_key_hash text,
  -- Gewichts-/Preis-Etiketten von der Waage (EAN-13, Präfix 2x)
  weight_barcode_format text NOT NULL DEFAULT 'price4_check'
    CHECK (weight_barcode_format IN ('none', 'price4_check', 'price5')),
  -- TSE (KassenSichV)
  fiscal_status text NOT NULL DEFAULT 'none' CHECK (fiscal_status IN ('none', 'active', 'error')),
  fiscal_tss_id text,
  fiscal_client_id text,
  fiscal_admin_pin text,
  fiscal_error text,
  -- Katalog-Version für Caching in den Apps
  catalog_version bigint NOT NULL DEFAULT 1,
  receipt_counter bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stores_merchant_idx ON stores(merchant_id);

-- Produkte je Laden. code = EAN/GTIN (normalisiert auf 8 oder 13 Stellen) oder 'PLU:12345' für Waagenartikel
CREATE TABLE products (
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  vat_rate smallint NOT NULL CHECK (vat_rate IN (0, 7, 19)),
  deposit_cents integer NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  min_age smallint NOT NULL DEFAULT 0 CHECK (min_age IN (0, 16, 18)),
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, code)
);

-- Einkaufs-Sessions (anonym; entsteht beim Scannen des Eingangs-QR-Codes)
CREATE TABLE shopping_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  client text NOT NULL DEFAULT 'unknown',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  session_id uuid REFERENCES shopping_sessions(id) ON DELETE SET NULL,
  receipt_number bigint,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'canceled', 'refunded')),
  items jsonb NOT NULL,
  total_cents integer NOT NULL,
  deposit_cents integer NOT NULL DEFAULT 0,
  vat_breakdown jsonb NOT NULL,
  fee_cents integer NOT NULL DEFAULT 0,
  payment_provider text NOT NULL,
  payment_ref text UNIQUE,
  checks text[] NOT NULL DEFAULT '{}',           -- 'age', 'audit'
  exit_status text NOT NULL DEFAULT 'none' CHECK (exit_status IN ('none', 'issued', 'used')),
  exit_nonce text,
  exit_used_at timestamptz,
  exit_checked_by text,
  exit_checked_at timestamptz,
  fiscal jsonb,
  paid_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_store_created_idx ON orders(store_id, created_at DESC);
CREATE UNIQUE INDEX orders_store_receipt_idx ON orders(store_id, receipt_number) WHERE receipt_number IS NOT NULL;

-- Protokoll der Schranke / Kontrollen
CREATE TABLE gate_events (
  id bigserial PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  source text NOT NULL,           -- 'gate' | 'staff'
  result text NOT NULL,           -- 'open' | 'check' | 'deny'
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_events_store_idx ON gate_events(store_id, created_at DESC);

-- Idempotenz für Webhooks
CREATE TABLE webhook_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
