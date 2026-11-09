import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { HttpError, type AppContext, type OrderRow, type ProductRow, type StoreRow } from '../context.js';
import { hashToken, randomToken } from '../lib/security.js';
import { normalizeCode } from '../lib/barcode.js';
import {
  createCheckout,
  finalizePaidOrder,
  loadStore,
  priceCart,
  publicOrder,
  resolveCodes,
  verifyExit,
} from '../services/orders.js';

// JSON-API für die iOS-App, die Web-App und die Schranke.

interface SessionRow {
  id: string;
  store_id: string;
  expires_at: Date;
}

const cartSchema = z.object({
  items: z
    .array(z.object({ code: z.string().min(1).max(64), qty: z.number().int().min(1).max(99) }))
    .max(500),
});

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

export function storeInfo(ctx: AppContext, store: StoreRow) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    address: store.address,
    status: store.status,
    accepting_payments: store.status === 'active' && store.charges_enabled,
    catalog_version: store.catalog_version,
    weight_barcode_format: store.weight_barcode_format,
    payment: {
      provider: ctx.payments.name,
      publishable_key: ctx.payments.name === 'stripe' ? ctx.config.stripe.publishableKey : null,
      apple_pay_merchant_id: ctx.config.apple.merchantId,
      country: 'DE',
      currency: 'EUR',
    },
    entry_url: `${ctx.config.publicUrl}/s/${store.slug}`,
  };
}

