/**
 * View Spa — packages & gift certificates (front-end).
 * Покупка через Square Web Payments SDK → подарочная карта. Проверка баланса.
 */
(function () {
  'use strict';

  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const CONFIG = {
    apiBase: isLocal ? 'http://localhost:8787' : 'https://viewspa-booking.ivanseydametov.workers.dev',
    turnstileSiteKey: isLocal ? '1x00000000000000000000AA' : '0x4AAAAAADdzLSWcgv1JlXj3',
  };

  const root = document.getElementById('packages-app');
  const state = { packages: [], certificate: null, payCfg: null, card: null };

  const money = (c) => '$' + (c / 100).toFixed(c % 100 ? 2 : 0);

  // Первое касание, записанное analytics.js на любой странице сайта.
  const vsSrc = () => (typeof window.vsSource === 'function' ? window.vsSource() : null) || undefined;

  // ── Аналитика покупок ─────────────────────────────────────────────
  // Покупка пакета/сертификата - это оплаченный заказ, самый крупный чек на
  // сайте. Логика та же, что в booking.js: дедуп, принудительная загрузка
  // gtag, GA4 purchase и конверсия Ads. Тихие потери логируем.
  function logConvIssue(reason, d, err) {
    try { console.error('CONVERSION_ISSUE:', reason, d || {}, err || ''); } catch (_) {}
    try {
      const payload = JSON.stringify({
        reason, gan: (d && d.transaction_id) || null, value: (d && d.value) || null,
        message: (err && err.message) || undefined, url: location.href, t: Date.now(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(CONFIG.apiBase + '/api/log-conversion', new Blob([payload], { type: 'application/json' }));
      }
    } catch (_) {}
  }

  function gaItem(kind, item, res) {
    return {
      item_id: kind === 'package' ? (item.id || 'package') : 'gift-certificate',
      item_name: kind === 'package' ? (res.name || item.name) : 'Gift certificate',
      item_category: kind === 'package' ? 'Massage package' : 'Gift certificate',
      price: Number(((res.balanceCents || 0) / 100).toFixed(2)),
      quantity: 1,
    };
  }

  function trackBeginCheckout(kind, item) {
    const cents = kind === 'package' ? item.priceCents : item.amountCents;
    try {
      if (typeof window.gtag !== 'function') return;
      window.gtag('event', 'begin_checkout', {
        currency: 'USD',
        value: Number(((cents || 0) / 100).toFixed(2)),
        items: [{
          item_id: kind === 'package' ? (item.id || 'package') : 'gift-certificate',
          item_name: kind === 'package' ? item.name : 'Gift certificate',
          item_category: kind === 'package' ? 'Massage package' : 'Gift certificate',
          price: Number(((cents || 0) / 100).toFixed(2)),
          quantity: 1,
        }],
      });
    } catch (_) {}
  }

  function trackPurchase(kind, item, res) {
    const gan = res && res.gan;
    const d = {
      transaction_id: gan,
      value: Number((((res && res.balanceCents) || 0) / 100).toFixed(2)),
      currency: 'USD',
      item_category: kind === 'package' ? 'Massage package' : 'Gift certificate',
    };
    try {
      if (!gan) return logConvIssue('missing_gan', d);
      // Дедуп: повторный рендер экрана «готово» не должен слать вторую покупку.
      try {
        const done = JSON.parse(sessionStorage.getItem('vs_pkg_done') || '[]');
        if (done.includes(gan)) return;
        done.push(gan);
        sessionStorage.setItem('vs_pkg_done', JSON.stringify(done.slice(-30)));
      } catch (_) {}

      // Оплата прошла - gtag нужен сейчас, а не через таймер.
      try { if (typeof window.vsEnsureAnalytics === 'function') window.vsEnsureAnalytics(); } catch (_) {}
      try { console.log('package_purchased →', d); } catch (_) {}

      const items = [gaItem(kind, item, res)];

      // 1) Своё событие - чтобы отделить покупки пакетов от записей.
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'package_purchased', d);
      } else {
        logConvIssue('gtag_unavailable_package_purchased', d);
      }
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: 'package_purchased' }, d));

      // 2) GA4 purchase - transaction_id = номер карты, дедуп со Square-вебхуком.
      try {
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'purchase', {
            transaction_id: gan, value: d.value, currency: 'USD', items,
          });
        } else {
          logConvIssue('gtag_unavailable_purchase', d);
        }
      } catch (err) { logConvIssue('purchase_threw', d, err); }

      // 3) Конверсия Google Ads - тот же тег, что у записи.
      try {
        const sendTo = window.VS_ADS_CONVERSION;
        if (!sendTo) {
          try { console.info('ads conversion skipped: VS_ADS_CONVERSION not set →', gan); } catch (_) {}
        } else if (typeof window.gtag === 'function') {
          window.gtag('event', 'conversion', {
            send_to: sendTo, value: d.value, currency: 'USD', transaction_id: gan,
          });
        } else {
          logConvIssue('gtag_unavailable_ads_conversion', d);
        }
      } catch (err) { logConvIssue('ads_conversion_threw', d, err); }
    } catch (err) {
      logConvIssue('track_purchase_threw', d, err);
    }
  }

  async function api(path, body, method) {
    const res = await fetch(CONFIG.apiBase + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ── Square Web Payments SDK ────────────────────────────────────────
  function loadSdk(env) {
    return new Promise((resolve, reject) => {
      if (window.Square) return resolve();
      const s = document.createElement('script');
      s.src = env === 'production'
        ? 'https://web.squarecdn.com/v1/square.js'
        : 'https://sandbox.web.squarecdn.com/v1/square.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Payment SDK failed to load'));
      document.head.appendChild(s);
    });
  }

  function renderTurnstile() {
    if (!CONFIG.turnstileSiteKey) return;
    const el = root.querySelector('.cf-turnstile');
    if (!el || el.dataset.rendered === '1') return;
    let n = 0;
    const t = () => {
      if (window.turnstile && window.turnstile.render) {
        try { window.turnstile.render(el, { sitekey: CONFIG.turnstileSiteKey }); el.dataset.rendered = '1'; } catch (_) {}
      } else if (n++ < 60) setTimeout(t, 100);
    };
    t();
  }

  // ── Экраны ─────────────────────────────────────────────────────────
  function renderHome() {
    const pkgs = state.packages.map((p) => `
      <button class="bk-svc" data-act="buy-pkg" data-id="${p.id}">
        <span class="bk-svc-main">
          <span class="bk-svc-name">${p.name}</span>
          <span class="bk-svc-dur">${p.note || ''}</span>
        </span>
        <span class="bk-svc-price">${money(p.priceCents)} ›</span>
      </button>`).join('');

    const cert = state.certificate;
    root.innerHTML = `
      <div class="bk-card">
        <span class="eyebrow">Packages & Gift Cards</span>
        <h2 class="bk-title">Prepaid packages</h2>
        <p class="bk-sub">Buy a package, then redeem sessions when you book — your balance is tracked automatically.</p>
        <div class="bk-list">${pkgs}</div>

        <h2 class="bk-title" style="margin-top:30px">Gift certificate</h2>
        <p class="bk-sub">Any amount from ${money(cert.minCents)} to ${money(cert.maxCents)}. Delivered as a code.</p>
        <div class="bk-form" style="max-width:280px">
          <label>Amount (USD)<input id="cert-amt" type="number" min="${cert.minCents / 100}" max="${cert.maxCents / 100}" step="5" value="100"></label>
          <button class="btn btn-dark" data-act="buy-cert">Buy gift certificate</button>
        </div>

        <h2 class="bk-title" style="margin-top:30px">Check your balance</h2>
        <p class="bk-sub">Enter your package or gift card code.</p>
        <div class="bk-form" style="max-width:360px">
          <label>Code<input id="bal-code" placeholder="e.g. 7783 3240 7511 0397"></label>
          <button class="btn btn-dark" data-act="check">Check balance</button>
          <div id="bal-result"></div>
        </div>
      </div>`;
  }

  async function renderPurchase(kind, item) {
    // kind: 'package' | 'certificate'
    trackBeginCheckout(kind, item);
    const title = kind === 'package' ? item.name : `Gift certificate · ${money(item.amountCents)}`;
    root.innerHTML = `
      <div class="bk-card">
        <button class="bk-back" data-act="home">‹ Back</button>
        <span class="eyebrow">Checkout</span>
        <h2 class="bk-title">${title}</h2>
        <p class="bk-sub">Pay securely by card. You'll get a code instantly.</p>
        <form id="pay-form" class="bk-form">
          <label>Full name<input name="name" required autocomplete="name"></label>
          <label>Email<input name="email" type="email" required autocomplete="email"></label>
          <label>Card</label>
          <div id="card-container" style="padding:4px 0"></div>
          <div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div>
          <button type="submit" class="btn btn-gold bk-submit">Pay ${kind === 'package' ? money(item.priceCents) : money(item.amountCents)}</button>
          <div class="bk-error" id="pay-err" hidden></div>
        </form>
      </div>`;
    renderTurnstile();

    // init Square card
    try {
      await loadSdk(state.payCfg.env);
      const payments = window.Square.payments(state.payCfg.applicationId, state.payCfg.locationId);
      state.card = await payments.card();
      await state.card.attach('#card-container');
    } catch (e) {
      showErr('pay-err', 'Payment form failed to load: ' + e.message);
    }

    document.getElementById('pay-form').addEventListener('submit', (e) => onPay(e, kind, item));
  }

  async function onPay(e, kind, item) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('.bk-submit');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Processing…';
    hideErr('pay-err');
    try {
      const result = await state.card.tokenize();
      if (result.status !== 'OK') throw new Error('Card was not accepted. Please check the details.');
      const token = result.token;
      const tsToken = form.querySelector('[name="cf-turnstile-response"]')?.value;
      const buyer = { name: form.name.value, email: form.email.value };
      let res;
      if (kind === 'package') {
        res = await api('/api/buy-package', { packageId: item.id, paymentToken: token, buyer, turnstileToken: tsToken, source: vsSrc() });
      } else {
        res = await api('/api/buy-certificate', { amountCents: item.amountCents, paymentToken: token, buyer, turnstileToken: tsToken, source: vsSrc() });
      }
      trackPurchase(kind, item, res);
      renderDone(kind, res);
    } catch (e2) {
      showErr('pay-err', e2.message); btn.disabled = false; btn.textContent = label;
    }
  }

  function renderDone(kind, res) {
    const code = (res.gan || '').replace(/(\d{4})(?=\d)/g, '$1 ');
    const detail = kind === 'package'
      ? `<div>${res.name}</div><div><b>${res.sessions} sessions</b> · valid until ${new Date(res.expiresAt).toLocaleDateString()}</div>`
      : `<div>Gift certificate</div><div><b>${money(res.balanceCents)}</b> balance</div>`;
    root.innerHTML = `
      <div class="bk-card">
        <span class="eyebrow">Confirmed</span>
        <h2 class="bk-title">Purchase complete 🎉</h2>
        <div class="bk-summary bk-summary-done">
          ${detail}
          <div style="margin-top:8px">Your code:</div>
          <div style="font-size:22px;letter-spacing:2px"><b>${code}</b></div>
        </div>
        <p class="bk-sub">Save this code. Use it at booking (for packages) or share it (gift certificate). A copy was sent to your email.</p>
        <a href="booking.html" class="btn btn-gold" style="display:inline-block">Book a session</a>
        <button class="btn btn-dark" data-act="home" style="margin-left:8px">Buy another</button>
      </div>`;
  }

  function showErr(id, msg) { const e = document.getElementById(id); if (e) { e.textContent = msg; e.hidden = false; } }
  function hideErr(id) { const e = document.getElementById(id); if (e) e.hidden = true; }

  async function checkBalance() {
    const code = (document.getElementById('bal-code').value || '').replace(/\s+/g, '');
    const box = document.getElementById('bal-result');
    if (!code) return;
    box.innerHTML = '<div class="bk-loading" style="padding:14px 0">Checking…</div>';
    try {
      const r = await api('/api/package-balance', { gan: code });
      // Остаток - главное число: человек пришёл узнать, сколько у него есть.
      // Дата словами читается лучше цифр, а строка про ритм превращает
      // остаток в план и заодно ведёт к записи прямо сейчас.
      const validUntil = r.expiresAt
        ? new Date(r.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : null;
      const isPackage = r.sessionsLeft != null;
      box.innerHTML = `<div class="bk-summary bk-balance" style="margin-top:12px">
        ${r.name ? `<div><b>${r.name}</b></div>` : ''}
        ${isPackage
          ? `<div class="bk-balance-count"><b>${r.sessionsLeft}</b> of ${r.sessionsTotal} sessions left</div>`
          : `<div class="bk-balance-count"><b>${money(r.balanceCents)}</b> balance</div>`}
        <div class="bk-balance-meta">${isPackage ? `Balance ${money(r.balanceCents)}` : 'Gift certificate'}${validUntil ? ` · valid until ${validUntil}` : ''}${r.state !== 'ACTIVE' ? ` · ${r.state}` : ''}</div>
        ${isPackage && r.sessionsLeft > 0 ? '<div class="bk-balance-meta">Ivan recommends one session every 4 weeks.</div>' : ''}
        ${r.sessionsLeft !== 0 && r.state === 'ACTIVE'
          ? `<a href="booking.html${isPackage ? '?service=full-body-reset&master=ivan' : ''}" class="btn btn-gold" style="display:inline-block;margin-top:10px" data-track="booking">${isPackage ? 'Book your next session' : 'Book an appointment'} &rarr;</a>`
          : ''}
      </div>`;
    } catch (e) {
      box.innerHTML = `<div class="bk-error" style="margin-top:12px">${e.message}</div>`;
    }
  }

  // ── events ─────────────────────────────────────────────────────────
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'home') return renderHome();
    if (act === 'buy-pkg') { const p = state.packages.find((x) => x.id === t.dataset.id); return renderPurchase('package', p); }
    if (act === 'buy-cert') {
      const dollars = Number(document.getElementById('cert-amt').value || 0);
      const amountCents = Math.round(dollars * 100);
      if (amountCents < state.certificate.minCents || amountCents > state.certificate.maxCents) {
        return showErr('bal-result', `Amount must be ${money(state.certificate.minCents)}–${money(state.certificate.maxCents)}`);
      }
      return renderPurchase('certificate', { amountCents });
    }
    if (act === 'check') return checkBalance();
  });

  // ── boot ───────────────────────────────────────────────────────────
  (async function init() {
    try {
      const [cfg, pk] = await Promise.all([api('/api/payment-config'), api('/api/packages')]);
      state.payCfg = cfg; state.packages = pk.packages; state.certificate = pk.certificate;
      const wantPkg = new URLSearchParams(location.search).get('pkg');
      const pre = wantPkg && state.packages.find((p) => p.id === wantPkg);
      if (pre) renderPurchase('package', pre); else renderHome();
    } catch (e) {
      root.innerHTML = `<div class="bk-card"><div class="bk-error">Store is temporarily unavailable (${e.message}).<br>Please call (754) 202-6666.</div></div>`;
    }
  })();
})();
