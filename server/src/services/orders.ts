import type { PoolClient } from 'pg';
import { normalizeCode, parseWeightBarcode, pluCode } from '../lib/barcode.js';
import { vatBreakdown, platformFee } from '../lib/money.js';
import { newNonce, type ExitPayload } from '../lib/exitToken.js';
import { HttpError, type AppContext, type OrderItem, type OrderRow, type ProductRow, type StoreRow } from '../context.js';

export interface CartInput {
  code: string;
  qty: number;
}

export interface ResolvedProduct {
  code: string; // so wie gescannt (normalisiert) – bei Waagenartikeln der Etikett-Code
  name: string;
  unit_cents: number;
  deposit_cents: number;
  vat_rate: 0 | 7 | 19;
  min_age: number;
  weighed: boolean;
}

function fromProduct(p: ProductRow, code = p.code): ResolvedProduct {
  return {
    code,
    name: p.name,
    unit_cents: p.price_cents,
    deposit_cents: p.deposit_cents,
    vat_rate: p.vat_rate,
    min_age: p.min_age,
    weighed: false,
  };
}

/** Löst eine Liste gescannter Codes in Produkte auf (inkl. Waagen-Etiketten). */
export async function resolveCodes(
  ctx: AppContext,
  store: StoreRow,
  rawCodes: string[],
): Promise<Map<string, ResolvedProduct>> {
  const codes = [...new Set(rawCodes.map(normalizeCode))];
  const weights = new Map<string, { plu: string; priceCents: number }>();
  const lookup = new Set<string>();
  for (const c of codes) {
    lookup.add(c);
    const w = parseWeightBarcode(c, store.weight_barcode_format);
    if (w) {
      weights.set(c, w);
      lookup.add(pluCode(w.plu));
    }
  }
  const { rows } = await ctx.db.query<ProductRow>(
    'SELECT * FROM products WHERE store_id = $1 AND active AND code = ANY($2::text[])',
    [store.id, [...lookup]],
  );
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const result = new Map<string, ResolvedProduct>();
  for (const c of codes) {
    const direct = byCode.get(c);
    if (direct) {
      result.set(c, fromProduct(direct, c));
      continue;
    }
    const w = weights.get(c);
    const plu = w && byCode.get(pluCode(w.plu));
    if (w && plu) {
      result.set(c, { ...fromProduct(plu, c), unit_cents: w.priceCents, deposit_cents: 0, weighed: true });
    }
  }
  return result;
}

export interface PricedCart {
  items: OrderItem[];
  unknown: string[];
  total_cents: number;
  deposit_cents: number;
  vat_breakdown: ReturnType<typeof vatBreakdown>;
}

/** Berechnet den Warenkorb ausschließlich mit Preisen aus der Datenbank – Preise vom Handy werden ignoriert. */
export async function priceCart(ctx: AppContext, store: StoreRow, input: CartInput[]): Promise<PricedCart> {
  const merged = new Map<string, number>();
  for (const i of input) {
    const code = normalizeCode(String(i.code ?? ''));
    const qty = Math.trunc(Number(i.qty));
    if (!code) continue;
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
      throw new HttpError(422, 'invalid_quantity', `Ungültige Menge für ${code}`);
    }
    merged.set(code, (merged.get(code) ?? 0) + qty);
  }
  if (merged.size > 200) throw new HttpError(422, 'cart_too_large', 'Zu viele verschiedene Artikel');

  const resolved = await resolveCodes(ctx, store, [...merged.keys()]);
  const items: OrderItem[] = [];
  const unknown: string[] = [];
  for (const [code, qty] of merged) {
    const p = resolved.get(code);
    if (!p) {
      unknown.push(code);
      continue;
    }
    items.push({
      code,
      name: p.name,
      qty,
      unit_cents: p.unit_cents,
      deposit_cents: p.deposit_cents,
      vat_rate: p.vat_rate,
      min_age: p.min_age,
      line_cents: (p.unit_cents + p.deposit_cents) * qty,
      ...(p.weighed ? { weighed: true } : {}),
    });
  }
  const total = items.reduce((s, i) => s + i.line_cents, 0);
  const deposit = items.reduce((s, i) => s + i.deposit_cents * i.qty, 0);
  return {
    items,
    unknown,
    total_cents: total,
    deposit_cents: deposit,
    vat_breakdown: vatBreakdown(items.map((i) => ({ gross_cents: i.line_cents, vat_rate: i.vat_rate }))),
  };
}

