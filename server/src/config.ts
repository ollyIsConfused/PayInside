// Zentrale Konfiguration. Alles kommt aus Umgebungsvariablen (siehe .env.example).
// Ohne Stripe-/fiskaly-Schlüssel läuft der Server im Testmodus mit simulierten Zahlungen und simulierter TSE.

function str(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Umgebungsvariable ${name} muss eine Zahl sein`);
  return n;
}

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  publicUrl: string; // z. B. https://payinside.de – wird in QR-Codes und Links verwendet
  databaseUrl: string;
  sessionSecret: string;
  exitTokenPrivateKey: string; // optional, PEM (PKCS8) – sonst wird ein Schlüssel in der DB erzeugt
  exitTokenTtlSeconds: number;
  shoppingSessionTtlHours: number;
  platformFeeBps: number; // Plattformgebühr in Basispunkten (250 = 2,5 %) – deckt Stripe-Gebühren + deine Marge
  platformFeeFixedCents: number; // fixe Gebühr pro Einkauf in Cent
  defaultAuditRate: number; // Anteil zufälliger Stichproben (0.03 = 3 %)
  stripe: {
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
  };
  fiskaly: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
  };
  apple: {
    teamId: string;
    bundleId: string;
    appStoreId: string;
    merchantId: string;
  };
  company: {
    name: string;
    owner: string;
    address: string;
    email: string;
    phone: string;
    vatId: string;
  };
  allowMockPayments: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (str('NODE_ENV', 'development') as Config['env']);
  const port = int('PORT', 3000);
  const stripeSecret = str('STRIPE_SECRET_KEY');
  const cfg: Config = {
    env,
    port,
    host: str('HOST', '0.0.0.0'),
    publicUrl: str('PUBLIC_URL', `http://localhost:${port}`).replace(/\/$/, ''),
    databaseUrl: str('DATABASE_URL', 'postgres://payinside:payinside@localhost:5432/payinside'),
    sessionSecret: str('SESSION_SECRET', env === 'production' ? '' : 'dev-secret-bitte-in-produktion-aendern'),
    exitTokenPrivateKey: str('EXIT_TOKEN_PRIVATE_KEY'),
    exitTokenTtlSeconds: int('EXIT_TOKEN_TTL_SECONDS', 30 * 60),
    shoppingSessionTtlHours: int('SHOPPING_SESSION_TTL_HOURS', 4),
    platformFeeBps: int('PLATFORM_FEE_BPS', 250),
    platformFeeFixedCents: int('PLATFORM_FEE_FIXED_CENTS', 35),
    defaultAuditRate: Number(str('DEFAULT_AUDIT_RATE', '0.03')),
    stripe: {
      secretKey: stripeSecret,
      publishableKey: str('STRIPE_PUBLISHABLE_KEY'),
      webhookSecret: str('STRIPE_WEBHOOK_SECRET'),
    },
    fiskaly: {
      apiKey: str('FISKALY_API_KEY'),
      apiSecret: str('FISKALY_API_SECRET'),
      baseUrl: str('FISKALY_BASE_URL', 'https://kassensichv-middleware.fiskaly.com/api/v2'),
    },
    apple: {
      teamId: str('APPLE_TEAM_ID'),
      bundleId: str('IOS_BUNDLE_ID', 'de.payinside.app'),
      appStoreId: str('IOS_APP_STORE_ID'),
      merchantId: str('APPLE_PAY_MERCHANT_ID', 'merchant.de.payinside'),
    },
    company: {
      name: str('COMPANY_NAME', 'Pay Inside'),
      owner: str('COMPANY_OWNER', '[Vorname Nachname]'),
      address: str('COMPANY_ADDRESS', '[Straße Nr., PLZ Ort]'),
      email: str('COMPANY_EMAIL', 'hallo@example.com'),
      phone: str('COMPANY_PHONE', ''),
      vatId: str('COMPANY_VAT_ID', ''),
    },
    // Simulierte Zahlungen sind nur erlaubt, wenn kein Stripe-Schlüssel gesetzt ist UND nicht Produktion –
    // oder wenn ALLOW_MOCK_PAYMENTS=true explizit gesetzt ist (z. B. für eine Demo-Instanz).
    allowMockPayments: str('ALLOW_MOCK_PAYMENTS') === 'true' || (!stripeSecret && env !== 'production'),
    ...overrides,
  };

  if (cfg.env === 'production') {
    if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) {
      throw new Error('SESSION_SECRET muss in Produktion gesetzt sein (mind. 32 Zeichen).');
    }
    if (!cfg.publicUrl.startsWith('https://')) {
      throw new Error('PUBLIC_URL muss in Produktion mit https:// beginnen.');
    }
  }
  return cfg;
}
