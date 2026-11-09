import Stripe from 'stripe';

// Zahlungsanbieter-Abstraktion. Produktiv: Stripe Connect (Geld geht direkt an den Laden,
// die Plattformgebühr wird automatisch einbehalten → keine eigene BaFin-Lizenz nötig).
// Entwicklung/Demo: MockPayments simuliert erfolgreiche Zahlungen.

export interface CreatePaymentInput {
  orderId: string;
  storeId: string;
  storeName: string;
  amountCents: number;
  feeCents: number;
  accountId: string;
}

export type PaymentWebhookEvent =
  | { id: string; kind: 'payment_succeeded'; ref: string }
  | { id: string; kind: 'payment_failed'; ref: string }
  | { id: string; kind: 'refunded'; ref: string }
  | { id: string; kind: 'account_updated'; accountId: string; chargesEnabled: boolean }
  | { id: string; kind: 'ignored'; type: string };

export interface PaymentProvider {
  readonly name: 'mock' | 'stripe' | 'disabled';
  createPayment(input: CreatePaymentInput): Promise<{ ref: string; client: Record<string, unknown> }>;
  cancelPayment(ref: string): Promise<void>;
  refund(ref: string): Promise<void>;
  createAccount(input: { storeId: string; storeName: string; email: string }): Promise<string>;
  onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string>;
  accountStatus(accountId: string): Promise<{ chargesEnabled: boolean; detailsSubmitted: boolean }>;
  dashboardLink(accountId: string): Promise<string | null>;
  verifyWebhook(rawBody: Buffer, signature: string): PaymentWebhookEvent;
}

export class PaymentError extends Error {
  constructor(message: string, public readonly code = 'payment_error') {
    super(message);
  }
}

export class MockPayments implements PaymentProvider {
  readonly name = 'mock' as const;
  async createPayment(input: CreatePaymentInput) {
    return { ref: `mock_${input.orderId}`, client: { provider: 'mock' } };
  }
  async cancelPayment() {}
  async refund() {}
  async createAccount(input: { storeId: string }) {
    return `acct_mock_${input.storeId.replace(/-/g, '').slice(0, 16)}`;
  }
  async onboardingLink(_accountId: string, returnUrl: string) {
    return returnUrl;
  }
  async accountStatus() {
    return { chargesEnabled: true, detailsSubmitted: true };
  }
  async dashboardLink() {
    return null;
  }
  verifyWebhook(): PaymentWebhookEvent {
    throw new PaymentError('Webhooks sind im Testmodus nicht aktiv', 'webhook_disabled');
  }
}

export class DisabledPayments implements PaymentProvider {
  readonly name = 'disabled' as const;
  private fail(): never {
    throw new PaymentError('Zahlungen sind nicht konfiguriert (STRIPE_SECRET_KEY fehlt)', 'payments_not_configured');
  }
  async createPayment(): Promise<never> {
    this.fail();
  }
  async cancelPayment() {}
  async refund(): Promise<never> {
    this.fail();
  }
  async createAccount(): Promise<never> {
    this.fail();
  }
  async onboardingLink(): Promise<never> {
    this.fail();
  }
  async accountStatus() {
    return { chargesEnabled: false, detailsSubmitted: false };
  }
  async dashboardLink() {
    return null;
  }
  verifyWebhook(): never {
    this.fail();
  }
}

export class StripePayments implements PaymentProvider {
  readonly name = 'stripe' as const;
  private stripe: Stripe;
  private webhookSecrets: string[];

  constructor(secretKey: string, private publishableKey: string, webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { appInfo: { name: 'PayInside' }, maxNetworkRetries: 2 });
    // Mehrere Secrets kommagetrennt möglich (Plattform-Webhook + Connect-Webhook)
    this.webhookSecrets = webhookSecret.split(',').map((s) => s.trim()).filter(Boolean);
  }

  async createPayment(input: CreatePaymentInput) {
    const pi = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: 'eur',
        automatic_payment_methods: { enabled: true },
        application_fee_amount: input.feeCents,
        transfer_data: { destination: input.accountId },
        on_behalf_of: input.accountId,
        description: `Einkauf bei ${input.storeName}`,
        metadata: { order_id: input.orderId, store_id: input.storeId },
      },
      { idempotencyKey: `order_${input.orderId}` },
    );
    return {
      ref: pi.id,
      client: { provider: 'stripe', clientSecret: pi.client_secret, publishableKey: this.publishableKey },
    };
  }

  async cancelPayment(ref: string) {
    try {
      await this.stripe.paymentIntents.cancel(ref);
    } catch {
      // bereits abgeschlossen/abgebrochen – ignorieren
    }
  }

  async refund(ref: string) {
    await this.stripe.refunds.create({ payment_intent: ref, reverse_transfer: true, refund_application_fee: true });
  }

  async createAccount(input: { storeId: string; storeName: string; email: string }) {
    const acct = await this.stripe.accounts.create({
      type: 'express',
      country: 'DE',
      email: input.email,
      business_profile: { name: input.storeName, mcc: '5411' },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { store_id: input.storeId },
    });
    return acct.id;
  }

  async onboardingLink(accountId: string, returnUrl: string, refreshUrl: string) {
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: 'account_onboarding',
    });
    return link.url;
  }

  async accountStatus(accountId: string) {
    const acct = await this.stripe.accounts.retrieve(accountId);
    return { chargesEnabled: !!acct.charges_enabled, detailsSubmitted: !!acct.details_submitted };
  }

  async dashboardLink(accountId: string) {
    try {
      return (await this.stripe.accounts.createLoginLink(accountId)).url;
    } catch {
      return null;
    }
  }

  verifyWebhook(rawBody: Buffer, signature: string): PaymentWebhookEvent {
    let event: Stripe.Event | null = null;
    let lastErr: unknown;
    for (const secret of this.webhookSecrets) {
      try {
        event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!event) throw new PaymentError(`Webhook-Signatur ungültig: ${(lastErr as Error)?.message ?? 'kein Secret'}`, 'bad_signature');

    switch (event.type) {
      case 'payment_intent.succeeded':
        return { id: event.id, kind: 'payment_succeeded', ref: event.data.object.id };
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        return { id: event.id, kind: 'payment_failed', ref: event.data.object.id };
      case 'charge.refunded': {
        const pi = event.data.object.payment_intent;
        const ref = typeof pi === 'string' ? pi : pi?.id;
        return ref ? { id: event.id, kind: 'refunded', ref } : { id: event.id, kind: 'ignored', type: event.type };
      }
      case 'account.updated':
        return {
          id: event.id,
          kind: 'account_updated',
          accountId: event.data.object.id,
          chargesEnabled: !!event.data.object.charges_enabled,
        };
      default:
        return { id: event.id, kind: 'ignored', type: event.type };
    }
  }
}
