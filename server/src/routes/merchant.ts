import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { HttpError, type AppContext, type OrderRow, type ProductRow, type StoreRow } from '../context.js';
import { html, raw, layout, euro, dateTime, type SafeHtml } from '../lib/html.js';
import { hashPassword, hashToken, randomToken, slugify, verifyPassword } from '../lib/security.js';
import { CSV_TEMPLATE, importProductsCsv, type ImportedProduct } from '../lib/csv.js';
import { isValidGtin, normalizeCode } from '../lib/barcode.js';
import { parsePriceToCents } from '../lib/money.js';
import { loadStore, verifyExit } from '../services/orders.js';

// Händler-Portal: Registrierung, Läden, Produkte, Zahlungen, TSE, Bestellungen, QR-Poster, Personal-Kontrolle.

const COOKIE = 'pi_sid';
const SESSION_DAYS = 30;

interface Merchant {
  id: string;
  email: string;
  name: string;
  company: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    merchant?: Merchant | null;
  }
}

function nav(m: Merchant | null | undefined, store?: StoreRow): SafeHtml {
  return html`<header class="topbar">
  <a class="brand" href="${m ? '/dashboard' : '/'}"><img src="/static/icon.svg" alt="" width="28" height="28"> Pay Inside</a>
  <nav>
    ${m
      ? html`${store ? html`<a href="/dashboard/stores/${store.id}">${store.name}</a>` : ''}
          <a href="/dashboard">Meine Läden</a>
          <form method="post" action="/logout" class="inline"><button class="link">Abmelden</button></form>`
      : html`<a href="/login">Anmelden</a> <a class="btn small" href="/signup">Kostenlos starten</a>`}
  </nav>
</header>`;
}

function page(req: FastifyRequest, title: string, body: SafeHtml, store?: StoreRow): string {
  return layout({ title: `${title} · Pay Inside`, nav: nav(req.merchant, store), body: html`<main class="container">${body}</main>` });
}

function flash(req: FastifyRequest): SafeHtml {
  const q = req.query as Record<string, string | undefined>;
  return html`${q.ok ? html`<div class="flash ok">${q.ok}</div>` : ''}${q.err ? html`<div class="flash err">${q.err}</div>` : ''}`;
}

function redirect(reply: FastifyReply, path: string, msg?: { ok?: string; err?: string }) {
  const u = new URL(path, 'http://x');
  if (msg?.ok) u.searchParams.set('ok', msg.ok);
  if (msg?.err) u.searchParams.set('err', msg.err);
  return reply.redirect(u.pathname + u.search, 303);
}

function storeTabs(store: StoreRow, active: string): SafeHtml {
  const tabs = [
    ['', 'Übersicht'],
    ['/products', 'Produkte'],
    ['/orders', 'Einkäufe'],
    ['/poster', 'QR-Poster'],
    ['/settings', 'Einstellungen'],
  ];
  return html`<nav class="tabs">${tabs.map(
    ([p, label]) => html`<a class="${active === p ? 'active' : ''}" href="/dashboard/stores/${store.id}${p}">${label}</a>`,
  )}<a href="/staff/${store.id}" target="_blank">Kontrolle ↗</a></nav>`;
}

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'offen',
  paid: 'bezahlt',
  canceled: 'abgebrochen',
  refunded: 'erstattet',
};

