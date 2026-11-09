import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { createDb, migrate, type Db } from './db.js';
import { HttpError, type AppContext } from './context.js';
import { createExitSigner, generateExitKeyPem } from './lib/exitToken.js';
import { DisabledPayments, MockPayments, PaymentError, StripePayments, type PaymentProvider } from './providers/payments.js';
import { DisabledFiscal, FiskalyFiscal, MockFiscal, type FiscalProvider } from './providers/fiscal.js';
import { apiRoutes } from './routes/api.js';
import { merchantRoutes } from './routes/merchant.js';
import { webRoutes } from './routes/web.js';
import { html, layout } from './lib/html.js';
import { hashToken } from './lib/security.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface BuildOptions {
  config: Config;
  db?: Db;
  payments?: PaymentProvider;
  fiscal?: FiscalProvider;
  random?: () => number;
  logger?: boolean;
}

async function loadExitKey(db: Db, config: Config): Promise<string> {
  if (config.exitTokenPrivateKey) return config.exitTokenPrivateKey.replace(/\\n/g, '\n');
  const existing = await db.one<{ value: string }>(`SELECT value FROM platform_secrets WHERE name = 'exit_key'`);
  if (existing) return existing.value;
  const pem = generateExitKeyPem();
  await db.query(`INSERT INTO platform_secrets (name, value) VALUES ('exit_key', $1) ON CONFLICT (name) DO NOTHING`, [pem]);
  return (await db.one<{ value: string }>(`SELECT value FROM platform_secrets WHERE name = 'exit_key'`))!.value;
}

export function choosePayments(config: Config): PaymentProvider {
  if (config.stripe.secretKey) {
    return new StripePayments(config.stripe.secretKey, config.stripe.publishableKey, config.stripe.webhookSecret);
  }
  return config.allowMockPayments ? new MockPayments() : new DisabledPayments();
}

export function chooseFiscal(config: Config): FiscalProvider {
  if (config.fiskaly.apiKey && config.fiskaly.apiSecret) {
    return new FiskalyFiscal(config.fiskaly.apiKey, config.fiskaly.apiSecret, config.fiskaly.baseUrl);
  }
  // Simulierte TSE nur in Entwicklung/Demo – in Produktion wäre ein "SIMULIERT"-Bon nicht zulässig
  return config.allowMockPayments ? new MockFiscal() : new DisabledFiscal();
}

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const { config } = opts;
  const db = opts.db ?? createDb(config.databaseUrl);
  await migrate(db);

  const ctx: AppContext = {
    config,
    db,
    payments: opts.payments ?? choosePayments(config),
    fiscal: opts.fiscal ?? chooseFiscal(config),
    signer: createExitSigner(await loadExitKey(db, config)),
    random: opts.random ?? Math.random,
  };

  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.env === 'production' ? 'info' : 'warn' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: config.env === 'production',
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, {
    max: 1200,
    timeWindow: '1 minute',
    // Viele Kunden im Laden teilen sich oft eine IP (WLAN) – daher nach Session-Token begrenzen, falls vorhanden
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `t:${hashToken(auth).slice(0, 24)}` : `ip:${req.ip}`;
    },
  });
  await app.register(fastifyStatic, { root: publicDir, prefix: '/static/', maxAge: config.env === 'production' ? '1d' : 0 });

  // Sicherheits-Header
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (!req.url.startsWith('/static/')) reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(self), payment=(self)');
  });

  // CSRF-Schutz zusätzlich zu SameSite-Cookies: Formular-POSTs müssen von der eigenen Seite kommen
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST' || req.url.startsWith('/webhooks/') || req.url.startsWith('/v1/gate/')) return;
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return;
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      /* ungültig */
    }
    if (host !== req.headers.host && origin !== config.publicUrl) {
      return reply.code(403).send({ error: 'forbidden_origin', message: 'Anfrage von fremder Seite abgelehnt' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const wantsHtml = !req.url.startsWith('/v1/') && !req.url.startsWith('/webhooks/') && req.method === 'GET';
    let status = 500;
    let body: Record<string, unknown> = { error: 'internal', message: 'Interner Fehler – bitte später erneut versuchen' };
    if (err instanceof HttpError) {
      status = err.statusCode;
      body = { error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
    } else if (err instanceof ZodError) {
      status = 400;
      body = { error: 'invalid_request', message: 'Ungültige Anfrage', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    } else if (err instanceof PaymentError) {
      status = err.code === 'payments_not_configured' ? 503 : 502;
      body = { error: err.code, message: err.message };
    } else if ((err as any).statusCode && (err as any).statusCode < 500) {
      status = (err as any).statusCode;
      body = { error: (err as any).code ?? 'bad_request', message: (err as Error).message };
    } else {
      req.log.error({ err }, 'Unbehandelter Fehler');
    }
    if (status === 401 && (req.url.startsWith('/dashboard') || req.url.startsWith('/staff'))) {
      return reply.redirect('/login', 303);
    }
    if (wantsHtml) {
      return reply
        .code(status)
        .type('text/html')
        .send(layout({ title: 'Fehler – Pay Inside', body: html`<main class="container narrow center"><h1>Hoppla</h1><p>${String(body.message)}</p><p><a href="javascript:history.back()">Zurück</a></p></main>` }));
    }
    return reply.code(status).send(body);
  });

  await app.register(async (s) => apiRoutes(s, ctx));
  await app.register(async (s) => merchantRoutes(s, ctx));
  await app.register(async (s) => webRoutes(s, ctx));

  // Aufräumen: abgelaufene Sessions und hängengebliebene, unbezahlte Bestellungen (stündlich)
  const cleanup = async () => {
    try {
      await db.query(`DELETE FROM merchant_sessions WHERE expires_at < now()`);
      await db.query(`DELETE FROM shopping_sessions s WHERE expires_at < now() - interval '120 days'
                      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.session_id = s.id AND o.paid_at > now() - interval '120 days')`);
      await db.query(`UPDATE orders SET status = 'canceled' WHERE status = 'pending_payment' AND created_at < now() - interval '2 hours'`);
    } catch (err) {
      app.log.warn({ err }, 'Aufräumen fehlgeschlagen');
    }
  };
  if (config.env !== 'test') {
    const t = setInterval(cleanup, 3600_000);
    t.unref();
  }
  app.addHook('onClose', async () => {
    if (!opts.db) await db.close();
  });

  return { app, ctx };
}
