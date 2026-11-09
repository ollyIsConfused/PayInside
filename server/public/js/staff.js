// Ausgangskontrolle für Personal: Exit-QR des Kunden scannen, Einkauf ansehen, Ausweis/Stichprobe bestätigen.
(function () {
  'use strict';
  const root = document.querySelector('.staff-app');
  const storeId = root.dataset.store;
  const result = document.getElementById('result');
  const video = document.getElementById('video');
  const eur = (c) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(c / 100);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  let busy = false;
  let currentToken = '';

  async function verify(token, action) {
    const res = await fetch('/v1/staff/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, token, action }),
    });
    if (res.status === 401) {
      location.href = '/login';
      return null;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Fehler');
    return data;
  }

  function show(r) {
    const title = { open: '✓ In Ordnung', check: '⚠ Kontrolle nötig', deny: '✕ Nicht gültig' }[r.result];
    const o = r.order;
    const checks = o?.checks || [];
    result.className = `result ${r.result}`;
    result.innerHTML = `<h2>${title}</h2><p><strong>${esc(r.message)}</strong></p>
      ${checks.includes('age') ? '<p>🪪 <strong>Ausweis prüfen</strong> – Artikel mit Altersfreigabe</p>' : ''}
      ${checks.includes('audit') ? '<p>🔍 <strong>Stichprobe</strong> – Waren mit Liste vergleichen</p>' : ''}
      ${o ? `<p class="muted">Bon #${esc(o.receipt_number)} · ${eur(o.total_cents)} · ${new Date(o.paid_at).toLocaleTimeString('de-DE')}</p>
        <ul>${o.items.map((i) => `<li>${i.qty} × ${esc(i.name)}${i.min_age ? ` <span class="badge warn">${i.min_age}+</span>` : ''}</li>`).join('')}</ul>` : ''}
      <div class="btns">
        ${r.result !== 'deny' && r.reason !== 'cleared' ? '<button class="btn primary big" id="clear">Freigeben</button>' : ''}
        <button class="btn big" id="next">Nächster Kunde</button>
      </div>`;
    document.getElementById('next').onclick = reset;
    const clear = document.getElementById('clear');
    if (clear)
      clear.onclick = async () => {
        clear.disabled = true;
        try {
          show(await verify(currentToken, 'clear'));
        } catch (e) {
          alert(e.message);
          clear.disabled = false;
        }
      };
  }

  function reset() {
    busy = false;
    currentToken = '';
    result.className = 'result idle';
    result.innerHTML = '<p>Ausgangscode des Kunden scannen</p>';
  }

  async function handle(token) {
    if (busy) return;
    token = token.trim();
    if (!token.startsWith('PI1.')) return;
    busy = true;
    currentToken = token;
    try {
      const r = await verify(token, 'inspect');
      if (r) show(r);
    } catch (e) {
      show({ result: 'deny', message: e.message });
    }
  }

  document.getElementById('manual').onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById('token');
    handle(input.value);
    input.value = '';
  };

  window.PIScanner.start(video, { mode: 'qr', onCode: handle }).catch(() => {
    result.innerHTML = '<p>Kamera nicht verfügbar – Code unten einfügen.</p>';
  });
})();
