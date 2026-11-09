// Pay Inside Web-Shopper – läuft im Browser jedes Handys (auch Android), kein App-Download nötig.
(function () {
  'use strict';

  const STORE = window.PI_STORE;
  const app = document.getElementById('app');
  const K = {
    session: `pi_session_${STORE.slug}`,
    catalog: `pi_catalog_${STORE.slug}`,
    cart: `pi_cart_${STORE.slug}`,
    pending: `pi_pending_${STORE.slug}`,
    receipts: 'pi_receipts',
  };

  // ---------- Hilfsfunktionen ----------
  const eur = (c) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(c / 100);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* privater Modus – dann eben nur im Speicher */
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };
  function normalize(code) {
    const s = String(code).trim().replace(/[\s-]/g, '');
    if (/^\d{12}$/.test(s)) return '0' + s;
    if (/^0\d{13}$/.test(s)) return s.slice(1);
    return s;
  }
  let toastTimer;
  function toast(msg, isErr) {
    document.querySelector('.toast')?.remove();
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2600);
  }

  // ---------- API ----------
  let session = store.get(K.session, null);
  async function api(path, opts = {}) {
    const headers = { accept: 'application/json', ...(opts.headers || {}) };
    if (session?.session_token) headers.authorization = `Bearer ${session.session_token}`;
    if (opts.body) headers['content-type'] = 'application/json';
    const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 304) return { notModified: true };
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error(data?.message || `Fehler ${res.status}`);
      err.code = data?.error;
      err.details = data?.details;
      err.status = res.status;
      throw err;
    }
    return data;
  }
  async function ensureSession(force) {
    if (!force && session && new Date(session.expires_at) > new Date(Date.now() + 10 * 60_000)) return;
    session = await api('/v1/sessions', { method: 'POST', body: { store: STORE.slug, client: 'web' } });
    store.set(K.session, session);
  }

  // ---------- Katalog ----------
  let catalog = new Map();
  async function loadCatalog() {
    const cached = store.get(K.catalog, null);
    if (cached) catalog = new Map(cached.products.map((p) => [p.code, p]));
    try {
      const headers = cached?.etag ? { 'if-none-match': cached.etag } : {};
      const res = await fetch(`/v1/stores/${encodeURIComponent(STORE.slug)}/catalog`, { headers });
      if (res.status === 304) return;
      if (!res.ok) return;
      const data = await res.json();
      catalog = new Map(data.products.map((p) => [p.code, p]));
      store.set(K.catalog, { etag: res.headers.get('etag'), products: data.products });
    } catch {
      /* offline – mit Cache weiterarbeiten */
    }
  }

  // ---------- Warenkorb ----------
  let cart = store.get(K.cart, []);
  const saveCart = () => store.set(K.cart, cart);
  const cartTotal = () => cart.reduce((s, i) => s + (i.unit_cents + i.deposit_cents) * i.qty, 0);
  const cartCount = () => cart.reduce((s, i) => s + i.qty, 0);

  async function addCode(raw) {
    const code = normalize(raw);
    if (!code) return;
    let p = catalog.get(code);
    if (!p) {
      try {
        p = await api(`/v1/stores/${encodeURIComponent(STORE.slug)}/products/${encodeURIComponent(code)}`);
      } catch (e) {
        return toast(e.status === 404 ? `Artikel ${code} unbekannt – bitte an der Info melden` : e.message, true);
      }
    }
    const existing = cart.find((i) => i.code === code);
    // Waagen-Etiketten sind Einzelstücke – jedes Etikett einzeln zählen
    if (existing && !p.weighed) existing.qty = Math.min(99, existing.qty + 1);
    else if (!existing)
      cart.unshift({
        code,
        name: p.name,
        unit_cents: p.unit_cents ?? p.price_cents,
        deposit_cents: p.deposit_cents || 0,
        min_age: p.min_age || 0,
        weighed: !!p.weighed,
        qty: 1,
      });
    else return toast('Dieses Waagen-Etikett ist schon im Warenkorb');
    saveCart();
    toast(`✓ ${p.name}`);
    renderShop();
  }

  // ---------- Ansichten ----------
  let stopScanner = null;
  async function stopCam() {
    if (stopScanner) {
      try {
        stopScanner();
      } catch {}
      stopScanner = null;
    }
  }

  function header(right = '') {
    return `<header class="shop-head"><strong>${esc(STORE.name)}</strong>${right}</header>`;
  }

  function renderShop() {
    if (!STORE.accepting_payments) {
      app.innerHTML = `${header()}<div class="panel center"><h2>Gerade nicht verfügbar</h2><p class="muted">Dieser Markt nimmt im Moment keine Zahlungen per Pay Inside an. Bitte nutze die Kasse.</p></div>`;
      return;
    }
    const camRunning = !!stopScanner;
    const existingVideo = document.getElementById('video');
    if (!existingVideo) {
      app.innerHTML = `${header('<a href="#bons">Meine Bons</a>')}
        <div class="video-wrap"><video id="video" playsinline muted></video><div class="frame"></div>
          <div class="cam-btn" id="cam-btn"><button class="btn primary big" id="start-cam">📷 Scanner starten</button></div></div>
        <form class="manual" id="manual"><input id="manual-code" inputmode="numeric" placeholder="Barcode-Nummer eintippen" autocomplete="off"><button class="btn">+</button></form>
        <div id="cart-area"></div>
        <div class="paybar"><div class="paybar-inner"><div class="sum"><span class="muted" id="count"></span><strong id="total"></strong></div>
          <button class="btn primary big" id="pay">Bezahlen</button></div></div>`;
      document.getElementById('start-cam').onclick = startCam;
      document.getElementById('manual').onsubmit = (e) => {
        e.preventDefault();
        const input = document.getElementById('manual-code');
        addCode(input.value);
        input.value = '';
      };
      document.getElementById('pay').onclick = checkout;
    }
    document.getElementById('cam-btn').style.display = camRunning ? 'none' : '';
    const area = document.getElementById('cart-area');
    area.innerHTML = cart.length
      ? `<ul class="cart">${cart
          .map(
            (i, idx) => `<li><div class="name">${esc(i.name)}${i.min_age ? ` <span class="badge warn">${i.min_age}+</span>` : ''}
              <small>${eur(i.unit_cents)}${i.deposit_cents ? ` + ${eur(i.deposit_cents)} Pfand` : ''}${i.weighed ? ' · Waage' : ''}</small></div>
              <div class="qty"><button data-dec="${idx}" aria-label="weniger">−</button><span>${i.qty}</span>${i.weighed ? '' : `<button data-inc="${idx}" aria-label="mehr">+</button>`}</div>
              <strong class="num">${eur((i.unit_cents + i.deposit_cents) * i.qty)}</strong></li>`,
          )
          .join('')}</ul>`
      : `<p class="empty">Scanne den Barcode deines ersten Produkts.</p>`;
    area.querySelectorAll('[data-inc]').forEach((b) => (b.onclick = () => changeQty(+b.dataset.inc, 1)));
    area.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => changeQty(+b.dataset.dec, -1)));
    document.getElementById('total').textContent = eur(cartTotal());
    document.getElementById('count').textContent = `${cartCount()} Artikel`;
    document.getElementById('pay').disabled = cart.length === 0;
  }

  function changeQty(idx, delta) {
    const item = cart[idx];
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) cart.splice(idx, 1);
    saveCart();
    renderShop();
  }

  async function startCam() {
    const video = document.getElementById('video');
    try {
      stopScanner = await window.PIScanner.start(video, { mode: 'products', onCode: addCode });
      document.getElementById('cam-btn').style.display = 'none';
    } catch (e) {
      toast('Kamera nicht verfügbar – bitte Barcode-Nummer eintippen', true);
    }
  }

  // ---------- Bezahlen ----------
  async function checkout() {
    const btn = document.getElementById('pay');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await ensureSession();
      const res = await api('/v1/checkout', { method: 'POST', body: { items: cart.map((i) => ({ code: i.code, qty: i.qty })) } });
      store.set(K.pending, res.order_id);
      await stopCam();
      renderPayment(res);
    } catch (e) {
      if (e.code === 'session_expired' || e.status === 401) {
        await ensureSession(true);
        toast('Sitzung erneuert – bitte noch einmal tippen', true);
      } else if (e.code === 'unknown_products') {
        const unknown = new Set(e.details?.unknown || []);
        cart = cart.filter((i) => !unknown.has(i.code));
        saveCart();
        toast('Einige Artikel sind nicht mehr verfügbar und wurden entfernt', true);
      } else toast(e.message, true);
      btn.disabled = false;
      btn.textContent = 'Bezahlen';
      renderShop();
    }
  }

  function renderPayment(res) {
    app.innerHTML = `${header('<a href="#" id="back">Zurück</a>')}<div class="panel">
      <h2>Bezahlen</h2>
      <ul class="cart" style="padding:0">${res.items.map((i) => `<li><div class="name">${i.qty} × ${esc(i.name)}</div><strong class="num">${eur(i.line_cents)}</strong></li>`).join('')}</ul>
      <p class="row-between"><span>Summe${res.deposit_cents ? ` (inkl. ${eur(res.deposit_cents)} Pfand)` : ''}</span><strong style="font-size:1.4rem">${eur(res.total_cents)}</strong></p>
      <div id="payment-element"></div>
      <button class="btn primary big wide" id="confirm">${res.payment.provider === 'mock' ? 'Testzahlung abschließen' : `${eur(res.total_cents)} bezahlen`}</button>
      ${res.payment.provider === 'mock' ? '<p class="notice warn">Testmodus – es wird kein echtes Geld bewegt.</p>' : ''}
    </div>`;
    document.getElementById('back').onclick = async (e) => {
      e.preventDefault();
      api(`/v1/orders/${res.order_id}/cancel`, { method: 'POST' }).catch(() => {});
      store.del(K.pending);
      renderShop();
    };
    const confirmBtn = document.getElementById('confirm');

    if (res.payment.provider === 'mock') {
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        try {
          const order = await api(`/v1/orders/${res.order_id}/mock-pay`, { method: 'POST' });
          onPaid(order);
        } catch (e) {
          toast(e.message, true);
          confirmBtn.disabled = false;
        }
      };
      return;
    }

    // Stripe Payment Element (Karte, Apple Pay, Google Pay …)
    const stripe = window.Stripe(res.payment.publishableKey);
    const elements = stripe.elements({ clientSecret: res.payment.clientSecret, locale: 'de', appearance: { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'stripe' } });
    elements.create('payment', { layout: 'tabs' }).mount('#payment-element');
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      const { error } = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
        confirmParams: { return_url: `${location.origin}/shop/${STORE.slug}#paid` },
      });
      if (error) {
        toast(error.message || 'Zahlung fehlgeschlagen', true);
        confirmBtn.disabled = false;
        return;
      }
      waitForPayment(res.order_id);
    };
  }

  async function waitForPayment(orderId) {
    app.innerHTML = `${header()}<div class="panel center"><h2>Zahlung wird bestätigt…</h2><p class="muted">Einen Moment bitte.</p></div>`;
    for (let i = 0; i < 40; i++) {
      try {
        const order = await api(`/v1/orders/${orderId}`);
        if (order.status === 'paid') return onPaid(order);
        if (order.status === 'canceled') break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    store.del(K.pending);
    app.innerHTML = `${header()}<div class="panel center"><h2>Zahlung nicht bestätigt</h2><p>Falls Geld abgebucht wurde, wende dich bitte an das Personal.</p><button class="btn" id="again">Zurück zum Einkauf</button></div>`;
    document.getElementById('again').onclick = renderShop;
  }

  function saveReceipt(order) {
    const list = store.get(K.receipts, []).filter((r) => r.id !== order.id);
    list.unshift({ id: order.id, slug: STORE.slug, token: session?.session_token, order });
    store.set(K.receipts, list.slice(0, 100));
  }

  function onPaid(order) {
    cart = [];
    saveCart();
    store.del(K.pending);
    saveReceipt(order);
    renderExit(order);
  }

  // ---------- Ausgang ----------
  let exitPoll;
  async function renderExit(order) {
    clearInterval(exitPoll);
    const checks = order.checks || [];
    const used = order.exit_status === 'used';
    app.innerHTML = `${header('<a href="#bons">Meine Bons</a>')}<div class="panel center">
      ${used
        ? `<h2>Danke für deinen Einkauf! 👋</h2><p class="notice ok">Du bist ausgecheckt.</p>`
        : `<h2>Bezahlt ✓</h2><p>Halte diesen Code an den Scanner am Ausgang.</p>
           <div class="exit-qr" id="qr"><p class="muted">Lade Code…</p></div>
           ${checks.includes('age') ? '<p class="notice warn">Altersbeschränkte Artikel: bitte Ausweis bereithalten.</p>' : ''}
           ${checks.includes('audit') ? '<p class="notice warn">Kurze Stichprobe: Bitte zeige deinen Einkauf dem Personal. Danke!</p>' : ''}`}
      <p><strong>${eur(order.total_cents)}</strong> · Bon-Nr. ${esc(order.receipt_number)}</p>
      <p><button class="btn" id="show-receipt">Bon anzeigen</button> <button class="btn" id="new">Neuer Einkauf</button></p>
    </div>`;
    document.getElementById('show-receipt').onclick = () => renderReceipt(order);
    document.getElementById('new').onclick = () => {
      clearInterval(exitPoll);
      renderShop();
    };
    if (used) return;
    const loadQr = async () => {
      try {
        const svg = await api(`/v1/orders/${order.id}/exit-qr.svg`, { headers: { accept: 'image/svg+xml' } });
        const el = document.getElementById('qr');
        if (el) el.innerHTML = svg;
      } catch (e) {
        const el = document.getElementById('qr');
        if (el) el.innerHTML = `<p class="err">${esc(e.message)}</p>`;
      }
    };
    loadQr();
    let ticks = 0;
    exitPoll = setInterval(async () => {
      ticks++;
      try {
        const o = await api(`/v1/orders/${order.id}`);
        if (o.exit_status === 'used') {
          saveReceipt(o);
          clearInterval(exitPoll);
          return renderExit(o);
        }
      } catch {}
      if (ticks % 120 === 0) loadQr(); // Code alle ~10 Minuten erneuern
    }, 5000);
  }

  function renderReceipt(order) {
    clearInterval(exitPoll);
    const f = order.fiscal || {};
    const letter = (r) => (r === 19 ? 'A' : r === 7 ? 'B' : 'C');
    app.innerHTML = `${header('<a href="#" id="back">Zurück</a>')}<div class="panel"><div class="card receipt-body" style="margin:0 auto">
      <h2>${esc(order.store.name)}</h2><p class="muted">${esc(order.store.address)}${order.store.tax_number ? `<br>St.-Nr./USt-IdNr.: ${esc(order.store.tax_number)}` : ''}</p>
      <table class="receipt-items">${order.items
        .map(
          (i) => `<tr><td>${i.qty > 1 ? `${i.qty} × ` : ''}${esc(i.name)}</td><td class="num">${eur(i.unit_cents * i.qty)} ${letter(i.vat_rate)}</td></tr>
          ${i.deposit_cents ? `<tr class="sub"><td>  Pfand</td><td class="num">${eur(i.deposit_cents * i.qty)}</td></tr>` : ''}`,
        )
        .join('')}<tr class="total"><td>Summe</td><td class="num">${eur(order.total_cents)}</td></tr></table>
      <table class="receipt-vat"><tr><th></th><th>MwSt</th><th class="num">Netto</th><th class="num">Steuer</th><th class="num">Brutto</th></tr>
      ${order.vat_breakdown.map((v) => `<tr><td>${letter(v.rate)}</td><td>${v.rate} %</td><td class="num">${eur(v.net_cents)}</td><td class="num">${eur(v.vat_cents)}</td><td class="num">${eur(v.gross_cents)}</td></tr>`).join('')}</table>
      <p>Bezahlt unbar · Bon-Nr. ${esc(order.receipt_number)} · ${new Date(order.paid_at).toLocaleString('de-DE')}</p>
      <p class="tse">${f.ok ? `TSE${f.simulated ? ' (SIMULIERT)' : ''}: ${esc(f.tss_serial)} · Kasse ${esc(f.client_serial)} · Trans.-Nr. ${esc(f.tx_number)} · Start ${esc(f.time_start)} · Ende ${esc(f.time_end)} · Sig.-Zähler ${esc(f.signature_counter)}<br><span class="sig">${esc(f.signature)}</span>` : f.error === 'TSE nicht eingerichtet' ? 'TSE nicht eingerichtet' : 'TSE ausgefallen'}</p>
    </div><p class="center"><button class="btn" onclick="window.print()">Drucken / als PDF sichern</button></p></div>`;
    document.getElementById('back').onclick = (e) => {
      e.preventDefault();
      order.status === 'paid' && order.exit_status !== 'used' ? renderExit(order) : renderReceipts();
    };
  }

  function renderReceipts() {
    const list = store.get(K.receipts, []);
    app.innerHTML = `${header('<a href="#" id="back">Einkaufen</a>')}<div class="panel"><h2>Meine Bons</h2>
      ${list.length ? `<div class="receipts-list">${list.map((r, i) => `<a href="#" data-i="${i}"><span>${esc(r.order.store.name)}<br><small class="muted">${new Date(r.order.paid_at).toLocaleString('de-DE')}</small></span><strong>${eur(r.order.total_cents)}</strong></a>`).join('')}</div>`
        : '<p class="muted">Noch keine Bons auf diesem Gerät.</p>'}
      <p class="muted">Bons werden nur auf diesem Gerät gespeichert.</p></div>`;
    document.getElementById('back').onclick = (e) => {
      e.preventDefault();
      location.hash = '';
      renderShop();
    };
    app.querySelectorAll('[data-i]').forEach((a) => (a.onclick = (e) => {
      e.preventDefault();
      renderReceipt(list[+a.dataset.i].order);
    }));
  }

  // ---------- Start ----------
  window.addEventListener('hashchange', () => {
    if (location.hash === '#bons') {
      stopCam();
      renderReceipts();
    }
  });

  (async function boot() {
    try {
      await Promise.all([ensureSession(), loadCatalog()]);
    } catch (e) {
      app.innerHTML = `${header()}<div class="panel center"><h2>Keine Verbindung</h2><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Erneut versuchen</button></div>`;
      return;
    }
    const pending = store.get(K.pending, null);
    if (location.hash === '#bons') return renderReceipts();
    if (pending) {
      try {
        const o = await api(`/v1/orders/${pending}`);
        if (o.status === 'paid') return onPaid(o);
        if (o.status === 'pending_payment' && /payment_intent=/.test(location.search)) return waitForPayment(pending);
      } catch {}
      store.del(K.pending);
    }
    // Offener, bezahlter Einkauf ohne Ausgang? Dann direkt den Code zeigen
    const open = store.get(K.receipts, []).find((r) => r.slug === STORE.slug && r.order.exit_status !== 'used' && Date.now() - new Date(r.order.paid_at) < 2 * 3600_000);
    if (open && open.token === session?.session_token) {
      try {
        const o = await api(`/v1/orders/${open.id}`);
        if (o.status === 'paid' && o.exit_status !== 'used') return renderExit(o);
      } catch {}
    }
    renderShop();
  })();
})();
