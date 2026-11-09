import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../context.js';
import { html, raw, layout, euro } from '../lib/html.js';
import { loadStore } from '../services/orders.js';
import { storeInfo } from './api.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

// Öffentliche Seiten: Startseite für Händler, Einstieg per Eingangs-QR, Web-Shopper, Rechtliches, Apple-Verknüpfung.

export async function webRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config } = ctx;
  const feeText = `${(config.platformFeeBps / 100).toLocaleString('de-DE')} % + ${euro(config.platformFeeFixedCents)}`;

  const publicNav = html`<header class="topbar"><a class="brand" href="/"><img src="/static/icon.svg" alt="" width="28" height="28"> Pay Inside</a>
    <nav><a href="/#so-gehts">So geht's</a><a href="/#preise">Preise</a><a href="/login">Anmelden</a><a class="btn small" href="/signup">Kostenlos starten</a></nav></header>`;

  const footer = html`<footer class="footer"><div class="container">
    <span>© ${new Date().getFullYear()} ${config.company.name}</span>
    <a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a><a href="/agb">AGB</a><a href="mailto:${config.company.email}">Kontakt</a>
  </div></footer>`;

  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(
      layout({
        title: 'Pay Inside – Verkaufen ohne Kasse',
        description: 'Kunden scannen Produkte mit dem Handy, zahlen in der App und gehen. Für Hofläden, Kioske, Unverpackt- und 24/7-Läden.',
        nav: publicNav,
        bodyClass: 'landing',
        body: html`
        <section class="hero"><div class="container hero-grid">
          <div>
            <p class="kicker">Scan &amp; Go für jeden Laden</p>
            <h1>Verkaufen ohne Kasse.<br>Rund um die Uhr.</h1>
            <p class="lead">Kunden scannen am Eingang einen QR-Code, scannen ihre Produkte mit dem Handy, zahlen mit Apple Pay, Google Pay oder Karte – und gehen. Der Bon kommt digital, TSE-signiert.</p>
            <p><a class="btn primary big" href="/signup">Laden kostenlos anmelden</a> <a class="btn big" href="#so-gehts">So funktioniert's</a></p>
            <p class="muted">Keine Grundgebühr · Keine Hardware nötig · In 10 Minuten startklar</p>
          </div>
          <div class="phone"><div class="phone-screen">
            <div class="ph-store">Hofladen Sonnenberg</div>
            <div class="ph-item"><span>Bio-Eier 6er</span><b>3,49 €</b></div>
            <div class="ph-item"><span>Äpfel (Waage)</span><b>2,17 €</b></div>
            <div class="ph-item"><span>Apfelsaft 1L</span><b>2,99 €</b></div>
            <div class="ph-item sub"><span>Pfand</span><b>0,15 €</b></div>
            <div class="ph-total"><span>Summe</span><b>8,80 €</b></div>
            <div class="ph-pay"> Pay</div>
          </div></div>
        </div></section>

        <section id="so-gehts" class="container section">
          <h2>So einfach geht's</h2>
          <div class="grid four steps">
            <div class="card"><span class="num-badge">1</span><h3>QR am Eingang</h3><p>Kunde scannt den Code auf deinem Poster. Die App (oder der Browser) lädt deine Preise.</p></div>
            <div class="card"><span class="num-badge">2</span><h3>Produkte scannen</h3><p>Barcode scannen, fertig. Auch Waagen-Etiketten, Pfand und Altersfreigaben.</p></div>
            <div class="card"><span class="num-badge">3</span><h3>In der App zahlen</h3><p>Apple Pay, Google Pay oder Karte. Das Geld geht direkt auf dein Konto.</p></div>
            <div class="card"><span class="num-badge">4</span><h3>Rausgehen</h3><p>Ausgangscode an der Schranke scannen – oder dein Personal prüft mit dem Handy.</p></div>
          </div>
        </section>

        <section class="container section">
          <h2>Gemacht für Läden ohne große Kassen-IT</h2>
          <div class="grid three">
            <div class="card"><h3>🧺 Hofläden &amp; Selbstbedienung</h3><p>Kein Vertrauenskässchen mehr. Jeder Einkauf ist bezahlt und dokumentiert.</p></div>
            <div class="card"><h3>🌙 24/7 &amp; Smart Stores</h3><p>Verkaufen, wenn niemand da ist. Mit Schranke, Stichproben und Altersprüfung.</p></div>
            <div class="card"><h3>🏪 Kiosk, Unverpackt, Vereinsheim</h3><p>Weniger Schlange, weniger Bargeld, kein teures Kassensystem.</p></div>
          </div>
        </section>

        <section id="preise" class="container section">
          <h2>Ein Preis. Alles drin.</h2>
          <div class="card pricing">
            <div class="price">${feeText}<small>pro Einkauf</small></div>
            <ul class="checks">
              <li>Keine Grundgebühr, keine Vertragslaufzeit</li>
              <li>Kartengebühren, Apple Pay &amp; Google Pay inklusive</li>
              <li>Cloud-TSE nach Kassensicherungsverordnung inklusive</li>
              <li>Digitale Bons, Händler-Portal, CSV-Import, QR-Poster</li>
              <li>Auszahlung direkt auf dein Bankkonto</li>
            </ul>
            <a class="btn primary big" href="/signup">Jetzt starten</a>
          </div>
        </section>

        <section class="container section faq">
          <h2>Häufige Fragen</h2>
          <details><summary>Brauchen meine Kunden eine App?</summary><p>Nein. Wer die Pay-Inside-App hat, landet direkt in der App – alle anderen kaufen ohne Installation im Browser ein (iPhone mit Apple Pay, Android mit Google Pay).</p></details>
          <details><summary>Was ist mit Diebstahl?</summary><p>Der Ausgangscode ist digital signiert und nur einmal gültig. Zusätzlich wählt das System zufällige Stichproben aus und verlangt bei Alkohol/Tabak eine Ausweisprüfung.</p></details>
          <details><summary>Ist das finanzamtkonform?</summary><p>Jeder Verkauf wird von einer zertifizierten Cloud-TSE signiert, der Bon wird digital ausgegeben. Die Meldung der Kasse beim Finanzamt übernimmst du – wir erklären dir, wie.</p></details>
          <details><summary>Wann bekomme ich mein Geld?</summary><p>Zahlungen laufen über Stripe und werden automatisch auf dein Bankkonto ausgezahlt (in der Regel wenige Werktage).</p></details>
          <details><summary>Brauche ich eine Schranke?</summary><p>Nein. Ohne Schranke prüft dein Personal den Ausgangscode mit jedem Handy über die Kontroll-Seite. Eine Schranke kannst du später nachrüsten.</p></details>
        </section>
        ${footer}`,
      }),
    );
  });

  // Ziel des Eingangs-QR-Codes. Ist die iOS-App installiert, öffnet iOS direkt die App (Universal Link).
  app.get<{ Params: { slug: string } }>('/s/:slug', async (req, reply) => {
    const store = await loadStore(ctx, req.params.slug);
    if (!store) return reply.code(404).type('text/html').send(notFound());
    const appMeta = config.apple.appStoreId
      ? html`<meta name="apple-itunes-app" content="app-id=${config.apple.appStoreId}, app-argument=${config.publicUrl}/s/${store.slug}">`
      : '';
    reply.type('text/html').send(
      layout({
        title: `${store.name} – Pay Inside`,
        head: appMeta || undefined,
        bodyClass: 'entry',
        body: html`<main class="container narrow center">
          <img src="/static/icon.svg" width="64" height="64" alt="">
          <h1>Willkommen bei<br>${store.name}</h1>
          ${store.status === 'active' && store.charges_enabled
            ? html`<p class="lead">Scanne deine Produkte, bezahle mit dem Handy und geh einfach raus.</p>
                <p><a class="btn primary big wide" href="/shop/${store.slug}">Jetzt einkaufen</a></p>
                ${config.apple.appStoreId ? html`<p><a class="btn wide" href="https://apps.apple.com/app/id${config.apple.appStoreId}">iPhone-App laden</a></p>` : ''}
                <p class="muted">Kein Konto nötig. Bezahlen mit Apple Pay, Google Pay oder Karte.</p>`
            : html`<p class="lead">Einkaufen mit Pay Inside ist hier gerade nicht verfügbar. Bitte nutze die Kasse.</p>`}
        </main>`,
      }),
    );
  });

  // Web-Shopper (läuft auf jedem Handy im Browser – auch Android)
  app.get<{ Params: { slug: string } }>('/shop/:slug', async (req, reply) => {
    const store = await loadStore(ctx, req.params.slug);
    if (!store) return reply.code(404).type('text/html').send(notFound());
    const boot = JSON.stringify(storeInfo(ctx, store)).replace(/</g, '\\u003c');
    reply.type('text/html').send(
      layout({
        title: `${store.name} – einkaufen`,
        bodyClass: 'shop',
        head: html`<link rel="manifest" href="/manifest.webmanifest">
          <script>window.PI_STORE = ${raw(boot)};</script>
          ${ctx.payments.name === 'stripe' ? html`<script src="https://js.stripe.com/v3/" defer></script>` : ''}
          <script src="/static/vendor/zxing-browser.min.js" defer></script>
          <script src="/static/js/scanner.js" defer></script>
          <script src="/static/js/shop.js" defer></script>`,
        body: html`<div id="app" class="shop-app"><p class="center muted" style="padding:3rem">Lade…</p></div>`,
      }),
    );
  });

  app.get('/manifest.webmanifest', async (_req, reply) => {
    reply.header('content-type', 'application/manifest+json').send({
      name: 'Pay Inside',
      short_name: 'Pay Inside',
      start_url: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: '#0f766e',
      icons: [{ src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
  });

  // Verknüpfung mit der iOS-App (Universal Links)
  app.get('/.well-known/apple-app-site-association', async (_req, reply) => {
    const appId = `${config.apple.teamId || 'TEAMID'}.${config.apple.bundleId}`;
    reply.header('content-type', 'application/json').send({
      applinks: { details: [{ appIDs: [appId], components: [{ '/': '/s/*', comment: 'Eingangs-QR-Codes' }] }] },
      webcredentials: { apps: [appId] },
    });
  });

  // Apple Pay im Browser (Stripe): Datei aus dem Stripe-Dashboard unter public/ ablegen
  // (Einstellungen → Zahlungsmethoden-Domains → Domain hinzufügen → Datei herunterladen)
  app.get('/.well-known/apple-developer-merchantid-domain-association', async (_req, reply) => {
    try {
      const file = await readFile(path.join(publicDir, 'apple-developer-merchantid-domain-association'));
      reply.header('content-type', 'text/plain').send(file);
    } catch {
      reply.code(404).send('Nicht eingerichtet');
    }
  });

  // --- Rechtliches (VORLAGEN – vor dem Livegang anwaltlich prüfen lassen!) ---
  const c = config.company;
  const legal = (title: string, body: ReturnType<typeof html>) =>
    layout({ title: `${title} – ${c.name}`, nav: publicNav, body: html`<main class="container narrow legal"><h1>${title}</h1>${body}</main>${footer}` });

  app.get('/impressum', async (_req, reply) => {
    reply.type('text/html').send(
      legal(
        'Impressum',
        html`<p>Angaben gemäß § 5 DDG</p>
        <p>${c.name}<br>${c.owner}<br>${c.address}</p>
        <p>E-Mail: <a href="mailto:${c.email}">${c.email}</a>${c.phone ? html`<br>Telefon: ${c.phone}` : ''}</p>
        ${c.vatId ? html`<p>Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: ${c.vatId}</p>` : ''}
        <p>Verantwortlich für den Inhalt: ${c.owner}, Anschrift wie oben.</p>
        <p>Verbraucherstreitbeilegung: Wir sind nicht bereit oder verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>`,
      ),
    );
  });

  app.get('/datenschutz', async (_req, reply) => {
    reply.type('text/html').send(
      legal(
        'Datenschutzerklärung',
        html`<p class="flash warn">Vorlage – bitte vor Veröffentlichung prüfen lassen (z. B. Datenschutz-Generator oder Anwalt).</p>
        <h2>Verantwortlicher</h2><p>${c.name}, ${c.owner}, ${c.address}, ${c.email}</p>
        <h2>Einkaufen mit Pay Inside (Kunden)</h2>
        <p>Für Kunden ist kein Konto nötig. Beim Scannen des Eingangs-QR-Codes wird eine anonyme Einkaufs-Session erzeugt. Wir verarbeiten die gescannten Artikel, den Bon und den Zeitpunkt des Einkaufs, um den Kaufvertrag zwischen dir und dem Laden abzuwickeln (Art. 6 Abs. 1 lit. b DSGVO) und steuerliche Aufbewahrungspflichten zu erfüllen (Art. 6 Abs. 1 lit. c DSGVO, § 147 AO).</p>
        <p>Zahlungen werden von Stripe Payments Europe Ltd. (Irland) abgewickelt. Kartendaten erhalten wir nicht. Bons werden mit einer Cloud-TSE (fiskaly GmbH, Österreich) signiert.</p>
        <h2>Händler</h2><p>Für Händlerkonten speichern wir Name, E-Mail, Firmendaten und Ladendaten zur Vertragserfüllung.</p>
        <h2>Hosting</h2><p>[Hosting-Anbieter eintragen, z. B. Hetzner Online GmbH, Deutschland]</p>
        <h2>Cookies</h2><p>Wir setzen nur technisch notwendige Cookies (Anmeldung im Händler-Portal). Kein Tracking.</p>
        <h2>Deine Rechte</h2><p>Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit, Widerspruch sowie Beschwerde bei einer Aufsichtsbehörde.</p>`,
      ),
    );
  });

  app.get('/agb', async (_req, reply) => {
    reply.type('text/html').send(
      legal(
        'AGB für Händler',
        html`<p class="flash warn">Vorlage – bitte vor Veröffentlichung anwaltlich prüfen lassen.</p>
        <h2>1. Leistung</h2><p>${c.name} stellt Händlern eine Software bereit, mit der Kunden im Laden Produkte per Smartphone scannen und bezahlen können („Scan &amp; Go“). Der Kaufvertrag kommt ausschließlich zwischen Händler und Kunde zustande.</p>
        <h2>2. Zahlungsabwicklung</h2><p>Zahlungen werden über Stripe abgewickelt. Der Händler schließt dazu einen Vertrag mit Stripe (Stripe Connected Account Agreement).</p>
        <h2>3. Entgelt</h2><p>${feeText} pro erfolgreichem Einkauf, automatisch einbehalten. Keine Grundgebühr. Erstattungen werden anteilig zurückgebucht.</p>
        <h2>4. Pflichten des Händlers</h2><p>Der Händler ist für korrekte Preise, Steuersätze, Altersprüfungen, die Meldung des elektronischen Aufzeichnungssystems beim Finanzamt sowie für Kontrollen am Ausgang verantwortlich.</p>
        <h2>5. Laufzeit</h2><p>Unbefristet, jederzeit kündbar.</p>
        <h2>6. Haftung</h2><p>[Haftungsregelung durch Anwalt formulieren lassen]</p>`,
      ),
    );
  });

  function notFound() {
    return layout({
      title: 'Nicht gefunden – Pay Inside',
      body: html`<main class="container narrow center"><h1>Nicht gefunden</h1><p>Dieser Laden existiert nicht (mehr).</p><p><a href="/">Zur Startseite</a></p></main>`,
    });
  }
}