export async function apiRoutes(app: FastifyInstance, ctx: AppContext) {
  async function requireSession(req: FastifyRequest, opts: { allowExpired?: boolean } = {}): Promise<SessionRow> {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'unauthorized', 'Einkaufs-Session fehlt – bitte QR-Code am Eingang scannen');
    const s = await ctx.db.one<SessionRow>('SELECT id, store_id, expires_at FROM shopping_sessions WHERE token_hash = $1', [
      hashToken(token),
    ]);
    if (!s) throw new HttpError(401, 'unauthorized', 'Einkaufs-Session unbekannt');
    if (!opts.allowExpired && new Date(s.expires_at) < new Date()) {
      throw new HttpError(401, 'session_expired', 'Einkaufs-Session abgelaufen – bitte QR-Code erneut scannen');
    }
    return s;
  }

  async function requireOwnOrder(req: FastifyRequest, id: string): Promise<{ order: OrderRow; store: StoreRow }> {
    const s = await requireSession(req, { allowExpired: true });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'Einkauf nicht gefunden');
    const order = await ctx.db.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND session_id = $2', [id, s.id]);
    if (!order) throw new HttpError(404, 'not_found', 'Einkauf nicht gefunden');
    const store = (await loadStore(ctx, order.store_id))!;
    return { order, store };
  }

  async function requireStore(slug: string): Promise<StoreRow> {
    const store = await loadStore(ctx, slug);
    if (!store) throw new HttpError(404, 'store_not_found', 'Markt nicht gefunden');
    return store;
  }

  app.get('/healthz', async () => {
    await ctx.db.query('SELECT 1');
    return { ok: true, payments: ctx.payments.name, fiscal: ctx.fiscal.name };
  });

  app.get<{ Params: { slug: string } }>('/v1/stores/:slug', async (req) => {
    return storeInfo(ctx, await requireStore(req.params.slug));
  });

  // Kompletter Katalog zum Zwischenspeichern in der App (funktioniert dann auch bei schlechtem Netz im Laden)
  app.get<{ Params: { slug: string } }>('/v1/stores/:slug/catalog', async (req, reply) => {
    const store = await requireStore(req.params.slug);
    const etag = `"c${store.id.slice(0, 8)}-${store.catalog_version}"`;
    reply.header('etag', etag).header('cache-control', 'private, max-age=60');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    const { rows } = await ctx.db.query<ProductRow>(
      'SELECT code, name, price_cents, vat_rate, deposit_cents, min_age FROM products WHERE store_id = $1 AND active ORDER BY name',
      [store.id],
    );
    return { version: store.catalog_version, weight_barcode_format: store.weight_barcode_format, products: rows };
  });

  app.get<{ Params: { slug: string; code: string } }>('/v1/stores/:slug/products/:code', async (req) => {
    const store = await requireStore(req.params.slug);
    const code = normalizeCode(req.params.code);
    const p = (await resolveCodes(ctx, store, [code])).get(code);
    if (!p) throw new HttpError(404, 'unknown_product', 'Artikel nicht gefunden – bitte an der Info melden');
    return p;
  });

  app.post('/v1/sessions', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ store: z.string().min(1).max(64), client: z.string().max(40).optional() }).parse(req.body);
    const store = await requireStore(body.store);
    const token = randomToken();
    const expires = new Date(Date.now() + ctx.config.shoppingSessionTtlHours * 3600_000);
    await ctx.db.query(
      'INSERT INTO shopping_sessions (store_id, token_hash, client, expires_at) VALUES ($1, $2, $3, $4)',
      [store.id, hashToken(token), body.client ?? 'unknown', expires],
    );
    reply.code(201);
    return { session_token: token, expires_at: expires.toISOString(), store: storeInfo(ctx, store) };
  });

  // Vorschau des Warenkorbs (Server rechnet) – optional, die App kann auch lokal mit dem Katalog rechnen
  app.post('/v1/cart/price', async (req) => {
    const s = await requireSession(req);
    const { items } = cartSchema.parse(req.body);
    const store = (await loadStore(ctx, s.store_id))!;
    return priceCart(ctx, store, items);
  });

  app.post('/v1/checkout', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = await requireSession(req);
    const { items } = cartSchema.parse(req.body);
    const { order, payment } = await createCheckout(ctx, s.id, s.store_id, items);
    reply.code(201);
    return {
      order_id: order.id,
      total_cents: order.total_cents,
      deposit_cents: order.deposit_cents,
      items: order.items,
      vat_breakdown: order.vat_breakdown,
      payment,
    };
  });

  app.get<{ Params: { id: string } }>('/v1/orders/:id', async (req) => {
    const { order, store } = await requireOwnOrder(req, req.params.id);
    return publicOrder(ctx, order, store);
  });

  app.get<{ Params: { id: string } }>('/v1/orders/:id/exit-qr.svg', async (req, reply) => {
    const { order, store } = await requireOwnOrder(req, req.params.id);
    const token = publicOrder(ctx, order, store).exit_token;
    if (!token) throw new HttpError(409, 'no_exit_token', 'Für diesen Einkauf gibt es keinen gültigen Ausgangscode');
    const svg = await QRCode.toString(token, { type: 'svg', errorCorrectionLevel: 'L', margin: 2 });
    reply.header('content-type', 'image/svg+xml').header('cache-control', 'no-store');
    return svg;
  });

  app.post<{ Params: { id: string } }>('/v1/orders/:id/cancel', async (req) => {
    const { order, store } = await requireOwnOrder(req, req.params.id);
    if (order.status === 'pending_payment') {
      if (order.payment_ref) await ctx.payments.cancelPayment(order.payment_ref);
      await ctx.db.query(`UPDATE orders SET status = 'canceled' WHERE id = $1 AND status = 'pending_payment'`, [order.id]);
      order.status = 'canceled';
    }
    return publicOrder(ctx, order, store);
  });

  // Nur im Testmodus: Zahlung simulieren
  app.post<{ Params: { id: string } }>('/v1/orders/:id/mock-pay', async (req) => {
    if (ctx.payments.name !== 'mock') throw new HttpError(404, 'not_found', 'Nicht verfügbar');
    const { order } = await requireOwnOrder(req, req.params.id);
    if (!order.payment_ref) throw new HttpError(409, 'no_payment', 'Keine Zahlung offen');
    const paid = await finalizePaidOrder(ctx, order.payment_ref);
    const store = (await loadStore(ctx, order.store_id))!;
    return publicOrder(ctx, paid!, store);
  });

  // --- Schranke / Ausgang ---
  async function requireGate(req: FastifyRequest): Promise<StoreRow> {
    const key = bearer(req);
    if (!key) throw new HttpError(401, 'unauthorized', 'Schranken-Schlüssel fehlt');
    const store = await ctx.db.one<StoreRow>('SELECT * FROM stores WHERE gate_key_hash = $1', [hashToken(key)]);
    if (!store) throw new HttpError(401, 'unauthorized', 'Schranken-Schlüssel ungültig');
    return store;
  }

  app.get('/v1/gate/config', async (req) => {
    const store = await requireGate(req);
    return {
      store_id: store.id,
      store_name: store.name,
      public_key_pem: ctx.signer.publicKeyPem,
      public_key_raw: ctx.signer.publicKeyRawBase64,
    };
  });

  app.post('/v1/gate/verify', async (req) => {
    const store = await requireGate(req);
    const { token } = z.object({ token: z.string().min(10).max(2000) }).parse(req.body);
    return verifyExit(ctx, store.id, token, 'gate');
  });

  app.get('/v1/keys/exit', async () => ({
    alg: 'Ed25519',
    format: 'PI1.<base64url(47 Byte: v1|order uuid|store uuid|nonce 9B|exp u32be|flags)>.<base64url(Ed25519-Signatur über "PI1.<payload>")>',
    public_key_pem: ctx.signer.publicKeyPem,
    public_key_raw: ctx.signer.publicKeyRawBase64,
  }));

  // --- Webhooks des Zahlungsanbieters (roher Body für Signaturprüfung) ---
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/stripe', async (req, reply) => {
      const sig = String(req.headers['stripe-signature'] ?? '');
      let event;
      try {
        event = ctx.payments.verifyWebhook(req.body as Buffer, sig);
      } catch (err) {
        req.log.warn({ err }, 'Webhook abgelehnt');
        return reply.code(400).send({ error: 'bad_signature' });
      }
      const fresh = await ctx.db.query('INSERT INTO webhook_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        event.id,
        event.kind,
      ]);
      if (fresh.rowCount === 0) return { received: true, duplicate: true };
      try {
        switch (event.kind) {
          case 'payment_succeeded':
            await finalizePaidOrder(ctx, event.ref);
            break;
          case 'payment_failed':
            await ctx.db.query(`UPDATE orders SET status = 'canceled' WHERE payment_ref = $1 AND status = 'pending_payment'`, [
              event.ref,
            ]);
            break;
          case 'refunded':
            await ctx.db.query(
              `UPDATE orders SET status = 'refunded', refunded_at = coalesce(refunded_at, now()) WHERE payment_ref = $1`,
              [event.ref],
            );
            break;
          case 'account_updated':
            await ctx.db.query('UPDATE stores SET charges_enabled = $2 WHERE payment_account_id = $1', [
              event.accountId,
              event.chargesEnabled,
            ]);
            break;
        }
      } catch (err) {
        // Event wieder freigeben, damit Stripe es erneut zustellt
        await ctx.db.query('DELETE FROM webhook_events WHERE id = $1', [event.id]);
        throw err;
      }
      return { received: true };
    });
  });
}
