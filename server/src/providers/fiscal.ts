import { randomUUID, createHmac, randomInt } from 'node:crypto';
import type { VatLine } from '../lib/money.js';

// TSE-Anbindung (KassenSichV). Jeder Verkauf muss in Deutschland von einer zertifizierten
// technischen Sicherheitseinrichtung signiert werden. Wir nutzen eine Cloud-TSE (fiskaly SIGN DE).
//
// WICHTIG: Die fiskaly-Implementierung folgt der öffentlichen SIGN-DE-v2-Dokumentation, wurde aber
// noch NICHT gegen die echte API getestet. Vor dem Livegang in der fiskaly-Testumgebung prüfen!

export interface FiscalRecord {
  provider: 'none' | 'mock' | 'fiskaly';
  ok: boolean;
  simulated?: boolean;
  tss_serial?: string;
  client_serial?: string;
  tx_number?: number;
  time_start?: string;
  time_end?: string;
  signature_counter?: number;
  signature?: string;
  signature_algorithm?: string;
  time_format?: string;
  qr_code_data?: string;
  error?: string;
}

export interface FiscalStoreRef {
  id: string;
  fiscal_tss_id: string | null;
  fiscal_client_id: string | null;
  fiscal_admin_pin: string | null;
}

export interface FiscalOrderRef {
  id: string;
  total_cents: number;
  vat_breakdown: VatLine[];
}

export interface FiscalProvider {
  readonly name: 'mock' | 'fiskaly' | 'disabled';
  provision(storeId: string): Promise<{ tssId: string; clientId: string; adminPin: string }>;
  record(store: FiscalStoreRef, order: FiscalOrderRef): Promise<FiscalRecord>;
}

const VAT_MAP: Record<number, string> = { 19: 'NORMAL', 7: 'REDUCED_1', 0: 'NULL' };
const euro = (cents: number) => (cents / 100).toFixed(2);

/** Simulierte TSE für Entwicklung und Demo. Bons tragen den Hinweis "SIMULIERT". */
export class MockFiscal implements FiscalProvider {
  readonly name = 'mock' as const;
  private counter = 1000;
  async provision() {
    return { tssId: `mock-tss-${randomUUID()}`, clientId: `mock-client-${randomUUID()}`, adminPin: '000000' };
  }
  async record(store: FiscalStoreRef, order: FiscalOrderRef): Promise<FiscalRecord> {
    const now = new Date().toISOString();
    this.counter += randomInt(1, 3);
    return {
      provider: 'mock',
      ok: true,
      simulated: true,
      tss_serial: 'SIMULIERT-' + (store.fiscal_tss_id ?? '').slice(-8),
      client_serial: `payinside-${store.id.slice(0, 8)}`,
      tx_number: this.counter,
      time_start: now,
      time_end: now,
      signature_counter: this.counter * 2,
      signature: createHmac('sha256', 'mock').update(order.id).digest('base64'),
      signature_algorithm: 'SIMULIERT',
      time_format: 'utcTime',
    };
  }
}

/** Produktion ohne TSE-Zugangsdaten: Einrichtung schlägt mit klarer Meldung fehl, statt still zu simulieren. */
export class DisabledFiscal implements FiscalProvider {
  readonly name = 'disabled' as const;
  async provision(): Promise<never> {
    throw new Error('TSE ist auf der Plattform noch nicht konfiguriert (FISKALY_API_KEY/SECRET fehlen). Bitte Support kontaktieren.');
  }
  async record(): Promise<FiscalRecord> {
    return { provider: 'none', ok: false, error: 'TSE nicht eingerichtet' };
  }
}

export class FiskalyFiscal implements FiscalProvider {
  readonly name = 'fiskaly' as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private apiKey: string, private apiSecret: string, private baseUrl: string) {}

  private async auth(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.raw('POST', '/auth', { api_key: this.apiKey, api_secret: this.apiSecret }, false);
    const expiresIn = Number(res.access_token_expires_in ?? 300);
    this.token = { value: res.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return this.token.value;
  }

  private async raw(method: string, path: string, body?: unknown, withAuth = true): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (withAuth) headers.authorization = `Bearer ${await this.auth()}`;
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`fiskaly ${method} ${path} → ${res.status}: ${json.message ?? text}`);
    return json;
  }

  async provision(storeId: string) {
    const tssId = randomUUID();
    const clientId = randomUUID();
    const adminPin = String(randomInt(100000, 999999)) + String(randomInt(100000, 999999));
    const created = await this.raw('PUT', `/tss/${tssId}`, { metadata: { store_id: storeId } });
    await this.raw('PATCH', `/tss/${tssId}`, { state: 'UNINITIALIZED' });
    await this.raw('PATCH', `/tss/${tssId}/admin`, { admin_puk: created.admin_puk, new_admin_pin: adminPin });
    await this.raw('POST', `/tss/${tssId}/admin/auth`, { admin_pin: adminPin });
    await this.raw('PATCH', `/tss/${tssId}`, { state: 'INITIALIZED' });
    await this.raw('PUT', `/tss/${tssId}/client/${clientId}`, { serial_number: `payinside-${storeId}` });
    await this.raw('POST', `/tss/${tssId}/admin/logout`, {}).catch(() => {});
    return { tssId, clientId, adminPin };
  }

  async record(store: FiscalStoreRef, order: FiscalOrderRef): Promise<FiscalRecord> {
    if (!store.fiscal_tss_id || !store.fiscal_client_id) {
      return { provider: 'fiskaly', ok: false, error: 'TSE nicht eingerichtet' };
    }
    const base = `/tss/${store.fiscal_tss_id}/tx/${order.id}`;
    try {
      await this.raw('PUT', `${base}?tx_revision=1`, { state: 'ACTIVE', client_id: store.fiscal_client_id });
      const tx = await this.raw('PUT', `${base}?tx_revision=2`, {
        state: 'FINISHED',
        client_id: store.fiscal_client_id,
        schema: {
          standard_v1: {
            receipt: {
              receipt_type: 'RECEIPT',
              amounts_per_vat_rate: order.vat_breakdown.map((v) => ({
                vat_rate: VAT_MAP[v.rate] ?? 'NORMAL',
                amount: euro(v.gross_cents),
              })),
              amounts_per_payment_type: [{ payment_type: 'NON_CASH', amount: euro(order.total_cents) }],
            },
          },
        },
      });
      const ts = (s: number | undefined) => (s ? new Date(s * 1000).toISOString() : undefined);
      return {
        provider: 'fiskaly',
        ok: true,
        tss_serial: tx.tss_serial_number,
        client_serial: tx.client_serial_number,
        tx_number: tx.number,
        time_start: ts(tx.time_start),
        time_end: ts(tx.time_end),
        signature_counter: tx.signature?.counter,
        signature: tx.signature?.value,
        signature_algorithm: tx.signature?.algorithm,
        time_format: tx.log?.timestamp_format,
        qr_code_data: tx.qr_code_data,
      };
    } catch (err) {
      // Bei TSE-Ausfall darf verkauft werden; auf dem Bon muss "TSE ausgefallen" stehen.
      return { provider: 'fiskaly', ok: false, error: (err as Error).message };
    }
  }
}
