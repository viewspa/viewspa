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

  // Всё, что попадает в разметку через шаблонную строку, проходит здесь.
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    // Ценность конверсии - фактически списанная сумма, вместе с чаевыми:
    // это реальные деньги, и по ним Ads считает окупаемость. Цена позиции
    // ниже остаётся ценой самого пакета.
    const d = {
      transaction_id: gan,
      value: Number((((res && (res.totalCents || res.balanceCents)) || 0) / 100).toFixed(2)),
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

  // ── Чаевые при покупке пакета ─────────────────────────────────────
  // Пакет оплачивается один раз, а потом человек просто приходит: момента
  // оплаты на визите нет, а значит нет и привычного момента для чаевых.
  // Поэтому предлагаем их здесь - и считаем ЗА СЕАНС, а не процентом от
  // чека: «$15 за сеанс» читается как обычные чаевые, а «20% от $590» -
  // как ещё одна крупная сумма поверх крупной.
  const TIP_PER_SESSION = [10, 15, 20];

  function tipBlock(item) {
    // Суммы на чипах - за сеанс, без итога рядом: «$15 · $120» непонятно,
    // какое из чисел за что. Итог показываем отдельной строкой ниже, уже
    // умножением - и только после выбора, чтобы $160 не пугало заранее.
    const chips = TIP_PER_SESSION.map((v) => `
      <button type="button" class="bk-chip" data-tip="${v}" aria-pressed="false">$${v}</button>`).join('');
    return `
      <fieldset class="bk-tip">
        <legend>Tip for Ivan <span class="bk-tip-opt">— optional</span></legend>
        <p class="bk-tip-note">You're paying for all ${item.sessions} sessions today, so there's no bill at the end of each visit. If you'd like to leave something, add it here.</p>
        <p class="bk-tip-per">Per session:</p>
        <div class="bk-intake-chips">
          ${chips}
          <button type="button" class="bk-chip" data-tip="custom" aria-pressed="false">Other</button>
          <button type="button" class="bk-chip" data-tip="0" aria-pressed="false">No thanks</button>
        </div>
        <label class="bk-tip-custom" hidden>Total tip (USD)
          <input name="tipCustom" type="number" min="0" max="${Math.floor(item.priceCents / 200)}" step="5" inputmode="numeric">
        </label>
        <p class="bk-tip-math" aria-live="polite" hidden></p>
      </fieldset>`;
  }

  // Сертификат почти всегда дарят, поэтому спрашиваем имена: они попадут
  // на карточку в письме. Оба поля необязательные - если человек покупает
  // себе, строка на карточке просто не появится.
  // Оформление карточки. Порядок и названия должны совпадать со списком
  // в воркере: он принимает только эти три значения.
  const GIFT_DESIGNS = [
    { id: 'botanical', label: 'Botanical' },
    { id: 'engraved', label: 'Engraved' },
    { id: 'seal', label: 'Seal' },
    { id: 'night', label: 'Night' },
  ];

  // Украшение карточки: рамки, уголки и ветка. Разметка одна на все
  // оформления, а показывает каждое только своё — так макет не
  // переписывается при смене оформления.
  const CORNER = (pos) => `
    <svg class="gc-corner gc-corner-${pos}" viewBox="0 0 30 30" aria-hidden="true"
         fill="none" stroke="#c9a84c" stroke-width="1">
      <path d="M0 24 A24 24 0 0 0 24 0"></path>
      <path d="M0 17 A17 17 0 0 0 17 0"></path>
      <path d="M0 10 A10 10 0 0 0 10 0"></path>
      <circle cx="4" cy="4" r="1.6" fill="#c9a84c" stroke="none"></circle>
    </svg>`;

  const DECO = `
    <div class="gc-deco" aria-hidden="true">
      <span class="gc-f1"></span>
      <span class="gc-f2"></span>
      <svg class="gc-sprig" viewBox="0 0 156 60" fill="none"
           stroke="currentColor" stroke-width="1" stroke-linecap="round">
        <path d="M152 26 C 116 20, 66 38, 8 34"></path>
        <g transform="translate(136 23) rotate(-150)"><path d="M0 0 C5 -5.5 15 -5.5 21 0 C15 5.5 5 5.5 0 0Z"></path><path d="M3 0 H17"></path></g>
        <g transform="translate(122 23) rotate(152)"><path d="M0 0 C5 -5.5 15 -5.5 21 0 C15 5.5 5 5.5 0 0Z"></path><path d="M3 0 H17"></path></g>
        <g transform="translate(104 25) rotate(-142)"><path d="M0 0 C5 -5.5 15 -5.5 21 0 C15 5.5 5 5.5 0 0Z"></path><path d="M3 0 H17"></path></g>
        <g transform="translate(88 28) rotate(146)"><path d="M0 0 C5 -5.5 15 -5.5 21 0 C15 5.5 5 5.5 0 0Z"></path><path d="M3 0 H17"></path></g>
        <g transform="translate(68 31) rotate(-148)"><path d="M0 0 C5 -5.5 15 -5.5 21 0 C15 5.5 5 5.5 0 0Z"></path><path d="M3 0 H17"></path></g>
        <g transform="translate(50 33) rotate(150)"><path d="M0 0 C5 -5.5 15 -5.5 21 0 C15 5.5 5 5.5 0 0Z"></path><path d="M3 0 H17"></path></g>
        <g transform="translate(30 34) rotate(-158)"><path d="M0 0 C4 -4.5 12 -4.5 17 0 C12 4.5 4 4.5 0 0Z"></path><path d="M3 0 H13"></path></g>
        <g transform="translate(9 34) rotate(184)"><path d="M0 0 C3 -4 10 -4 14 0 C10 4 3 4 0 0Z"></path></g>
        <path d="M96 27 L94 39"></path><circle cx="94" cy="42" r="3" fill="#c9a84c" stroke="none"></circle>
        <path d="M60 33 L63 45"></path><circle cx="63.5" cy="48" r="3" fill="#c9a84c" stroke="none"></circle>
        <path d="M114 23 L118 11"></path><circle cx="119" cy="8" r="2.6" fill="#c9a84c" stroke="none"></circle>
      </svg>
      ${CORNER('tl')}${CORNER('tr')}${CORNER('br')}${CORNER('bl')}
    </div>`;

  // Повод — отдельная ось от оформления. У прописи заголовок в две строки,
  // поэтому у каждого повода есть и обычная формулировка, и пара слов.
  // Список и порядок должны совпадать с воркером: он принимает только их.
  const GIFT_OCCASIONS = [
    { id: 'none', label: 'No occasion', line: 'This is a gift for you', script: ['gift', 'for you'], path: '' },
    { id: 'birthday', label: 'Birthday', line: 'Happy Birthday', script: ['happy', 'birthday'],
      path: 'M16 28V13M16 13c0-3 3-4 3-7 0 0 3 3 3 6s-3 4-6 4-6-1-6-4 3-6 3-6c0 3 3 4 3 7z' },
    { id: 'love', label: 'With love', line: 'With love', script: ['with', 'love'],
      path: 'M16 27C9 22 4 18 4 12.5A6 6 0 0 1 16 9a6 6 0 0 1 12 3.5C28 18 23 22 16 27z' },
    { id: 'thanks', label: 'Thank you', line: 'Thank you', script: ['thank', 'you'],
      path: 'M5 22c7 3 15 0 19-7M9 21c-2-7 2-13 8-15M17 6c4 4 5 10 3 15' },
    { id: 'holiday', label: 'Holidays', line: 'Happy Holidays', script: ['happy', 'holidays'],
      path: 'M16 4v24M5 11l22 10M27 11L5 21M16 4l-4 4M16 4l4 4M16 28l-4-4M16 28l4-4' },
  ];

  /**
   * Макет подарка, на котором сразу и вводят данные.
   *
   * Отдельная форма под картинкой заставляла бы человека переводить
   * взгляд и догадываться, как это будет выглядеть. Здесь поля стоят
   * там же, где потом окажется текст, - что набрал, то и получится.
   *
   * У сертификата и пакета имя получателя значит разное: на сертификате
   * это надпись, а пакет именной - сеансами пользуется тот, чьё имя
   * указано. Поэтому подписи разные.
   */
  function giftNames(kind, item) {
    const pkg = kind === 'package';
    const amount = money(pkg ? item.priceCents : item.amountCents);
    // Пакет чаще покупают себе, поэтому подарочной обвязки на нём нет:
    // ни «это подарок для тебя», ни строки «от кого». Остаётся одно поле
    // с именем — по нему мы знаем, чьи это сеансы.
    // У пакета берём название из каталога — там уже сказано и сколько
    // сеансов, и по сколько минут: «4 Massage Sessions (60 min each)».
    const sub = pkg ? item.name : 'Nails or massage';
    // У пакета строки над суммой нет вовсе: «4 massage sessions» рядом
    // с ценой говорит то же самое, а вторая строка только шумит.
    const kicker = 'This is a gift for you';

    return `
      <fieldset class="bk-gift">
        <legend>${pkg ? 'Whose sessions are these?' : 'Make it a gift'}</legend>
        <p class="bk-gift-note">${pkg
          ? 'Type straight onto the card. Buying it for someone else? Put their name here — the sessions belong to whoever is named.'
          : 'Type straight onto the card. This is exactly what they will see.'}</p>

        <div class="gc ${pkg ? 'gc-formal' : 'gc-botanical'}" id="gc-preview">
          ${DECO}
          <div class="gc-head">
            <div class="gc-head-left">
              <div class="gc-logo" role="img" aria-label="View Spa"></div>
              ${pkg ? '' : `
              <p class="gc-kicker">
                <svg class="gc-mark" viewBox="0 0 32 32" aria-hidden="true" hidden><path d=""/></svg>
                <span class="gc-occ-1">${kicker}</span>
              </p>`}
            </div>
            <div class="gc-head-right">
              <p class="gc-amount"><span class="gc-cur">$</span>${esc(amount.replace('$', ''))}</p>
              <p class="gc-amount-sub">${esc(sub)}</p>
            </div>
          </div>
          <div class="gc-divider"><span class="gc-diamond"></span></div>
          <div class="gc-fields">
            <label class="gc-name">
              <span class="gc-name-lbl">${pkg ? 'Name' : 'For'}</span>
              <input class="gc-name-val" name="forName" maxlength="40"
                     placeholder="${pkg ? 'your name' : 'their name'}" autocomplete="off">
            </label>
            ${pkg ? '' : `
            <label class="gc-name">
              <span class="gc-name-lbl">From</span>
              <input class="gc-name-val" name="fromName" maxlength="40"
                     placeholder="your name" autocomplete="off">
            </label>`}
          </div>
          ${pkg ? `
          <ol class="gc-sessions">
            ${Array.from({ length: item.sessions }, (_, i) => `
              <li class="gc-session">
                <span class="gc-session-no">${i + 1}</span>
                <span class="gc-session-date"></span>
              </li>`).join('')}
          </ol>
          <p class="gc-sessions-note">Each visit is stamped here automatically &mdash;
            the card above is live, so it always shows what is left.</p>` : `
          <textarea class="gc-msg" name="message" rows="1" maxlength="120"
                    placeholder="a line for them (optional)"></textarea>`}
          <p class="gc-howto">${pkg
            ? 'To book, open viewspa.miami, pick a date and time with Ivan, and enter the code in &ldquo;Package or gift certificate code&rdquo;. One session comes off automatically.'
            : 'To book, open viewspa.miami, pick a date and time, and enter the code in &ldquo;Package or gift certificate code&rdquo;.'}</p>
          <div class="gc-foot">
            <p class="gc-addr">20200 W Dixie Hwy, STE 1105B<br>Aventura, FL 33180 &middot; (754) 202-6666</p>
            <p class="gc-codebox">
              <span class="gc-code-lbl">Gift code</span>
              <span class="gc-code">in your email</span>
            </p>
          </div>
        </div>

        ${pkg ? `
        <input type="hidden" name="design" value="formal">` : `
        <div class="gc-picker" role="group" aria-label="Card design">
          ${GIFT_DESIGNS.map((d, i) => `
            <button type="button" class="gc-swatch gc-swatch-${d.id}"
                    data-design="${d.id}" aria-pressed="${i === 0}">${d.label}</button>`).join('')}
        </div>
        <input type="hidden" name="design" value="${GIFT_DESIGNS[0].id}">

        `}
        ${pkg ? '' : `
        <div class="gc-occasions" role="group" aria-label="Occasion">
          ${GIFT_OCCASIONS.map((o, i) => `
            <button type="button" class="gc-occ-btn"
                    data-occasion="${o.id}" aria-pressed="${i === 0}">${o.label}</button>`).join('')}
        </div>
        <input type="hidden" name="occasion" value="${GIFT_OCCASIONS[0].id}">`}
      </fieldset>`;
  }

  /** Переключение оформления и повода плюс подгонка высоты пожелания. */
  function wireGiftPreview(form) {
    const card = form.querySelector('#gc-preview');
    if (!card) return;
    const designInput = form.querySelector('[name="design"]');
    const occInput = form.querySelector('[name="occasion"]');

    // Высоту пожелания пересчитываем и при смене оформления: у каждого
    // своя ширина колонки, и строка, занимавшая одну строку, может стать
    // двумя. Без этого поле оставалось с устаревшей высотой.
    function fitMessage() {
      const t = form.querySelector('[name="message"]');
      if (!t) return;
      t.style.height = 'auto';
      t.style.height = t.scrollHeight + 'px';
    }

    const line1 = card.querySelector('.gc-occ-1');
    const mark = card.querySelector('.gc-mark');

    // Повод - одна строка капсом плюс значок. Оформление на неё не
    // влияет, но перерисовываем и при смене оформления: у тёмной
    // карточки другой цвет, и значок надо переставить вместе с ним.
    function paintOccasion() {
      // У пакета повода нет: в шапке стоит «Prepaid package», и
      // перекрашивать её в «это подарок для тебя» нельзя.
      if (!occInput) return;
      const occ = GIFT_OCCASIONS.find((o) => o.id === occInput.value) || GIFT_OCCASIONS[0];
      line1.textContent = occ.line;
      mark.firstElementChild.setAttribute('d', occ.path);
      mark.hidden = !occ.path;
    }

    form.querySelectorAll('.gc-swatch').forEach((b) => {
      b.addEventListener('click', () => {
        form.querySelectorAll('.gc-swatch').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        card.className = 'gc gc-' + b.dataset.design;
        designInput.value = b.dataset.design;
        paintOccasion();
        fitMessage();
      });
    });

    form.querySelectorAll('.gc-occ-btn').forEach((b) => {
      b.addEventListener('click', () => {
        form.querySelectorAll('.gc-occ-btn').forEach((x) => x.setAttribute('aria-pressed', 'false'));
        b.setAttribute('aria-pressed', 'true');
        occInput.value = b.dataset.occasion;
        paintOccasion();
      });
    });

    paintOccasion();

    const msg = form.querySelector('[name="message"]');
    if (msg) {
      msg.addEventListener('input', fitMessage);
      fitMessage();
    }
  }

  async function renderPurchase(kind, item) {
    // kind: 'package' | 'certificate'
    trackBeginCheckout(kind, item);
    const title = kind === 'package' ? item.name : `Gift certificate · ${money(item.amountCents)}`;
    const baseCents = kind === 'package' ? item.priceCents : item.amountCents;
    root.innerHTML = `
      <div class="bk-card">
        <button class="bk-back" data-act="home">‹ Back</button>
        <span class="eyebrow">Checkout</span>
        <h2 class="bk-title">${title}</h2>
        <p class="bk-sub">Pay securely by card. You'll get a code instantly.</p>
        <form id="pay-form" class="bk-form">
          <label>Full name<input name="name" required autocomplete="name"></label>
          <label>Email<input name="email" type="email" required autocomplete="email"></label>
          <label>Phone <span class="bk-opt">optional</span><input name="phone" type="tel" maxlength="32" autocomplete="tel" placeholder="So we can reach you about your booking"></label>
          ${giftNames(kind, item)}
          ${kind === 'package' ? tipBlock(item) : ''}
          <label>Card</label>
          <div id="card-container" style="padding:4px 0"></div>
          <div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div>
          <button type="submit" class="btn btn-gold bk-submit">Pay ${money(baseCents)}</button>
          <p class="bk-sub bk-legal">Card details go straight to Square - we never see them.
            Buying means accepting our
            <a href="refund-policy.html" target="_blank" rel="noopener">refund policy</a>.
            <a href="privacy-policy.html" target="_blank" rel="noopener">Privacy policy</a></p>
          <div class="bk-error" id="pay-err" hidden></div>
        </form>
      </div>`;
    renderTurnstile();
    wireGiftPreview(document.getElementById('pay-form'));
    if (kind === 'package') bindTip(item, baseCents);

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

  // Сколько чаевых выбрано сейчас, в центах. Единственный источник правды:
  // и кнопка оплаты, и запрос на сервер читают отсюда.
  function tipCents(item) {
    const form = document.getElementById('pay-form');
    if (!form) return 0;
    const picked = form.querySelector('.bk-chip[aria-pressed="true"]');
    if (!picked) return 0;
    if (picked.dataset.tip === 'custom') {
      const v = Math.max(0, Math.round(Number(form.tipCustom.value) || 0));
      return Math.min(v, Math.floor(item.priceCents / 200)) * 100;
    }
    return Number(picked.dataset.tip) * item.sessions * 100;
  }

  function bindTip(item, baseCents) {
    const form = document.getElementById('pay-form');
    const btn = form.querySelector('.bk-submit');
    const custom = form.querySelector('.bk-tip-custom');
    const math = form.querySelector('.bk-tip-math');

    // Строка с умножением - главное место, где становится ясно, что «$15»
    // это за сеанс, а не за весь пакет. Кнопка оплаты показывает итог,
    // эта строка - как он получился.
    const sync = () => {
      const tip = tipCents(item);
      btn.textContent = 'Pay ' + money(baseCents + tip);
      const picked = form.querySelector('.bk-chip[aria-pressed="true"]');
      const per = picked && /^\d+$/.test(picked.dataset.tip) ? Number(picked.dataset.tip) : 0;
      if (tip > 0 && per > 0) {
        math.textContent = `$${per} × ${item.sessions} sessions = ${money(tip)}`;
      } else if (tip > 0) {
        math.textContent = `${money(tip)} total · ${money(Math.round(tip / item.sessions))} per session`;
      }
      math.hidden = tip <= 0;
    };

    form.querySelectorAll('.bk-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const on = chip.getAttribute('aria-pressed') === 'true';
        form.querySelectorAll('.bk-chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
        chip.setAttribute('aria-pressed', on ? 'false' : 'true');
        const isCustom = !on && chip.dataset.tip === 'custom';
        custom.hidden = !isCustom;
        if (isCustom) form.tipCustom.focus();
        sync();
      });
    });
    form.tipCustom.addEventListener('input', sync);
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
      const buyer = {
        name: form.name.value,
        email: form.email.value,
        // Необязательно: на самом дорогом экране сайта лишнее обязательное
        // поле стоит дороже, чем польза от него. Кто хочет - впишет.
        phone: (form.querySelector('[name="phone"]')?.value || '').trim(),
      };
      // Имена нужны обоим: на сертификате это надпись, в пакете - кто
      // именно имеет право на сеансы.
      const gift = {
        forName: (form.querySelector('[name="forName"]')?.value || '').trim(),
        fromName: (form.querySelector('[name="fromName"]')?.value || '').trim(),
        message: (form.querySelector('[name="message"]')?.value || '').trim(),
        design: (form.querySelector('[name="design"]')?.value || '').trim(),
        occasion: (form.querySelector('[name="occasion"]')?.value || '').trim(),
      };
      let res;
      if (kind === 'package') {
        res = await api('/api/buy-package', {
          packageId: item.id, paymentToken: token, buyer,
          turnstileToken: tsToken, source: vsSrc(), tipCents: tipCents(item),
          ...gift,
        });
      } else {
        res = await api('/api/buy-certificate', {
          amountCents: item.amountCents, paymentToken: token, buyer,
          turnstileToken: tsToken, source: vsSrc(),
          ...gift,
        });
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
      ? `<div>${res.name}</div><div><b>${res.sessions} sessions</b> · no expiry date</div>`
        + (res.tipCents > 0 ? `<div class="bk-tip-note">Includes a ${money(res.tipCents)} tip for Ivan · charged ${money(res.totalCents)} today</div>` : '')
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
      // Срока у пакета нет, поэтому вместо даты - строка про ритм: она
      // превращает остаток в план и ведёт к записи прямо сейчас.
      const isPackage = r.sessionsLeft != null;
      box.innerHTML = `<div class="bk-summary bk-balance" style="margin-top:12px">
        ${r.name ? `<div><b>${r.name}</b></div>` : ''}
        ${isPackage
          ? `<div class="bk-balance-count"><b>${r.sessionsLeft}</b> of ${r.sessionsTotal} sessions left</div>`
          : `<div class="bk-balance-count"><b>${money(r.balanceCents)}</b> balance</div>`}
        <div class="bk-balance-meta">${isPackage ? `Balance ${money(r.balanceCents)}` : 'Gift certificate'} · no expiry date${r.state !== 'ACTIVE' ? ` · ${r.state}` : ''}</div>
        ${isPackage && r.sessionsLeft > 0 ? '<div class="bk-balance-meta">Ivan recommends a session at least once every 4 weeks.</div>' : ''}
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
