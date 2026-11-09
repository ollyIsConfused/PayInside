import type { Config } from './config.js';
import type { Db } from './db.js';
import type { PaymentProvider } from './providers/payments.js';
import type { FiscalProvider } from './providers/fiscal.js';
import type { ExitSigner } from './lib/exitToken.js';
import type { WeightBarcodeFormat } from './lib/barcode.js';
import type { VatLine, VatRate } from './lib/money.js';
import type { FiscalRecord } from './providers/fiscal.js';

export interface AppContext {
  config: Config;
  db: Db;
  payments: PaymentProvider;
  fiscal: FiscalProvider;
  signer: ExitSigner;
  /** Zufallsquelle für Stichproben – in Tests austauschbar */
  random: () => number;
}

export interface StoreRow {
  id: string;
  merchant_id: string;
  slug: string;
  name: string;
  address: string;
  tax_number: string;
  status: 'setup' | 'active' | 'paused';
  payment_account_id: string | null;
  charges_enabled: boolean;
  fee_bps: number;
  fee_fixed_cents: number;
  audit_rate: number;
  gate_key_hash: string | null;
  weight_barcode_format: WeightBarcodeFormat;
  fiscal_status: 'none' | 'active' | 'error';
  fiscal_tss_id: string | null;
  fiscal_client_id: string | null;
  fiscal_admin_pin: string | null;
  fiscal_error: string | null;
  catalog_version: number;
  receipt_counter: number;
  created_at: Date;
}

export interface ProductRow {
  store_id: string;
  code: string;
  name: string;
  price_cents: number;
  vat_rate: VatRate;
  deposit_cents: number;
  min_age: 0 | 16 | 18;
  active: boolean;
  updated_at: Date;
}

export interface OrderItem {
  code: string;
  name: string;
  qty: number;
  unit_cents: number;
  deposit_cents: number; // Pfand pro Stück
  vat_rate: VatRate;
  min_age: number;
  line_cents: number; // (unit + deposit) * qty
  weighed?: boolean;
}

export interface OrderRow {
  id: string;
  store_id: string;
  session_id: string | null;
  receipt_number: number | null;
  status: 'pending_payment' | 'paid' | 'canceled' | 'refunded';
  items: OrderItem[];
  total_cents: number;
  deposit_cents: number;
  vat_breakdown: VatLine[];
  fee_cents: number;
  payment_provider: string;
  payment_ref: string | null;
  checks: string[];
  exit_status: 'none' | 'issued' | 'used';
  exit_nonce: string | null;
  exit_used_at: Date | null;
  exit_checked_by: string | null;
  exit_checked_at: Date | null;
  fiscal: FiscalRecord | null;
  paid_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