export async function merchantRoutes(app: FastifyInstance, ctx: AppContext) {
  const secure = ctx.config.publicUrl.startsWith('https://');

  // --- Session laden ---
  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[COOKIE];
    req.merchant = null;
    if (!token) return;
    req.merchant = await ctx.db.one<Merchant>(
      `SELECT m.id, m.email, m.name, m.company FROM merchant_sessions s JOIN merchants m ON m.id = s.merchant_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)],
    );
  });

  async function startSession(reply: FastifyReply, merchantId: string) {
    const token = randomToken();
    await ctx.db.query(
      `INSERT INTO merchant_sessions (token_hash, merchant_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [hashToken(token), merchantId],
    );
    reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: SESSION_DAYS * 86400,
    });
  }

  function requireMerchant(req: FastifyRequest): Merchant {
    if (!req.merchant) throw new HttpError(401, 'login_required', 'Bitte anmelden');
    return req.merchant;
  }

  async function ownStore(req: FastifyRequest, id: string): Promise<StoreRow> {
    const m = requireMerchant(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'Laden nicht gefunden');
    const store = await ctx.db.one<StoreRow>('SELECT * FROM stores WHERE id = $1 AND merchant_id = $2', [id, m.id]);
    if (!store) throw new HttpError(404, 'not_found', 'Laden nicht gefunden');
    return store;
  }

  async function bumpCatalog(storeId: string) {
    await ctx.db.query('UPDATE stores SET catalog_version = catalog_version + 1 WHERE id = $1', [storeId]);
  }

  async function upsertProducts(storeId: string, products: ImportedProduct[]) {
    if (products.length === 0) return;
    const col = <K extends keyof ImportedProduct>(k: K) => products.map((p) => p[k]);
    await ctx.db.query(
      `INSERT INTO products (store_id, code, name, price_cents, vat_rate, deposit_cents, min_age, active, updated_at)
       SELECT $1::uuid, * , now() FROM unnest($2::text[], $3::text[], $4::int[], $5::smallint[], $6::int[], $7::smallint[], $8::bool[])
       ON CONFLICT (store_id, code) DO UPDATE SET name = excluded.name, price_cents = excluded.price_cents,
         vat_rate = excluded.vat_rate, deposit_cents = excluded.deposit_cents, min_age = excluded.min_age,
         active = excluded.active, updated_at = now()`,
      [
        storeId,
        col('code'),
        col('name'),
        col('price_cents'),
        col('vat_rate'),
        col('deposit_cents'),
        col('min_age'),
        col('active'),
      ],
    );
    await bumpCatalog(storeId);
  }

  // ---------- Registrierung / Login ----------
  const authForm = (req: FastifyRequest, mode: 'signup' | 'login', error?: string, values: Record<string, string> = {}) =>
    page(
      req,
      mode === 'signup' ? 'Registrieren' : 'Anmelden',
      html`<section class="auth card">
        <h1>${mode === 'signup' ? 'Laden kostenlos anmelden' : 'Anmelden'}</h1>
        ${mode === 'signup' ? html`<p class="muted">Keine Grundgebühr. Du zahlst nur pro Einkauf über Pay Inside.</p>` : ''}
        ${error ? html`<div class="flash err">${error}</div>` : ''}
        <form method="post" action="/${mode}">
          ${mode === 'signup'
            ? html`<label>Dein Name<input name="name" required maxlength="100" value="${values.name ?? ''}" autocomplete="name"></label>
                <label>Firma / Laden (optional)<input name="company" maxlength="120" value="${values.company ?? ''}" autocomplete="organization"></label>`
            : ''}
          <label>E-Mail<input name="email" type="email" required value="${values.email ?? ''}" autocomplete="email"></label>
          <label>Passwort<input name="password" type="password" required minlength="${mode === 'signup' ? 10 : 1}" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>
          ${mode === 'signup'
            ? html`<label class="check"><input type="checkbox" name="terms" value="1" required> Ich akzeptiere die <a href="/agb" target="_blank">AGB</a> und habe die <a href="/datenschutz" target="_blank">Datenschutzerklärung</a> gelesen.</label>`
            : ''}
          <button class="btn primary wide">${mode === 'signup' ? 'Konto erstellen' : 'Anmelden'}</button>
        </form>
        <p class="muted center">${mode === 'signup' ? html`Schon registriert? <a href="/login">Anmelden</a>` : html`Neu hier? <a href="/signup">Konto erstellen</a>`}</p>
      </section>`,
    );

  app.get('/signup', async (req, reply) => {
    if (req.merchant) return reply.redirect('/dashboard', 303);
    reply.type('text/html').send(authForm(req, 'signup'));
  });

  app.post('/signup', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const values = { name: b.name ?? '', company: b.company ?? '', email: b.email ?? '' };
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(100),
        company: z.string().trim().max(120).default(''),
        email: z.string().trim().toLowerCase().email().max(200),
        password: z.string().min(10).max(200),
        terms: z.literal('1'),
      })
      .safeParse(b);
    if (!parsed.success) {
      return reply
        .code(422)
        .type('text/html')
        .send(authForm(req, 'signup', 'Bitte alle Felder ausfüllen (Passwort mind. 10 Zeichen) und AGB akzeptieren.', values));
    }
    const d = parsed.data;
    const exists = await ctx.db.one('SELECT 1 FROM merchants WHERE email = $1', [d.email]);
    if (exists) return reply.code(409).type('text/html').send(authForm(req, 'signup', 'Diese E-Mail ist schon registriert.', values));
    const m = await ctx.db.one<{ id: string }>(
      'INSERT INTO merchants (email, password_hash, name, company, accepted_terms_at) VALUES ($1, $2, $3, $4, now()) RETURNING id',
      [d.email, await hashPassword(d.password), d.name, d.company],
    );
    await startSession(reply, m!.id);
    return redirect(reply, '/dashboard', { ok: 'Willkommen bei Pay Inside! Lege jetzt deinen ersten Laden an.' });
  });

  app.get('/login', async (req, reply) => {
    if (req.merchant) return reply.redirect('/dashboard', 303);
    reply.type('text/html').send(authForm(req, 'login'));
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const email = String(b.email ?? '').trim().toLowerCase();
    const m = await ctx.db.one<{ id: string; password_hash: string }>('SELECT id, password_hash FROM merchants WHERE email = $1', [
      email,
    ]);
    if (!m || !(await verifyPassword(String(b.password ?? ''), m.password_hash))) {
      return reply.code(401).type('text/html').send(authForm(req, 'login', 'E-Mail oder Passwort falsch.', { email }));
    }
    await startSession(reply, m.id);
    return reply.redirect('/dashboard', 303);
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) await ctx.db.query('DELETE FROM merchant_sessions WHERE token_hash = $1', [hashToken(token)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect('/', 303);
  });

  // ---------- Dashboard ----------
  app.get('/dashboard', async (req, reply) => {
    const m = requireMerchant(req);
    const { rows: stores } = await ctx.db.query<StoreRow & { products: number; revenue_30d: number }>(
      `SELECT s.*,
         (SELECT count(*) FROM products p WHERE p.store_id = s.id AND p.active)::int AS products,
         (SELECT coalesce(sum(total_cents), 0) FROM orders o WHERE o.store_id = s.id AND o.status = 'paid'
            AND o.paid_at > now() - interval '30 days')::int AS revenue_30d
       FROM stores s WHERE s.merchant_id = $1 ORDER BY s.created_at`,
      [m.id],
    );
    reply.type('text/html').send(
      page(
        req,
        'Meine Läden',
        html`${flash(req)}
        <h1>Hallo ${m.name.split(' ')[0]} 👋</h1>
        ${stores.length
          ? html`<div class="grid">${stores.map(
              (s) => html`<a class="card store-card" href="/dashboard/stores/${s.id}">
                <h2>${s.name}</h2>
                <p class="muted">${s.address || 'Keine Adresse'}</p>
                <p><span class="badge ${s.status}">${s.status === 'active' ? 'Aktiv' : s.status === 'paused' ? 'Pausiert' : 'Einrichtung'}</span></p>
                <p>${s.products} Produkte · ${euro(s.revenue_30d)} Umsatz (30 Tage)</p>
              </a>`,
            )}</div>`
          : html`<p class="lead">Du hast noch keinen Laden. In 10 Minuten bist du startklar:</p>`}
        <section class="card">
          <h2>Neuen Laden anlegen</h2>
          <form method="post" action="/dashboard/stores" class="form-grid">
            <label>Name des Ladens<input name="name" required maxlength="80" placeholder="z. B. Hofladen Sonnenberg"></label>
            <label>Adresse (steht auf dem Bon)<input name="address" maxlength="200" placeholder="Hauptstraße 1, 12345 Musterstadt"></label>
            <label>Steuernummer oder USt-IdNr. (steht auf dem Bon)<input name="tax_number" maxlength="40"></label>
            <div><button class="btn primary">Laden anlegen</button></div>
          </form>
        </section>`,
      ),
    );
  });

  app.post('/dashboard/stores', async (req, reply) => {
    const m = requireMerchant(req);
    const b = z
      .object({
        name: z.string().trim().min(2).max(80),
        address: z.string().trim().max(200).default(''),
        tax_number: z.string().trim().max(40).default(''),
      })
      .safeParse(req.body);
    if (!b.success) return redirect(reply, '/dashboard', { err: 'Bitte einen Namen (mind. 2 Zeichen) angeben.' });
    const base = slugify(b.data.name);
    let slug = base;
    for (let i = 2; await ctx.db.one('SELECT 1 FROM stores WHERE slug = $1', [slug]); i++) slug = `${base}-${i}`;
    const store = await ctx.db.one<{ id: string }>(
      `INSERT INTO stores (merchant_id, slug, name, address, tax_number, fee_bps, fee_fixed_cents, audit_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [m.id, slug, b.data.name, b.data.address, b.data.tax_number, ctx.config.platformFeeBps, ctx.config.platformFeeFixedCents, ctx.config.defaultAuditRate],
    );
    return redirect(reply, `/dashboard/stores/${store!.id}`, { ok: 'Laden angelegt. Arbeite jetzt die Checkliste ab.' });
  });

  // ---------- Laden-Übersicht ----------
  app.get<{ Params: { id: string } }>('/dashboard/stores/:id', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const stats = (await ctx.db.one<{ today_n: number; today_sum: number; m_n: number; m_sum: number; m_fee: number; products: number }>(
      `SELECT
        count(*) FILTER (WHERE paid_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin')::int AS today_n,
        coalesce(sum(total_cents) FILTER (WHERE paid_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'), 0)::int AS today_sum,
        count(*) FILTER (WHERE paid_at > now() - interval '30 days')::int AS m_n,
        coalesce(sum(total_cents) FILTER (WHERE paid_at > now() - interval '30 days'), 0)::int AS m_sum,
        coalesce(sum(fee_cents) FILTER (WHERE paid_at > now() - interval '30 days'), 0)::int AS m_fee,
        (SELECT count(*) FROM products WHERE store_id = $1 AND active)::int AS products
       FROM orders WHERE store_id = $1 AND status = 'paid'`,
      [store.id],
    ))!;
    const { rows: recent } = await ctx.db.query<OrderRow>(
      `SELECT * FROM orders WHERE store_id = $1 AND status <> 'pending_payment' ORDER BY created_at DESC LIMIT 8`,
      [store.id],
    );
    const steps: [boolean, string, SafeHtml][] = [
      [
        store.charges_enabled,
        'Auszahlungskonto verbinden',
        html`<form method="post" action="/dashboard/stores/${store.id}/payments/connect" class="inline"><button class="btn small">${store.payment_account_id ? 'Einrichtung fortsetzen' : 'Jetzt verbinden'}</button></form>
             <span class="muted">Kundenzahlungen landen direkt auf deinem Konto (über Stripe).</span>`,
      ],
      [
        stats.products > 0,
        'Produkte importieren',
        html`<a class="btn small" href="/dashboard/stores/${store.id}/products">Produkte anlegen</a> <span class="muted">CSV aus deiner Warenwirtschaft oder Excel.</span>`,
      ],
      [
        store.fiscal_status === 'active',
        'TSE einrichten (Kassensicherungsverordnung)',
        html`<form method="post" action="/dashboard/stores/${store.id}/fiscal/setup" class="inline"><button class="btn small">TSE einrichten</button></form>
             ${store.fiscal_error ? html`<span class="err">${store.fiscal_error}</span>` : html`<span class="muted">Cloud-TSE, signiert jeden Bon automatisch.</span>`}`,
      ],
      [stats.m_n > 0 || recent.length > 0, 'QR-Poster am Eingang aufhängen', html`<a class="btn small" href="/dashboard/stores/${store.id}/poster">Poster drucken</a>`],
      [
        store.status === 'active',
        'Laden aktivieren',
        html`<form method="post" action="/dashboard/stores/${store.id}/status" class="inline">
          <input type="hidden" name="status" value="${store.status === 'active' ? 'paused' : 'active'}">
          <button class="btn small ${store.status === 'active' ? '' : 'primary'}">${store.status === 'active' ? 'Pausieren' : 'Aktivieren'}</button></form>`,
      ],
    ];
    reply.type('text/html').send(
      page(
        req,
        store.name,
        html`${flash(req)}
        <div class="page-head"><h1>${store.name}</h1><span class="badge ${store.status}">${store.status === 'active' ? 'Aktiv' : store.status === 'paused' ? 'Pausiert' : 'Einrichtung'}</span></div>
        ${storeTabs(store, '')}
        <div class="stats">
          <div class="stat"><span>Heute</span><strong>${euro(stats.today_sum)}</strong><small>${stats.today_n} Einkäufe</small></div>
          <div class="stat"><span>30 Tage</span><strong>${euro(stats.m_sum)}</strong><small>${stats.m_n} Einkäufe</small></div>
          <div class="stat"><span>Gebühren (30 Tage)</span><strong>${euro(stats.m_fee)}</strong><small>${(store.fee_bps / 100).toLocaleString('de-DE')} % + ${euro(store.fee_fixed_cents)}</small></div>
          <div class="stat"><span>Produkte</span><strong>${stats.products}</strong><small>aktiv</small></div>
        </div>
        <section class="card">
          <h2>Checkliste</h2>
          <ol class="checklist">${steps.map(
            ([done, label, action]) => html`<li class="${done ? 'done' : ''}"><span class="tick">${done ? '✓' : ''}</span><div><strong>${label}</strong><div class="actions">${action}</div></div></li>`,
          )}</ol>
          ${store.charges_enabled && ctx.payments.name === 'stripe'
            ? html`<p><a href="/dashboard/stores/${store.id}/payments/dashboard" target="_blank">Auszahlungen & Kontoauszüge bei Stripe ansehen ↗</a></p>`
            : ''}
          ${ctx.payments.name === 'mock' ? html`<p class="flash warn">Testmodus: Zahlungen werden nur simuliert (kein STRIPE_SECRET_KEY gesetzt).</p>` : ''}
        </section>
        <section class="card">
          <h2>Letzte Einkäufe</h2>
          ${recent.length ? ordersTable(store, recent) : html`<p class="muted">Noch keine Einkäufe.</p>`}
        </section>`,
        store,
      ),
    );
  });

  function ordersTable(store: StoreRow, orders: OrderRow[]): SafeHtml {
    return html`<table class="table"><thead><tr><th>Bon</th><th>Zeit</th><th>Artikel</th><th class="num">Betrag</th><th>Status</th><th>Ausgang</th></tr></thead><tbody>
      ${orders.map(
        (o) => html`<tr>
          <td><a href="/dashboard/stores/${store.id}/orders/${o.id}">${o.receipt_number ? `#${o.receipt_number}` : o.id.slice(0, 8)}</a></td>
          <td>${dateTime(o.paid_at ?? o.created_at)}</td>
          <td>${o.items.reduce((s, i) => s + i.qty, 0)}</td>
          <td class="num">${euro(o.total_cents)}</td>
          <td><span class="badge ${o.status}">${STATUS_LABEL[o.status]}</span></td>
          <td>${o.exit_status === 'used' ? '✓ raus' : o.status === 'paid' ? 'offen' : '–'} ${o.checks.includes('age') ? html`<span class="badge warn">Ausweis</span>` : ''}${o.checks.includes('audit') ? html`<span class="badge warn">Stichprobe</span>` : ''}</td>
        </tr>`,
      )}</tbody></table>`;
  }

  // ---------- Zahlungen (Stripe Connect) ----------
  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/payments/connect', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const m = requireMerchant(req);
    try {
      let accountId = store.payment_account_id;
      if (!accountId) {
        accountId = await ctx.payments.createAccount({ storeId: store.id, storeName: store.name, email: m.email });
        await ctx.db.query('UPDATE stores SET payment_account_id = $2 WHERE id = $1', [store.id, accountId]);
      }
      const base = `${ctx.config.publicUrl}/dashboard/stores/${store.id}/payments`;
      const url = await ctx.payments.onboardingLink(accountId, `${base}/return`, `${base}/refresh`);
      return reply.redirect(url, 303);
    } catch (err) {
      req.log.error({ err }, 'Connect-Onboarding fehlgeschlagen');
      return redirect(reply, `/dashboard/stores/${store.id}`, { err: `Verbindung fehlgeschlagen: ${(err as Error).message}` });
    }
  });

  const paymentsReturn = async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const store = await ownStore(req, req.params.id);
    if (!store.payment_account_id) return redirect(reply, `/dashboard/stores/${store.id}`);
    const st = await ctx.payments.accountStatus(store.payment_account_id);
    await ctx.db.query('UPDATE stores SET charges_enabled = $2 WHERE id = $1', [store.id, st.chargesEnabled]);
    return redirect(reply, `/dashboard/stores/${store.id}`, st.chargesEnabled
      ? { ok: 'Auszahlungskonto verbunden ✓' }
      : { err: 'Stripe prüft deine Angaben noch oder es fehlen Daten. Klicke auf "Einrichtung fortsetzen".' });
  };
  app.get('/dashboard/stores/:id/payments/return', paymentsReturn);
  app.get<{ Params: { id: string } }>('/dashboard/stores/:id/payments/refresh', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    if (!store.payment_account_id) return redirect(reply, `/dashboard/stores/${store.id}`);
    const base = `${ctx.config.publicUrl}/dashboard/stores/${store.id}/payments`;
    return reply.redirect(await ctx.payments.onboardingLink(store.payment_account_id, `${base}/return`, `${base}/refresh`), 303);
  });
  app.get<{ Params: { id: string } }>('/dashboard/stores/:id/payments/dashboard', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const url = store.payment_account_id ? await ctx.payments.dashboardLink(store.payment_account_id) : null;
    return url ? reply.redirect(url, 303) : redirect(reply, `/dashboard/stores/${store.id}`, { err: 'Kein Stripe-Dashboard verfügbar.' });
  });

  // ---------- TSE ----------
  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/fiscal/setup', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    if (store.fiscal_status === 'active') return redirect(reply, `/dashboard/stores/${store.id}`, { ok: 'TSE ist bereits aktiv.' });
    try {
      const r = await ctx.fiscal.provision(store.id);
      await ctx.db.query(
        `UPDATE stores SET fiscal_status = 'active', fiscal_tss_id = $2, fiscal_client_id = $3, fiscal_admin_pin = $4, fiscal_error = NULL WHERE id = $1`,
        [store.id, r.tssId, r.clientId, r.adminPin],
      );
      return redirect(reply, `/dashboard/stores/${store.id}`, {
        ok: ctx.fiscal.name === 'mock' ? 'TSE (simuliert) eingerichtet.' : 'TSE eingerichtet ✓ – denke an die Kassen-Meldung beim Finanzamt (siehe Hilfe).',
      });
    } catch (err) {
      await ctx.db.query(`UPDATE stores SET fiscal_status = 'error', fiscal_error = $2 WHERE id = $1`, [store.id, (err as Error).message.slice(0, 300)]);
      return redirect(reply, `/dashboard/stores/${store.id}`, { err: `TSE-Einrichtung fehlgeschlagen: ${(err as Error).message.slice(0, 160)}` });
    }
  });

  // ---------- Status ----------
  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/status', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const status = (req.body as any)?.status === 'active' ? 'active' : 'paused';
    if (status === 'active') {
      const count = (await ctx.db.one<{ n: number }>('SELECT count(*)::int AS n FROM products WHERE store_id = $1 AND active', [store.id]))!.n;
      const missing = [
        !store.charges_enabled && 'Auszahlungskonto',
        count === 0 && 'Produkte',
        store.fiscal_status !== 'active' && 'TSE',
      ].filter(Boolean);
      if (missing.length) return redirect(reply, `/dashboard/stores/${store.id}`, { err: `Zum Aktivieren fehlt noch: ${missing.join(', ')}` });
    }
    await ctx.db.query('UPDATE stores SET status = $2 WHERE id = $1', [store.id, status]);
    return redirect(reply, `/dashboard/stores/${store.id}`, { ok: status === 'active' ? 'Laden ist live! 🎉' : 'Laden pausiert.' });
  });

  // ---------- Produkte ----------
  app.get<{ Params: { id: string }; Querystring: { q?: string; page?: string } }>('/dashboard/stores/:id/products', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const q = (req.query.q ?? '').trim();
    const pageNo = Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1);
    const limit = 100;
    const { rows } = await ctx.db.query<ProductRow & { total: number }>(
      `SELECT *, count(*) OVER()::int AS total FROM products WHERE store_id = $1
         AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR code LIKE $2 || '%')
       ORDER BY name LIMIT $3 OFFSET $4`,
      [store.id, q, limit, (pageNo - 1) * limit],
    );
    const total = rows[0]?.total ?? 0;
    reply.type('text/html').send(
      page(
        req,
        `Produkte – ${store.name}`,
        html`${flash(req)}
        <div class="page-head"><h1>Produkte</h1></div>
        ${storeTabs(store, '/products')}
        <div class="grid two">
          <section class="card">
            <h2>CSV importieren</h2>
            <p class="muted">Spalten: <code>EAN; PLU; Name; Preis; MwSt; Pfand; Alter</code>. Excel: „Speichern unter → CSV (Trennzeichen-getrennt)“.
              <a href="/csv-vorlage.csv">Vorlage herunterladen</a></p>
            <form method="post" action="/dashboard/stores/${store.id}/products/import" enctype="multipart/form-data">
              <input type="file" name="file" accept=".csv,text/csv,text/plain" required>
              <label class="check"><input type="checkbox" name="replace" value="1"> Produkte, die nicht in der Datei stehen, löschen</label>
              <button class="btn primary">Importieren</button>
            </form>
          </section>
          <section class="card">
            <h2>Einzelnes Produkt</h2>
            <form method="post" action="/dashboard/stores/${store.id}/products" class="form-grid compact">
              <label>EAN / Barcode<input name="code" required inputmode="numeric" placeholder="4006381333931"></label>
              <label>oder Waagen-PLU<input name="plu" inputmode="numeric" placeholder="00123"></label>
              <label class="span2">Name<input name="name" required maxlength="200"></label>
              <label>Preis (€)<input name="price" required placeholder="1,99"></label>
              <label>MwSt<select name="vat_rate"><option value="19">19 %</option><option value="7">7 % (Lebensmittel)</option><option value="0">0 %</option></select></label>
              <label>Pfand (€)<input name="deposit" placeholder="0,25"></label>
              <label>Altersfreigabe<select name="min_age"><option value="0">keine</option><option value="16">ab 16</option><option value="18">ab 18</option></select></label>
              <div class="span2"><button class="btn">Speichern</button></div>
            </form>
          </section>
        </div>
        <section class="card">
          <div class="row-between">
            <h2>${total} Produkte</h2>
            <form method="get" class="inline search"><input name="q" value="${q}" placeholder="Suchen…"><button class="btn small">Suchen</button></form>
            <a class="btn small" href="/dashboard/stores/${store.id}/products.csv">Export CSV</a>
          </div>
          <table class="table"><thead><tr><th>Code</th><th>Name</th><th class="num">Preis</th><th>MwSt</th><th class="num">Pfand</th><th>Alter</th><th></th></tr></thead><tbody>
          ${rows.map(
            (p) => html`<tr class="${p.active ? '' : 'inactive'}"><td><code>${p.code}</code></td><td>${p.name}</td><td class="num">${euro(p.price_cents)}</td>
              <td>${p.vat_rate} %</td><td class="num">${p.deposit_cents ? euro(p.deposit_cents) : ''}</td><td>${p.min_age ? `${p.min_age}+` : ''}</td>
              <td><form method="post" action="/dashboard/stores/${store.id}/products/delete" class="inline" onsubmit="return confirm('Produkt löschen?')">
                <input type="hidden" name="code" value="${p.code}"><button class="link danger">löschen</button></form></td></tr>`,
          )}</tbody></table>
          ${total > limit
            ? html`<p class="pager">${pageNo > 1 ? html`<a href="?q=${encodeURIComponent(q)}&page=${pageNo - 1}">← zurück</a>` : ''}
                Seite ${pageNo} von ${Math.ceil(total / limit)}
                ${pageNo * limit < total ? html`<a href="?q=${encodeURIComponent(q)}&page=${pageNo + 1}">weiter →</a>` : ''}</p>`
            : ''}
        </section>`,
        store,
      ),
    );
  });

  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/products', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const b = (req.body ?? {}) as Record<string, string>;
    const back = `/dashboard/stores/${store.id}/products`;
    const plu = String(b.plu ?? '').replace(/\D/g, '');
    const code = plu ? `PLU:${plu.padStart(5, '0')}` : normalizeCode(String(b.code ?? ''));
    if (!code) return redirect(reply, back, { err: 'EAN oder PLU fehlt' });
    if (/^\d+$/.test(code) && !isValidGtin(code)) return redirect(reply, back, { err: `EAN ${code} ist ungültig (Prüfziffer)` });
    const price = parsePriceToCents(String(b.price ?? ''));
    const deposit = b.deposit ? parsePriceToCents(String(b.deposit)) : 0;
    const name = String(b.name ?? '').trim();
    if (!name || price === null || deposit === null) return redirect(reply, back, { err: 'Name, Preis oder Pfand ungültig' });
    const vat = Number(b.vat_rate);
    const age = Number(b.min_age);
    await upsertProducts(store.id, [
      {
        code,
        name: name.slice(0, 200),
        price_cents: price,
        vat_rate: ([0, 7, 19].includes(vat) ? vat : 19) as 0 | 7 | 19,
        deposit_cents: deposit,
        min_age: ([16, 18].includes(age) ? age : 0) as 0 | 16 | 18,
        active: true,
      },
    ]);
    return redirect(reply, back, { ok: `${name} gespeichert` });
  });

  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/products/delete', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    await ctx.db.query('DELETE FROM products WHERE store_id = $1 AND code = $2', [store.id, String((req.body as any)?.code ?? '')]);
    await bumpCatalog(store.id);
    return redirect(reply, `/dashboard/stores/${store.id}/products`, { ok: 'Produkt gelöscht' });
  });

  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/products/import', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const back = `/dashboard/stores/${store.id}/products`;
    let text = '';
    let replace = false;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          const buf = await part.toBuffer();
          text = decodeCsv(buf);
        } else if (part.fieldname === 'replace') replace = part.value === '1';
        else if (part.fieldname === 'csv' && !text) text = String(part.value ?? '');
      }
    } else {
      const b = (req.body ?? {}) as Record<string, string>;
      text = String(b.csv ?? '');
      replace = b.replace === '1';
    }
    const result = importProductsCsv(text);
    if (result.products.length === 0) {
      return redirect(reply, back, { err: result.errors.slice(0, 5).map((e) => `Zeile ${e.line}: ${e.message}`).join(' · ') || 'Keine Produkte gefunden' });
    }
    await ctx.db.tx(async (c) => {
      if (replace) {
        await c.query('DELETE FROM products WHERE store_id = $1 AND NOT (code = ANY($2::text[]))', [store.id, result.products.map((p) => p.code)]);
      }
    });
    // Import in Blöcken, damit auch große Kataloge (50.000+) schnell gehen
    for (let i = 0; i < result.products.length; i += 2000) await upsertProducts(store.id, result.products.slice(i, i + 2000));
    const warn = result.errors.length
      ? ` ${result.errors.length} Zeilen übersprungen: ${result.errors.slice(0, 3).map((e) => `Z.${e.line} ${e.message}`).join('; ')}`
      : '';
    return redirect(reply, back, { ok: `${result.products.length} Produkte importiert.${warn}` });
  });

  app.get<{ Params: { id: string } }>('/dashboard/stores/:id/products.csv', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const { rows } = await ctx.db.query<ProductRow>('SELECT * FROM products WHERE store_id = $1 ORDER BY name', [store.id]);
    const fmt = (c: number) => (c / 100).toFixed(2).replace('.', ',');
    const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = ['EAN;PLU;Name;Preis;MwSt;Pfand;Alter;Aktiv'].concat(
      rows.map((p) =>
        [
          p.code.startsWith('PLU:') ? '' : p.code,
          p.code.startsWith('PLU:') ? p.code.slice(4) : '',
          q(p.name),
          fmt(p.price_cents),
          p.vat_rate,
          p.deposit_cents ? fmt(p.deposit_cents) : '',
          p.min_age || '',
          p.active ? 'ja' : 'nein',
        ].join(';'),
      ),
    );
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="produkte-${store.slug}.csv"`)
      .send('﻿' + lines.join('\r\n') + '\r\n');
  });

  app.get('/csv-vorlage.csv', async (_req, reply) => {
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="payinside-produkte-vorlage.csv"')
      .send('﻿' + CSV_TEMPLATE);
  });

  // ---------- Einkäufe ----------
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>('/dashboard/stores/:id/orders', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const status = ['paid', 'refunded', 'canceled'].includes(req.query.status ?? '') ? req.query.status! : '';
    const { rows } = await ctx.db.query<OrderRow>(
      `SELECT * FROM orders WHERE store_id = $1 AND status <> 'pending_payment' AND ($2 = '' OR status = $2)
       ORDER BY created_at DESC LIMIT 200`,
      [store.id, status],
    );
    reply.type('text/html').send(
      page(
        req,
        `Einkäufe – ${store.name}`,
        html`${flash(req)}<div class="page-head"><h1>Einkäufe</h1></div>${storeTabs(store, '/orders')}
        <section class="card">
          <p class="filters">${[['', 'Alle'], ['paid', 'Bezahlt'], ['refunded', 'Erstattet'], ['canceled', 'Abgebrochen']].map(
            ([v, l]) => html`<a class="${status === v ? 'active' : ''}" href="?status=${v}">${l}</a>`,
          )}</p>
          ${rows.length ? ordersTable(store, rows) : html`<p class="muted">Keine Einkäufe.</p>`}
        </section>`,
        store,
      ),
    );
  });

  app.get<{ Params: { id: string; oid: string } }>('/dashboard/stores/:id/orders/:oid', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.oid)) throw new HttpError(404, 'not_found', 'Einkauf nicht gefunden');
    const o = await ctx.db.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [req.params.oid, store.id]);
    if (!o) throw new HttpError(404, 'not_found', 'Einkauf nicht gefunden');
    const { rows: events } = await ctx.db.query('SELECT * FROM gate_events WHERE order_id = $1 ORDER BY created_at', [o.id]);
    reply.type('text/html').send(
      page(
        req,
        `Bon ${o.receipt_number ?? ''}`,
        html`${flash(req)}<div class="page-head"><h1>Einkauf ${o.receipt_number ? `#${o.receipt_number}` : ''}</h1><span class="badge ${o.status}">${STATUS_LABEL[o.status]}</span></div>
        ${storeTabs(store, '/orders')}
        <div class="grid two">
          <section class="card receipt">${receiptHtml(store, o)}</section>
          <section class="card">
            <h2>Details</h2>
            <dl class="dl">
              <dt>Bezahlt</dt><dd>${dateTime(o.paid_at)}</dd>
              <dt>Plattformgebühr</dt><dd>${euro(o.fee_cents)}</dd>
              <dt>Auszahlung an dich</dt><dd>${euro(o.total_cents - o.fee_cents)}</dd>
              <dt>Zahlungs-Referenz</dt><dd><code>${o.payment_ref ?? '–'}</code></dd>
              <dt>Kontrollen</dt><dd>${o.checks.length ? o.checks.map((c) => (c === 'age' ? 'Ausweis ' : 'Stichprobe ')) : 'keine'}</dd>
              <dt>Ausgang</dt><dd>${o.exit_status === 'used' ? `benutzt ${dateTime(o.exit_used_at)}` : o.status === 'paid' ? 'noch nicht' : '–'}${o.exit_checked_by ? ` · geprüft von ${o.exit_checked_by}` : ''}</dd>
            </dl>
            ${events.length ? html`<h3>Ausgangs-Protokoll</h3><ul>${events.map((e: any) => html`<li>${dateTime(e.created_at)} – ${e.source}: ${e.result} (${e.reason})</li>`)}</ul>` : ''}
            ${o.status === 'paid'
              ? html`<form method="post" action="/dashboard/stores/${store.id}/orders/${o.id}/refund" onsubmit="return confirm('Komplett erstatten? Das Geld geht an den Kunden zurück.')">
                  <button class="btn danger">Einkauf erstatten</button></form>`
              : ''}
          </section>
        </div>`,
        store,
      ),
    );
  });

  app.post<{ Params: { id: string; oid: string } }>('/dashboard/stores/:id/orders/:oid/refund', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const back = `/dashboard/stores/${store.id}/orders/${req.params.oid}`;
    const o = await ctx.db.one<OrderRow>(`SELECT * FROM orders WHERE id = $1 AND store_id = $2 AND status = 'paid'`, [req.params.oid, store.id]);
    if (!o || !o.payment_ref) return redirect(reply, back, { err: 'Erstattung nicht möglich' });
    try {
      await ctx.payments.refund(o.payment_ref);
    } catch (err) {
      return redirect(reply, back, { err: `Erstattung fehlgeschlagen: ${(err as Error).message}` });
    }
    await ctx.db.query(`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = $1`, [o.id]);
    return redirect(reply, back, { ok: 'Erstattet. Der Kunde erhält das Geld in wenigen Tagen zurück.' });
  });

  // ---------- Einstellungen ----------
  app.get<{ Params: { id: string } }>('/dashboard/stores/:id/settings', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const newKey = (req.query as any).gate_key as string | undefined;
    reply.type('text/html').send(
      page(
        req,
        `Einstellungen – ${store.name}`,
        html`${flash(req)}<div class="page-head"><h1>Einstellungen</h1></div>${storeTabs(store, '/settings')}
        <section class="card">
          <h2>Laden</h2>
          <form method="post" action="/dashboard/stores/${store.id}/settings" class="form-grid">
            <label>Name<input name="name" value="${store.name}" required maxlength="80"></label>
            <label>Adresse<input name="address" value="${store.address}" maxlength="200"></label>
            <label>Steuernummer / USt-IdNr.<input name="tax_number" value="${store.tax_number}" maxlength="40"></label>
            <label>Stichproben am Ausgang (% der Einkäufe)
              <input name="audit_percent" type="number" min="0" max="100" step="0.5" value="${(Number(store.audit_rate) * 100).toString()}"></label>
            <label>Waagen-Etiketten (Barcodes mit 2…)
              <select name="weight_barcode_format">
                ${[
                  ['price4_check', 'Preis 4-stellig mit Prüfziffer (Standard)'],
                  ['price5', 'Preis 5-stellig ohne Prüfziffer'],
                  ['none', 'keine Waagen-Etiketten'],
                ].map(([v, l]) => html`<option value="${v}" ${raw(store.weight_barcode_format === v ? 'selected' : '')}>${l}</option>`)}
              </select></label>
            <div><button class="btn primary">Speichern</button></div>
          </form>
        </section>
        <section class="card">
          <h2>Schranke / Drehkreuz</h2>
          <p>Mit dem Schranken-Schlüssel prüft deine Schranke (z. B. Raspberry Pi + QR-Scanner) die Ausgangscodes. Ohne Schranke kontrolliert dein Personal über die
            <a href="/staff/${store.id}" target="_blank">Kontroll-Seite</a>.</p>
          ${newKey
            ? html`<div class="flash ok"><strong>Neuer Schlüssel – jetzt kopieren, er wird nur einmal angezeigt:</strong><br><code class="key">${newKey}</code></div>`
            : html`<p>Status: ${store.gate_key_hash ? 'Schlüssel ist eingerichtet.' : 'Noch kein Schlüssel.'}</p>`}
          <form method="post" action="/dashboard/stores/${store.id}/gate-key" class="inline" onsubmit="return confirm('Neuen Schlüssel erzeugen? Der alte funktioniert dann nicht mehr.')">
            <button class="btn">${store.gate_key_hash ? 'Neuen Schlüssel erzeugen' : 'Schlüssel erzeugen'}</button></form>
          ${store.gate_key_hash ? html`<form method="post" action="/dashboard/stores/${store.id}/gate-key" class="inline"><input type="hidden" name="remove" value="1"><button class="link danger">Schranke entfernen</button></form>` : ''}
          <p class="muted">API: <code>POST ${ctx.config.publicUrl}/v1/gate/verify</code> mit <code>Authorization: Bearer &lt;Schlüssel&gt;</code></p>
        </section>
        <section class="card">
          <h2>Gebühren</h2>
          <p>${(store.fee_bps / 100).toLocaleString('de-DE')} % + ${euro(store.fee_fixed_cents)} pro Einkauf. Darin enthalten: Kartengebühren, Apple Pay/Google Pay, TSE, App, Hosting. Keine Grundgebühr.</p>
        </section>`,
        store,
      ),
    );
  });

  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/settings', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const b = (req.body ?? {}) as Record<string, string>;
    const audit = Math.min(100, Math.max(0, Number(String(b.audit_percent ?? '3').replace(',', '.')) || 0)) / 100;
    const fmt = ['none', 'price4_check', 'price5'].includes(b.weight_barcode_format) ? b.weight_barcode_format : store.weight_barcode_format;
    const name = String(b.name ?? '').trim().slice(0, 80) || store.name;
    await ctx.db.query(
      `UPDATE stores SET name = $2, address = $3, tax_number = $4, audit_rate = $5, weight_barcode_format = $6,
         catalog_version = catalog_version + (CASE WHEN weight_barcode_format <> $6 THEN 1 ELSE 0 END) WHERE id = $1`,
      [store.id, name, String(b.address ?? '').trim().slice(0, 200), String(b.tax_number ?? '').trim().slice(0, 40), audit, fmt],
    );
    return redirect(reply, `/dashboard/stores/${store.id}/settings`, { ok: 'Gespeichert' });
  });

  app.post<{ Params: { id: string } }>('/dashboard/stores/:id/gate-key', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    if ((req.body as any)?.remove === '1') {
      await ctx.db.query('UPDATE stores SET gate_key_hash = NULL WHERE id = $1', [store.id]);
      return redirect(reply, `/dashboard/stores/${store.id}/settings`, { ok: 'Schranke entfernt' });
    }
    const key = `gk_${randomToken(24)}`;
    await ctx.db.query('UPDATE stores SET gate_key_hash = $2 WHERE id = $1', [store.id, hashToken(key)]);
    // Schlüssel einmalig per Redirect anzeigen (nicht gespeichert)
    return reply.redirect(`/dashboard/stores/${store.id}/settings?gate_key=${encodeURIComponent(key)}`, 303);
  });

  // ---------- QR-Poster ----------
  app.get<{ Params: { id: string } }>('/dashboard/stores/:id/poster', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const url = `${ctx.config.publicUrl}/s/${store.slug}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'Q', margin: 1, color: { dark: '#0b3b37', light: '#ffffff' } });
    reply.type('text/html').send(
      layout({
        title: `QR-Poster – ${store.name}`,
        bodyClass: 'poster-page',
        body: html`<div class="no-print poster-toolbar">
            <a href="/dashboard/stores/${store.id}">← zurück</a>
            <button class="btn primary" onclick="window.print()">Drucken (A4)</button>
            <a class="btn" href="/dashboard/stores/${store.id}/qr.png" download="payinside-${store.slug}.png">QR als PNG</a>
          </div>
          <article class="poster">
            <p class="poster-kicker">Ohne Kasse einkaufen</p>
            <h1>${store.name}</h1>
            <div class="poster-qr">${raw(svg)}</div>
            <p class="poster-url">${url.replace(/^https?:\/\//, '')}</p>
            <ol class="poster-steps">
              <li><strong>Scannen</strong> – Handy-Kamera auf diesen Code</li>
              <li><strong>Einkaufen</strong> – Barcodes der Produkte scannen</li>
              <li><strong>Bezahlen</strong> – Apple Pay, Google Pay oder Karte</li>
              <li><strong>Rausgehen</strong> – Ausgangscode an der Schranke zeigen</li>
            </ol>
            <p class="poster-foot">Bon kommt digital aufs Handy · Funktioniert mit App oder im Browser · Pay Inside</p>
          </article>`,
      }),
    );
  });

  app.get<{ Params: { id: string } }>('/dashboard/stores/:id/qr.png', async (req, reply) => {
    const store = await ownStore(req, req.params.id);
    const png = await QRCode.toBuffer(`${ctx.config.publicUrl}/s/${store.slug}`, { errorCorrectionLevel: 'Q', width: 1200, margin: 2 });
    reply.header('content-type', 'image/png').send(png);
  });

  // ---------- Personal-Kontrolle ----------
  app.get<{ Params: { id: string } }>('/staff/:id', async (req, reply) => {
    if (!req.merchant) return reply.redirect('/login', 303);
    const store = await ownStore(req, req.params.id);
    reply.type('text/html').send(
      layout({
        title: `Kontrolle – ${store.name}`,
        bodyClass: 'staff',
        head: html`<script src="/static/vendor/zxing-browser.min.js" defer></script><script src="/static/js/scanner.js" defer></script><script src="/static/js/staff.js" defer></script>`,
        body: html`<main class="staff-app" data-store="${store.id}">
          <header><strong>${store.name}</strong> · Ausgangskontrolle</header>
          <div class="video-wrap"><video id="video" playsinline muted></video><div class="frame"></div></div>
          <form id="manual" class="manual"><input id="token" placeholder="Code einfügen (PI1…)" autocomplete="off"><button class="btn">Prüfen</button></form>
          <section id="result" class="result idle"><p>Ausgangscode des Kunden scannen</p></section>
        </main>`,
      }),
    );
  });

  app.post('/v1/staff/verify', async (req) => {
    const m = requireMerchant(req);
    const b = z
      .object({ store_id: z.string().uuid(), token: z.string().min(10).max(2000), action: z.enum(['inspect', 'clear']) })
      .parse(req.body);
    await ownStore(req, b.store_id);
    return verifyExit(ctx, b.store_id, b.token, 'staff', b.action, m.name);
  });
}