export async function loadStore(ctx: AppContext, idOrSlug: string): Promise<StoreRow | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  return ctx.db.one<StoreRow>(`SELECT * FROM stores WHERE ${isUuid ? 'id = $1::uuid' : 'slug = $1'}`, [idOrSlug]);
}

/** Erstellt eine Bestellung und eine Zahlung beim Zahlungsanbieter. */
export async function createCheckout(
  ctx: AppContext,
  sessionId: string,
  storeId: string,
  cart: CartInput[],
): Promise<{ order: OrderRow; payment: Record<string, unknown> }> {
  const store = await loadStore(ctx, storeId);
  if (!store) throw new HttpError(404, 'store_not_found', 'Markt nicht gefunden');
  if (store.status !== 'active') throw new HttpError(409, 'store_inactive', 'Dieser Markt nimmt gerade keine App-Zahlungen an');
  if (!store.charges_enabled || !store.payment_account_id) {
    throw new HttpError(409, 'payments_not_ready', 'Zahlungen sind für diesen Markt noch nicht freigeschaltet');
  }
  const priced = await priceCart(ctx, store, cart);
  if (priced.unknown.length) {
    throw new HttpError(422, 'unknown_products', 'Einige Artikel sind unbekannt', { unknown: priced.unknown });
  }
  if (priced.items.length === 0 || priced.total_cents <= 0) {
    throw new HttpError(422, 'empty_cart', 'Der Warenkorb ist leer');
  }
  if (priced.total_cents < 50) {
    throw new HttpError(422, 'amount_too_small', 'Mindestbetrag für Kartenzahlung: 0,50 €');
  }
  const fee = platformFee(priced.total_cents, store.fee_bps, store.fee_fixed_cents);

  const order = (await ctx.db.one<OrderRow>(
    `INSERT INTO orders (store_id, session_id, items, total_cents, deposit_cents, vat_breakdown, fee_cents, payment_provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      store.id,
      sessionId,
      JSON.stringify(priced.items),
      priced.total_cents,
      priced.deposit_cents,
      JSON.stringify(priced.vat_breakdown),
      fee,
      ctx.payments.name,
    ],
  ))!;

  try {
    const payment = await ctx.payments.createPayment({
      orderId: order.id,
      storeId: store.id,
      storeName: store.name,
      amountCents: order.total_cents,
      feeCents: fee,
      accountId: store.payment_account_id,
    });
    await ctx.db.query('UPDATE orders SET payment_ref = $2 WHERE id = $1', [order.id, payment.ref]);
    order.payment_ref = payment.ref;
    return { order, payment: payment.client };
  } catch (err) {
    await ctx.db.query(`UPDATE orders SET status = 'canceled' WHERE id = $1`, [order.id]);
    throw err;
  }
}

/**
 * Wird aufgerufen, sobald der Zahlungsanbieter die Zahlung bestätigt (Webhook oder Testmodus).
 * Idempotent: mehrfacher Aufruf ändert nichts mehr.
 */
export async function finalizePaidOrder(ctx: AppContext, paymentRef: string): Promise<OrderRow | null> {
  const paid = await ctx.db.tx(async (c: PoolClient) => {
    const order = (await c.query<OrderRow>('SELECT * FROM orders WHERE payment_ref = $1 FOR UPDATE', [paymentRef])).rows[0];
    if (!order) return null;
    if (order.status !== 'pending_payment') return { order, fresh: false };
    const store = (
      await c.query<StoreRow>(
        'UPDATE stores SET receipt_counter = receipt_counter + 1 WHERE id = $1 RETURNING *',
        [order.store_id],
      )
    ).rows[0];
    const checks: string[] = [];
    if (order.items.some((i) => i.min_age > 0)) checks.push('age');
    if (ctx.random() < Number(store.audit_rate)) checks.push('audit');
    const updated = (
      await c.query<OrderRow>(
        `UPDATE orders SET status = 'paid', paid_at = now(), receipt_number = $2, checks = $3,
                exit_status = 'issued', exit_nonce = $4
         WHERE id = $1 RETURNING *`,
        [order.id, store.receipt_counter, checks, newNonce()],
      )
    ).rows[0];
    return { order: updated, fresh: true, store };
  });
  if (!paid) return null;
  if (!paid.fresh || !paid.store) return paid.order;

  // TSE-Signatur nach dem Commit (Netzwerkaufruf soll keine DB-Sperre halten)
  const store = paid.store;
  const fiscal =
    store.fiscal_status === 'active'
      ? await ctx.fiscal.record(store, paid.order)
      : { provider: 'none' as const, ok: false, error: 'TSE nicht eingerichtet' };
  const final = await ctx.db.one<OrderRow>('UPDATE orders SET fiscal = $2 WHERE id = $1 RETURNING *', [
    paid.order.id,
    JSON.stringify(fiscal),
  ]);
  return final;
}

export function exitTokenFor(ctx: AppContext, order: OrderRow): string | null {
  if (order.status !== 'paid' || order.exit_status !== 'issued' || !order.exit_nonce) return null;
  const payload: ExitPayload = {
    o: order.id,
    s: order.store_id,
    n: order.exit_nonce,
    e: Math.floor(Date.now() / 1000) + ctx.config.exitTokenTtlSeconds,
    c: order.checks,
  };
  return ctx.signer.sign(payload);
}

export type GateResult = {
  result: 'open' | 'check' | 'deny';
  reason: string;
  message: string;
  order?: Pick<OrderRow, 'id' | 'receipt_number' | 'items' | 'total_cents' | 'checks' | 'paid_at' | 'exit_status'>;
};

const DENY_MESSAGES: Record<string, string> = {
  format: 'Kein gültiger Pay-Inside-Code',
  signature: 'Code ist ungültig oder manipuliert',
  expired: 'Code abgelaufen – bitte in der App neu laden',
  wrong_store: 'Dieser Code gehört zu einem anderen Markt',
  not_found: 'Einkauf nicht gefunden',
  not_paid: 'Einkauf ist nicht bezahlt',
  refunded: 'Einkauf wurde erstattet',
  nonce: 'Code ist nicht mehr gültig',
  used: 'Code wurde bereits benutzt',
};

/**
 * Prüft einen Exit-Code.
 * - Schranke ('gate'): öffnet nur, wenn keine Kontrolle nötig ist (oder sie schon erledigt wurde). Markiert den Code als benutzt.
 * - Personal ('staff', action 'inspect'): zeigt den Einkauf an, ohne etwas zu ändern.
 * - Personal ('staff', action 'clear'): bestätigt Ausweis-/Stichprobenkontrolle. Hat der Laden keine Schranke,
 *   gilt der Code danach als benutzt; sonst öffnet die Schranke beim nächsten Scan.
 */
export async function verifyExit(
  ctx: AppContext,
  storeId: string,
  token: string,
  source: 'gate' | 'staff',
  action: 'pass' | 'inspect' | 'clear' = 'pass',
  staffName = '',
): Promise<GateResult> {
  const v = ctx.signer.verify(token);
  const finish = async (r: GateResult): Promise<GateResult> => {
    if (action !== 'inspect') {
      await ctx.db.query(
        'INSERT INTO gate_events (store_id, order_id, source, result, reason) VALUES ($1, $2, $3, $4, $5)',
        [storeId, r.order?.id ?? null, source, r.result, r.reason],
      );
    }
    return r;
  };
  const deny = (reason: string, order?: OrderRow) =>
    finish({ result: 'deny', reason, message: DENY_MESSAGES[reason] ?? reason, order: order && summary(order) });

  if (!v.ok) return deny(v.reason);
  if (v.payload.s !== storeId) return deny('wrong_store');

  return ctx.db
    .tx(async (c) => {
      const order = (await c.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [v.payload.o])).rows[0];
      if (!order || order.store_id !== storeId) return { result: 'deny', reason: 'not_found' } as const;
      if (order.status === 'refunded') return { result: 'deny', reason: 'refunded', order } as const;
      if (order.status !== 'paid') return { result: 'deny', reason: 'not_paid', order } as const;
      if (order.exit_nonce !== v.payload.n) return { result: 'deny', reason: 'nonce', order } as const;
      if (order.exit_status === 'used') return { result: 'deny', reason: 'used', order } as const;

      const needsCheck = order.checks.length > 0 && !order.exit_checked_at;
      if (action === 'inspect') {
        return { result: needsCheck ? 'check' : 'open', reason: needsCheck ? order.checks.join(',') : 'ok', order, dry: true } as const;
      }
      if (source === 'gate' && needsCheck) {
        return { result: 'check', reason: order.checks.join(','), order } as const;
      }
      if (source === 'staff' && action === 'clear') {
        const store = (await c.query<StoreRow>('SELECT gate_key_hash FROM stores WHERE id = $1', [storeId])).rows[0];
        const hasGate = !!store?.gate_key_hash;
        const upd = (
          await c.query<OrderRow>(
            `UPDATE orders SET exit_checked_by = $2, exit_checked_at = now()
               ${hasGate ? '' : ", exit_status = 'used', exit_used_at = now()"}
             WHERE id = $1 RETURNING *`,
            [order.id, staffName || 'Personal'],
          )
        ).rows[0];
        return { result: 'open', reason: 'cleared', order: upd } as const;
      }
      const upd = (
        await c.query<OrderRow>(
          `UPDATE orders SET exit_status = 'used', exit_used_at = now() WHERE id = $1 RETURNING *`,
          [order.id],
        )
      ).rows[0];
      return { result: 'open', reason: 'ok', order: upd } as const;
    })
    .then((r) => {
      if (r.result === 'deny') return deny(r.reason, r.order);
      const dry = 'dry' in r;
      const message =
        r.result === 'open'
          ? r.reason === 'cleared'
            ? 'Kontrolle bestätigt – Kunde darf gehen'
            : dry
              ? 'Bezahlt – mit „Freigeben“ abschließen'
              : 'Gute Fahrt! Schranke offen'
          : checkMessage(r.order.checks);
      const res: GateResult = { result: r.result, reason: r.reason, message, order: summary(r.order) };
      return dry ? res : finish(res);
    });
}

function checkMessage(checks: string[]): string {
  const parts: string[] = [];
  if (checks.includes('age')) parts.push('Altersprüfung (Ausweis)');
  if (checks.includes('audit')) parts.push('Stichprobe');
  return `Bitte kurz warten – ${parts.join(' und ')} durch Personal`;
}

function summary(o: OrderRow): NonNullable<GateResult['order']> {
  return {
    id: o.id,
    receipt_number: o.receipt_number,
    items: o.items,
    total_cents: o.total_cents,
    checks: o.checks,
    paid_at: o.paid_at,
    exit_status: o.exit_status,
  };
}

/** Öffentliche Sicht auf eine Bestellung (für die Kunden-App) inkl. digitalem Bon. */
export function publicOrder(ctx: AppContext, order: OrderRow, store: StoreRow) {
  return {
    id: order.id,
    status: order.status,
    store: { slug: store.slug, name: store.name, address: store.address, tax_number: store.tax_number },
    receipt_number: order.receipt_number,
    items: order.items,
    total_cents: order.total_cents,
    deposit_cents: order.deposit_cents,
    vat_breakdown: order.vat_breakdown,
    checks: order.checks,
    exit_status: order.exit_status,
    exit_token: exitTokenFor(ctx, order),
    exit_token_ttl_seconds: ctx.config.exitTokenTtlSeconds,
    fiscal: order.fiscal,
    paid_at: order.paid_at,
    created_at: order.created_at,
    refunded_at: order.refunded_at,
  };
}