function decodeCsv(buf: Buffer): string {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  if (!utf8.includes('�')) return utf8;
  // Excel unter Windows speichert CSV oft in Windows-1252
  return new TextDecoder('windows-1252').decode(buf);
}

export function receiptHtml(store: StoreRow, o: OrderRow): SafeHtml {
  const f = o.fiscal;
  return html`<div class="receipt-body">
    <h2>${store.name}</h2>
    <p class="muted">${store.address}${store.tax_number ? html`<br>St.-Nr./USt-IdNr.: ${store.tax_number}` : ''}</p>
    <table class="receipt-items">
      ${o.items.map(
        (i) => html`<tr><td>${i.qty > 1 ? `${i.qty} × ` : ''}${i.name}${i.weighed ? ' (Waage)' : ''}</td><td class="num">${euro(i.unit_cents * i.qty)} ${i.vat_rate === 19 ? 'A' : i.vat_rate === 7 ? 'B' : 'C'}</td></tr>
          ${i.deposit_cents ? html`<tr class="sub"><td>  Pfand</td><td class="num">${euro(i.deposit_cents * i.qty)}</td></tr>` : ''}`,
      )}
      <tr class="total"><td>Summe</td><td class="num">${euro(o.total_cents)}</td></tr>
    </table>
    <table class="receipt-vat"><tr><th></th><th>MwSt</th><th class="num">Netto</th><th class="num">Steuer</th><th class="num">Brutto</th></tr>
      ${o.vat_breakdown.map((v) => html`<tr><td>${v.rate === 19 ? 'A' : v.rate === 7 ? 'B' : 'C'}</td><td>${v.rate} %</td><td class="num">${euro(v.net_cents)}</td><td class="num">${euro(v.vat_cents)}</td><td class="num">${euro(v.gross_cents)}</td></tr>`)}
    </table>
    <p>Bezahlt unbar · Bon-Nr. ${o.receipt_number ?? '–'} · ${dateTime(o.paid_at)}</p>
    ${f?.ok
      ? html`<p class="tse">TSE${f.simulated ? ' (SIMULIERT – kein gültiger Beleg)' : ''}: Seriennr. ${f.tss_serial} · Kasse ${f.client_serial} · Trans.-Nr. ${f.tx_number}
          · Start ${f.time_start} · Ende ${f.time_end} · Sig.-Zähler ${f.signature_counter}<br><span class="sig">${f.signature}</span></p>`
      : html`<p class="tse">${f?.error === 'TSE nicht eingerichtet' ? 'TSE nicht eingerichtet' : 'TSE ausgefallen'}</p>`}
  </div>`;
}
