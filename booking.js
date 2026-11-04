/**
 * View Spa - booking flow (front-end).
 * Шаги: Category → Subcategory → Service → Master/Any → Date&Time → Details → Done.
 * Общается с Cloudflare Worker (см. CONFIG.apiBase).
 */
(function () {
  'use strict';

  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const CONFIG = {
    // Локально - wrangler dev; на проде - URL воркера (заполнить после деплоя).
    apiBase: isLocal ? 'http://localhost:8787' : 'https://viewspa-booking.ivanseydametov.workers.dev',
    // На localhost - тестовый site key Turnstile (всегда проходит, для разработки),
    // на проде - реальный публичный site key.
    turnstileSiteKey: isLocal ? '1x00000000000000000000AA' : '0x4AAAAAADdzLSWcgv1JlXj3',
    // насколько далеко вперёд можно листать календарь (Square отдаёт
    // максимум 32 дня за запрос, поэтому тянем помесячно и кешируем)
    monthsAhead: 3,
    soonestCount: 6,
    locale: 'en-US',
    dowLabels: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
  };

  // Зоны для интейка на массаж. Порядок - от самых частых обращений к профилактике.
  const MASSAGE_CONCERNS = [
    'Lower back',
    'Neck & shoulders',
    'Upper back',
    'Hips & legs',
    'After training',
    'Nothing specific - maintenance',
  ];

  const state = {
    business: null,
    masters: null,
    categories: null,
    step: 'category',
    categoryId: null,
    subcategoryId: null,
    serviceId: null,
    masterId: null, // null = «любой/сравнить»
    preferMaster: null, // запись «к конкретному мастеру»: меню урезано до его услуг
    length: null, // выбранная длина (short/medium/long) для услуг с длинами
    second: null, // вторая услуга подряд: { serviceId, masterId, length }
    xPick: null,  // что сейчас выбираем для второй услуги: { serviceId, masterId }
    design: { hands: null, feet: null }, // выбранный дизайн: отдельно руки и ноги
    slot: null,
    selectedDay: null,
    monthCursor: null,   // {y, m} - какой месяц показан в календаре
    monthCache: {},      // '2026-08' -> { '2026-08-14': [slot, ...] }
  };

  const root = document.getElementById('booking-app');

  // ── helpers ────────────────────────────────────────────────────────
  const fmtMoney = (n) => '$' + n;
  const fmtDur = (min) => {
    const h = Math.floor(min / 60), m = min % 60;
    return (h ? `${h} hr ` : '') + (m ? `${m} min` : '').trim() || `${min} min`;
  };
  const tz = () => state.business?.timezone || 'America/New_York';
  const dayKey = (iso) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const dayLabel = (iso) =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
  const timeLabel = (iso) =>
    new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

  function getService(id) {
    for (const cat of state.categories)
      for (const sub of cat.subcategories)
        for (const svc of sub.services) if (svc.id === id) return { ...svc, cat, sub };
    return null;
  }
  // ── Запись к конкретному мастеру ────────────────────────────────────
  // Клик по карточке мастера открывает меню записи, где остались только его
  // услуги, а сам мастер уже выбран: шаг «Specialist» пропускается. Комбо на
  // двух мастеров остаётся у каждого из двух.
  // Услуги, которые в меню конкретного мастера не показываем, хотя он в них
  // участвует: { ksenia: ['id-услуги'] }. Сейчас пусто - комбо «маникюр +
  // педикюр» показываются и в общем меню, и в меню каждого из двух мастеров.
  const HIDDEN_IN_MASTER_MENU = {};
  const masterDoes = (svc, id) => {
    if ((HIDDEN_IN_MASTER_MENU[id] || []).includes(svc.id)) return false;
    return svc.dualMaster
      ? svc.dualMaster.some((s) => s.masterId === id)
      : (svc.masters || []).some((m) => m.masterId === id);
  };
  const visibleServices = (sub) => state.preferMaster
    ? sub.services.filter((s) => masterDoes(s, state.preferMaster))
    : sub.services;
  // Подразделы и разделы без услуг мастера пропадают, а не показываются пустыми.
  const visibleSubs = (cat) => cat.subcategories
    .map((s) => ({ ...s, services: visibleServices(s) }))
    .filter((s) => s.services.length);
  const visibleCats = () => state.categories
    .map((c) => ({ ...c, subcategories: visibleSubs(c) }))
    .filter((c) => c.subcategories.length);
  const nServices = (n) => `${n} service${n === 1 ? '' : 's'}`;

  /** Строка над меню: напоминает, к кому идёт запись, и даёт выйти из режима. */
  function masterBanner() {
    const m = state.preferMaster && state.masters && state.masters[state.preferMaster];
    if (!m) return '';
    return `<p class="bk-pref">Booking with <b>${m.name}</b> · `
      + `<button type="button" class="bk-pref-clear" data-act="allmasters">Show all specialists</button></p>`;
  }

  function priceRange(svc) {
    if (svc.dualMaster) return fmtMoney(svc.price);
    const ps = svc.masters.map((m) => m.price);
    const lo = Math.min(...ps), hi = Math.max(...ps);
    return lo === hi ? fmtMoney(lo) : `${fmtMoney(lo)} - ${fmtMoney(hi)}`;
  }

  // ── GA4 трекинг (конверсии по услугам) ──────────────────────────────
  function track(name, params) {
    if (typeof window.gtag === 'function') {
      try { window.gtag('event', name, params || {}); } catch (_) {}
    }
  }
  function gaItem() {
    const svc = getService(state.serviceId);
    if (!svc) return null;
    const masterName = state.slot
      ? state.masters[state.slot.masterId]?.name
      : (state.masterId ? state.masters[state.masterId]?.name : 'any');
    return {
      item_id: svc.id,
      item_name: svc.name,
      item_category: svc.cat?.name,
      item_category2: svc.sub?.name,
      item_variant: masterName,
      price: state.slot?.price,
      quantity: 1,
    };
  }

  // ── Захват gclid/gbraid/wbraid (для офлайн-конверсий Google Ads) ────
  function captureClickIds() {
    try {
      const p = new URLSearchParams(location.search);
      ['gclid', 'gbraid', 'wbraid'].forEach((k) => {
        const v = p.get(k);
        if (v) localStorage.setItem('vs_' + k, JSON.stringify({ v, t: Date.now() }));
      });
    } catch (_) {}
  }
  function storedClickId(k) {
    try {
      const o = JSON.parse(localStorage.getItem('vs_' + k) || 'null');
      if (!o || Date.now() - o.t > 90 * 86400000) return null; // окно 90 дней
      return o.v;
    } catch (_) { return null; }
  }

  // Логируем РЕАЛЬНУЮ потерю денежной конверсии - громко в консоль и best-effort в воркер.
  // sendBeacon переживает уход со страницы и не блокирует UI. Тихие потери - ровно то,
  // из-за чего выручка приходила в GA4 без источника; пусть каждая падает в лог.
  function logConvIssue(reason, d, err) {
    try { console.error('CONVERSION_ISSUE:', reason, d || {}, err || ''); } catch (_) {}
    try {
      const payload = JSON.stringify({
        reason,
        booking_id: (d && d.booking_id) || null,
        value: (d && d.value) || null,
        message: (err && err.message) || undefined,
        url: location.href,
        ua: navigator.userAgent,
        t: Date.now(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(CONFIG.apiBase + '/api/log-conversion', new Blob([payload], { type: 'application/json' }));
      }
    } catch (_) {}
  }

  // Конверсии по факту успешной брони - строго один раз на booking_id (дедупликация).
  // Шлём три события с клиента, где живёт настоящая кука _ga (правильная атрибуция к google/cpc):
  // 1) booking_completed - GA4 key event (отчёты по услугам)
  // 2) purchase - GA4 ecommerce (серверный Measurement Protocol отключён)
  // 3) conversion - Google Ads, привязка к gclid из куки _gcl_aw
  // Обёрнуто целиком: сбой трекинга не должен ломать экран «You're booked!».
  function trackBookingCompleted(d, item) {
    try {
      if (!d || !d.booking_id) return;
      try {
        const done = JSON.parse(sessionStorage.getItem('vs_bk_done') || '[]');
        if (done.includes(d.booking_id)) return; // уже засчитано
        done.push(d.booking_id);
        sessionStorage.setItem('vs_bk_done', JSON.stringify(done.slice(-30)));
      } catch (_) {}

      // Оплата подтверждена - грузим gtag немедленно, не ждём 3-сек таймер, иначе
      // денежная конверсия может не успеть уйти до ухода со страницы.
      try { if (typeof window.vsEnsureAnalytics === 'function') window.vsEnsureAnalytics(); } catch (_) {}

      try { console.log('booking_completed →', d); } catch (_) {}

      // 1) GA4 key event
      if (typeof window.gtag === 'function') {
        window.gtag('event', 'booking_completed', d);
      } else {
        logConvIssue('gtag_unavailable_booking_completed', d);
      }
      // На случай, если позже появится GTM-контейнер - продублируем в dataLayer как custom event.
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: 'booking_completed' }, d));

      // 2) GA4 purchase - на клиенте. transaction_id = booking_id (дедуп с любым серверным событием).
      try {
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'purchase', {
            transaction_id: d.booking_id,
            value: Number(d.value) || 0,
            currency: d.currency || 'USD',
            items: item ? [item] : undefined,
          });
        } else {
          logConvIssue('gtag_unavailable_purchase', d);
        }
      } catch (err) { logConvIssue('purchase_threw', d, err); }

      // 3) Google Ads конверсия - привязка к gclid из куки _gcl_aw.
      try {
        const sendTo = window.VS_ADS_CONVERSION;
        if (!sendTo) {
          // Тег ещё не заведён маркетологом - ожидаемое состояние, не потеря конверсии.
          try { console.info('ads conversion skipped: VS_ADS_CONVERSION not set yet →', d.booking_id); } catch (_) {}
        } else if (typeof window.gtag === 'function') {
          window.gtag('event', 'conversion', {
            send_to: sendTo,
            value: Number(d.value) || 0,
            currency: d.currency || 'USD',
            transaction_id: d.booking_id,
          });
        } else {
          logConvIssue('gtag_unavailable_ads_conversion', d);
        }
      } catch (err) { logConvIssue('ads_conversion_threw', d, err); }
    } catch (err) {
      logConvIssue('track_booking_completed_threw', d, err);
    }
  }

  // Состояние Turnstile для текущей формы (виджет одноразовый - токен живёт до одной отправки).
  const ts = { widgetId: null, token: null, failed: false };

  // Не блокирующее предупреждение в #bk-form-err: капча сбоит, но форму не запираем.
  function formNotice(msg, show = true) {
    const e = document.getElementById('bk-form-err');
    if (!e) return;
    if (msg != null) e.textContent = msg;
    e.hidden = !show;
  }

  // Текущий токен капчи: из callback, либо напрямую из виджета / скрытого поля.
  function turnstileToken(form) {
    if (ts.token) return ts.token;
    try {
      if (window.turnstile && ts.widgetId != null) {
        const t = window.turnstile.getResponse(ts.widgetId);
        if (t) return t;
      }
    } catch (_) {}
    return form?.querySelector('[name="cf-turnstile-response"]')?.value || '';
  }

  // Сброс виджета после неудачной отправки - иначе одноразовый токен «протух».
  function resetTurnstile() {
    ts.token = null;
    try { if (window.turnstile && ts.widgetId != null) window.turnstile.reset(ts.widgetId); }
    catch (_) {}
  }

  // Рендер Turnstile с ожиданием загрузки скрипта (виджет на динамической форме).
  // appearance:'interaction-only' - чекбокс не показываем, пока он реально не нужен.
  function renderTurnstile() {
    if (!CONFIG.turnstileSiteKey) return;
    const el = root.querySelector('.cf-turnstile');
    if (!el || el.dataset.rendered === '1') return;
    ts.widgetId = null; ts.token = null; ts.failed = false;
    let tries = 0;
    const fail = (msg) => {
      ts.failed = true;
      formNotice(msg || 'Security check is slow to load. You can still tap Confirm - if it doesn’t go through, call or WhatsApp us and we’ll book you in.');
    };
    const tryRender = () => {
      if (window.turnstile && window.turnstile.render) {
        try {
          ts.widgetId = window.turnstile.render(el, {
            sitekey: CONFIG.turnstileSiteKey,
            appearance: 'interaction-only',
            callback: (token) => { ts.token = token; ts.failed = false; formNotice(null, false); },
            'error-callback': () => { fail('Couldn’t verify you’re human. Tap Confirm to retry, or call/WhatsApp us to book.'); return true; },
            'expired-callback': () => { resetTurnstile(); },
            'timeout-callback': () => { fail(); },
          });
          el.dataset.rendered = '1';
        } catch (_) { fail(); }
      } else if (tries++ < 60) {
        setTimeout(tryRender, 100);
      } else {
        // Скрипт Cloudflare так и не загрузился (блокировщик/сеть) - не запираем форму.
        fail('Security check couldn’t load (it may be blocked by your browser). Tap Confirm to try anyway, or call/WhatsApp us to book.');
      }
    };
    tryRender();
  }

  async function api(path, body) {
    const res = await fetch(CONFIG.apiBase + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ── progress bar ───────────────────────────────────────────────────
  const STEPS = ['category', 'service', 'master', 'time', 'details', 'done'];
  function progressHtml() {
    const labels = { category: 'Service', service: 'Choose', master: 'Specialist', time: 'Time', details: 'Details', done: 'Done' };
    // Выбор второй услуги - часть шага «Specialist»: время ещё впереди.
    const shown = state.step === 'subcategory' ? 'category'
      : (state.step === 'length' || /^x(svc|master|length)$/.test(state.step) ? 'master'
        : (state.step === 'wait' ? 'time' : state.step));
    const cur = STEPS.indexOf(shown);
    return `<div class="bk-progress">${STEPS.map((s, i) =>
      `<span class="bk-pstep ${i <= cur ? 'on' : ''}">${labels[s]}</span>`).join('<span class="bk-pline"></span>')}</div>`;
  }

  // ── Мастера над меню зависят от выбранного раздела ──────────────────
  // Пришёл с ногтевой страницы - Ivan в списке лишний; пришёл с массажной -
  // лишние мастера маникюра. На первом экране («ногти или массаж») видны все.
  // Список считаем по каталогу, чтобы он не разошёлся с самим меню.
  // Запасной вариант нужен на время, пока каталог ещё грузится: иначе ряд
  // карточек сначала рисовался бы весь, а потом дёргался.
  const CATEGORY_MASTERS_FALLBACK = { nail: ['ksenia', 'anastasia'], massage: ['ivan'] };

  function mastersOfCategory(catId) {
    if (!catId) return null;
    const cat = state.categories && state.categories.find((c) => c.id === catId);
    if (cat) {
      const ids = new Set();
      for (const sub of cat.subcategories) {
        for (const svc of sub.services) {
          (svc.masters || []).forEach((m) => ids.add(m.masterId));
          (svc.dualMaster || []).forEach((m) => ids.add(m.masterId));
        }
      }
      return ids;
    }
    return CATEGORY_MASTERS_FALLBACK[catId] ? new Set(CATEGORY_MASTERS_FALLBACK[catId]) : null;
  }

  function syncSpecialists(catId) {
    const box = document.querySelector('.bk-specialists');
    if (!box) return;
    const allowed = mastersOfCategory(catId);
    let shown = 0;
    box.querySelectorAll('a[data-master-link]').forEach((a) => {
      const show = !allowed || allowed.has(a.dataset.masterLink);
      a.hidden = !show;
      if (show) shown++;
    });
    box.dataset.count = String(shown);   // сетке в CSS нужно знать, сколько колонок
  }

  // ── история браузера ───────────────────────────────────────────────
  // Каждый новый экран записи - отдельная запись в истории, поэтому кнопка
  // «Назад» в браузере (и жест на телефоне) возвращает на шаг назад, а не
  // выкидывает со страницы. Повторная отрисовка того же шага (смена дня,
  // месяца) историю не плодит.
  let restoringKey = null;   // ключ экрана, который сейчас восстанавливает popstate

  function stepSnapshot() {
    return {
      step: state.step, categoryId: state.categoryId || null, subcategoryId: state.subcategoryId || null,
      serviceId: state.serviceId || null, masterId: state.masterId || null, length: state.length || null,
      preferMaster: state.preferMaster || null,
    };
  }
  function snapKey(s) {
    return [s.step, s.categoryId, s.subcategoryId, s.serviceId, s.masterId, s.length, s.preferMaster].join('|');
  }

  function recordStep() {
    try {
      const snap = stepSnapshot();
      const key = snapKey(snap);
      const cur = history.state && history.state.bk;
      if (restoringKey !== null || state.step === 'done' || !cur) {
        // восстановление из истории, финальный экран или первый экран страницы: запись не добавляем
        snap.n = cur ? cur.n : 0;
        restoringKey = null;
        history.replaceState({ bk: snap }, '', location.href);
      } else if (snapKey(cur) === key) {
        snap.n = cur.n;
        history.replaceState({ bk: snap }, '', location.href);
      } else {
        snap.n = cur.n + 1;
        history.pushState({ bk: snap }, '', location.href);
      }
    } catch (_) { /* история - удобство, без неё запись работает */ }
  }

  /** Кнопка «‹ Back» в карточке: на шаг назад по истории, если она есть. */
  function goBack() {
    const cur = history.state && history.state.bk;
    if (cur && cur.n > 0 && state.step !== 'done') { history.back(); return; }
    back();
  }

  window.addEventListener('popstate', (e) => {
    const snap = e.state && e.state.bk;
    if (!snap || !state.categories) return;   // не наша запись или каталог ещё не пришёл
    Object.assign(state, {
      categoryId: snap.categoryId, subcategoryId: snap.subcategoryId, serviceId: snap.serviceId,
      masterId: snap.masterId, length: snap.length, preferMaster: snap.preferMaster,
    });
    restoringKey = snapKey(snap);
    const detailsOk = state.slot && getService(state.serviceId);
    const fn = {
      category: renderCategory, subcategory: renderSubcategory, service: renderService,
      master: renderMaster, length: renderLength, time: loadTime,
      xsvc: renderExtraService, xmaster: renderExtraMaster, xlength: renderExtraLength,
      wait: renderWaitForm,
      details: detailsOk ? renderDetails : loadTime, done: renderCategory,
    }[snap.step] || renderCategory;
    try { fn(); } catch (_) { restoringKey = null; renderCategory(); }
  });

  function shell(title, sub, inner, opts = {}) {
    recordStep();
    syncSpecialists(state.step === 'category' ? null : state.categoryId);
    root.innerHTML = `
      ${progressHtml()}
      <div class="bk-card">
        ${opts.back ? `<button class="bk-back" data-act="back">‹ Back</button>` : ''}
        <span class="eyebrow">${opts.eyebrow || 'Online booking'}</span>
        <h2 class="bk-title">${title}</h2>
        ${sub ? `<p class="bk-sub">${sub}</p>` : ''}
        <div class="bk-body">${inner}</div>
      </div>`;
  }

  // ── steps ──────────────────────────────────────────────────────────
  function renderCategory() {
    state.step = 'category';
    const cards = visibleCats().map((c) =>
      `<button class="bk-tile" data-act="cat" data-id="${c.id}">
         <span class="bk-tile-name">${c.name}</span>
         <span class="bk-tile-meta">${nServices(c.subcategories.reduce((n, s) => n + s.services.length, 0))} ›</span>
       </button>`).join('');
    shell('What would you like to book?', 'Choose a service category to start.', `${masterBanner()}<div class="bk-grid">${cards}</div>`);
  }

  function renderSubcategory() {
    state.step = 'subcategory';
    const cat = visibleCats().find((c) => c.id === state.categoryId);
    // если всего одна подкатегория - пропускаем
    if (cat.subcategories.length === 1) { state.subcategoryId = cat.subcategories[0].id; return renderService(); }
    const cards = cat.subcategories.map((s) =>
      `<button class="bk-tile" data-act="sub" data-id="${s.id}">
         <span class="bk-tile-name">${s.name}</span>
         <span class="bk-tile-meta">${nServices(s.services.length)} ›</span>
       </button>`).join('');
    // Назад ведёт к выбору раздела; если у мастера раздел один, выбирать
    // там нечего, и кнопка привела бы на экран с единственной плиткой.
    const canBack = !(state.preferMaster && visibleCats().length === 1);
    shell(cat.name, 'Pick a category.', `${masterBanner()}<div class="bk-grid">${cards}</div>`, { back: canBack });
  }

  function renderService() {
    state.step = 'service';
    const cat = visibleCats().find((c) => c.id === state.categoryId);
    const sub = cat.subcategories.find((s) => s.id === state.subcategoryId);
    // В меню «Same Time» приставка «— Same Time» в каждой строке повторяет
    // название самого меню и растягивает имя на пять строк. В списке её
    // прячем; в каталоге и в уведомлениях владельцу имя остаётся полным.
    const listName = (svc) => sub.id === 'same-time'
      ? svc.name.replace(/\s+[—–-]\s+Same Time$/i, '')
      : svc.name;
    const rows = sub.services.map((svc) =>
      `<button class="bk-svc" data-act="svc" data-id="${svc.id}">
         <span class="bk-svc-main">
           <span class="bk-svc-name">${listName(svc)}</span>
           <span class="bk-svc-dur">⏱ ${fmtDur(svc.durationMin)}</span>
         </span>
         <span class="bk-svc-price">${priceRange(svc)} ›</span>
       </button>`).join('');
    // Один раздел и один подраздел у мастера: возвращаться некуда.
    const canBack = !(state.preferMaster && visibleCats().length === 1 && cat.subcategories.length === 1);
    shell(sub.name, 'Select a service.', `${masterBanner()}<div class="bk-list">${rows}</div>`, { back: canBack });
  }

  // Длины услуги для мастера (или null, если у услуги нет тарифов по длине).
  function lengthsFor(serviceId, masterId) {
    if (!masterId) return null;
    const svc = getService(serviceId);
    const entry = svc && svc.masters.find((m) => m.masterId === masterId);
    return entry && Array.isArray(entry.lengths) && entry.lengths.length ? entry.lengths : null;
  }
  // После выбора мастера: если есть длины и она ещё не выбрана - показать шаг длины.
  function maybeLengthThenTime() {
    const lengths = lengthsFor(state.serviceId, state.masterId);
    if (lengths && !state.length) return renderLength();
    return loadTime();
  }
  function renderLength() {
    state.step = 'length';
    const svc = getService(state.serviceId);
    const lengths = lengthsFor(state.serviceId, state.masterId) || [];
    const cards = lengths.map((L) =>
      `<button class="bk-master" data-act="length" data-id="${L.id}">
         <span class="bk-master-body">
           <span class="bk-master-name">${L.name} length</span>
           <span class="bk-master-role">${svc.name}</span>
         </span>
         <span class="bk-master-price">${fmtMoney(L.price)} ›</span>
       </button>`).join('');
    shell('Choose nail length', `${svc.name} · ${state.masters[state.masterId].name}`,
      `<div class="bk-list">${cards}</div>`, { back: true });
  }

  function renderMaster() {
    state.step = 'master';
    state.length = null;
    const svc = getService(state.serviceId);
    // Пришли с карточки мастера: он уже выбран, спрашивать второй раз незачем.
    if (state.preferMaster && svc.masters.some((m) => m.masterId === state.preferMaster)) {
      state.masterId = state.preferMaster;
      return maybeLengthThenTime();
    }
    const masters = svc.masters.map((m) => ({ ...state.masters[m.masterId], price: m.price }));
    // один мастер - пропускаем выбор
    if (masters.length === 1) { state.masterId = masters[0].id; return maybeLengthThenTime(); }
    const cards = masters.map((m) =>
      `<button class="bk-master" data-act="master" data-id="${m.id}">
         <span class="bk-master-av">${m.name[0]}</span>
         <span class="bk-master-body">
           <span class="bk-master-name">${m.name}</span>
           <span class="bk-master-role">${m.role}</span>
           <span class="bk-master-soon" data-soon="${m.id}"></span>
         </span>
         <span class="bk-master-price">${fmtMoney(m.price)} ›</span>
       </button>`).join('');
    const any = `<button class="bk-master bk-master-any" data-act="master" data-id="">
         <span class="bk-master-av">★</span>
         <span class="bk-master-body">
           <span class="bk-master-name">Any specialist</span>
           <span class="bk-master-role">Compare all available times</span>
         </span>
         <span class="bk-master-price">›</span>
       </button>`;
    shell('Choose your specialist', `For ${svc.name}.`, `<div class="bk-list">${any}${cards}</div>`, { back: true });
    fillSoonest(svc, masters);
  }

  // ── Ближайшее свободное окно у каждого мастера ─────────────────────
  // Показываем прямо в списке, потому что иначе выбирать не из чего:
  // имя, роль и одинаковая цена решения не подсказывают. Доступность —
  // единственное настоящее различие, и она же грузит того, кто свободнее.
  //
  // Один запрос без masterId возвращает слоты всех мастеров сразу
  // (в каждом слоте есть masterId), поэтому хватает одного обращения.
  const soonCache = {};

  function soonLabel(iso) {
    const k = dayKey(iso);
    const today = dayKey(new Date().toISOString());
    const tomorrow = dayKey(new Date(Date.now() + 86400000).toISOString());
    if (k === today) return `today ${timeLabel(iso)}`;
    if (k === tomorrow) return `tomorrow ${timeLabel(iso)}`;
    return `${dayLabel(iso)}, ${timeLabel(iso)}`;
  }

  async function fillSoonest(svc, masters) {
    const cacheKey = `${svc.id}|${state.length || ''}`;
    const paint = (map) => {
      masters.forEach((m) => {
        const el = document.querySelector(`[data-soon="${m.id}"]`);
        if (!el) return;
        const iso = map[m.id];
        el.textContent = iso ? `Soonest: ${soonLabel(iso)}` : 'No openings in the next 3 weeks';
        el.classList.toggle('bk-master-soon-none', !iso);
      });
    };

    if (soonCache[cacheKey]) return paint(soonCache[cacheKey]);

    // Пока грузится - ничего не обещаем, просто тихо ждём.
    try {
      const from = new Date();
      const to = new Date(Date.now() + 21 * 86400000);
      const { slots } = await api('/api/availability', {
        serviceId: svc.id,
        length: state.length || undefined,
        from: from.toISOString(), to: to.toISOString(),
      });
      const map = {};
      for (const sl of slots || []) {
        if (!map[sl.masterId] || sl.startAt < map[sl.masterId]) map[sl.masterId] = sl.startAt;
      }
      soonCache[cacheKey] = map;
      // За время запроса человек мог уйти на другой экран.
      if (state.step === 'master') paint(map);
    } catch (_) {
      // Молча: подсказка полезная, но не обязательная - без неё экран рабочий.
    }
  }

  // ── доступность по месяцам ─────────────────────────────────────────
  // Square разрешает искать не больше чем на 32 дня за запрос, поэтому
  // тянем помесячно и кешируем: клиент может листать на CONFIG.monthsAhead
  // месяцев вперёд, а не только по ближайшим свободным слотам.
  const monthKey = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;

  function monthTitle(y, m) {
    return new Intl.DateTimeFormat(CONFIG.locale, { month: 'long', year: 'numeric', timeZone: tz() })
      .format(new Date(Date.UTC(y, m, 15)));
  }

  // границы окна: от сегодня до последнего дня месяца +monthsAhead
  function monthLimits() {
    const now = new Date();
    const first = { y: now.getFullYear(), m: now.getMonth() };
    const lastDate = new Date(now.getFullYear(), now.getMonth() + CONFIG.monthsAhead, 1);
    return { first, last: { y: lastDate.getFullYear(), m: lastDate.getMonth() } };
  }
  const monthIndex = (y, m) => y * 12 + m;

  async function loadMonth(y, m) {
    const key = monthKey(y, m);
    if (state.monthCache[key]) return state.monthCache[key];

    const now = new Date();
    const startOfMonth = new Date(y, m, 1, 0, 0, 0);
    const from = startOfMonth > now ? startOfMonth : now;
    const to = new Date(y, m + 1, 1, 0, 0, 0); // первое число следующего месяца

    // Две услуги подряд: сервер отдаёт только то время, когда обе встают вплотную.
    const { slots } = state.second
      ? await api('/api/pair-availability', {
          a: { serviceId: state.serviceId, masterId: state.masterId || undefined, length: state.length || undefined },
          b: { serviceId: state.second.serviceId, masterId: state.second.masterId || undefined, length: state.second.length || undefined },
          from: from.toISOString(), to: to.toISOString(),
        })
      : await api('/api/availability', {
          serviceId: state.serviceId, masterId: state.masterId || undefined,
          length: state.length || undefined,
          from: from.toISOString(), to: to.toISOString(),
        });
    const byDay = {};
    for (const s of slots) { (byDay[dayKey(s.startAt)] ||= []).push(s); }
    for (const d of Object.keys(byDay)) byDay[d].sort((a, b) => a.startAt.localeCompare(b.startAt));
    state.monthCache[key] = byDay;
    return byDay;
  }

  function timeHeader() {
    const svc = getService(state.serviceId);
    const first = `${svc.name}${state.masterId ? ' · ' + state.masters[state.masterId].name : ''}`;
    if (!state.second) return first;
    const s2 = getService(state.second.serviceId);
    return `${first} + ${s2.name}${state.second.masterId ? ' · ' + state.masters[state.second.masterId].name : ''}`;
  }

  // ── Вторая услуга подряд ────────────────────────────────────────────
  // Клиент добавляет её ДО выбора времени; календарь тогда показывает только
  // время, когда обе услуги идут вплотную. Скидки нет. Кто за чем идёт,
  // решает сервер: по умолчанию снятие, маникюр, педикюр, а если кресло
  // не позволяет, наоборот.
  const SHORT_KIND = { extras: 'Removal', manicure: 'Mani', pedicure: 'Pedi' };

  /** Годится ли услуга как часть пары (то же правило, что на сервере). */
  function pairable(svc) {
    return !!(svc && svc.cat && svc.cat.id === 'nail' && !svc.dualMaster
      && svc.sub && svc.sub.id !== 'same-time' && svc.id !== 'nail-designs');
  }

  /** Подпись времени у пары: «Mani → Pedi», с мастерами, когда мастер не выбран. */
  function pairTag(s) {
    return (s.segments || []).map((seg) => {
      const sv = getService(seg.serviceId);
      const chosen = seg.serviceId === state.serviceId ? state.masterId : (state.second && state.second.masterId);
      const who = !chosen && seg.masterId && state.masters[seg.masterId] ? ' ' + state.masters[seg.masterId].name : '';
      return `${SHORT_KIND[sv && sv.sub && sv.sub.id] || 'Service'}${who}`;
    }).join(' → ');
  }

  /** Блок над календарём: добавить вторую услугу или убрать уже добавленную. */
  function pairControlHtml() {
    const svc = getService(state.serviceId);
    if (!pairable(svc)) return '';
    if (state.second) {
      const s2 = getService(state.second.serviceId);
      const who = state.second.masterId ? ' · ' + state.masters[state.second.masterId].name : '';
      return `<div class="bk-pair-box">
          <span class="bk-pair-text"><b>+ ${s2.name}</b>${who}<br><span class="bk-pair-sub">Right after your first service. No gaps in between.</span></span>
          <button type="button" class="bk-pair-btn" data-act="xrm">Remove</button>
        </div>`;
    }
    return `<div class="bk-pair-box">
        <span class="bk-pair-text"><b>Need another service?</b><br><span class="bk-pair-sub">Add a manicure, pedicure or removal and we’ll show times that fit both.</span></span>
        <button type="button" class="bk-pair-btn" data-act="xadd">+ Add service</button>
      </div>`;
  }

  // ── Лист ожидания ───────────────────────────────────────────────────
  // Не нашёл время - оставил заявку. Воркер раз в час ищет подходящее время
  // и пишет письмо со ссылкой на запись. Сам клиента не записывает.
  function waitlistHtml(strong) {
    return `<div class="bk-pair-box${strong ? ' bk-pair-strong' : ''}">
        <span class="bk-pair-text"><b>${strong ? 'Nothing that works?' : 'Can’t find a time that suits you?'}</b><br><span class="bk-pair-sub">Join the waiting list and we’ll email you the moment a time opens.</span></span>
        <button type="button" class="bk-pair-btn" data-act="wait">Join the list</button>
      </div>`;
  }

  /** Дата через n дней в виде ГГГГ-ММ-ДД по часам студии (для границ полей даты). */
  function waitDate(n) {
    return dayKey(new Date(Date.now() + n * 86400000).toISOString());
  }

  function renderWaitForm() {
    state.step = 'wait';
    const turnstile = CONFIG.turnstileSiteKey
      ? `<div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div>` : '';
    shell('Join the waiting list', 'We’ll email you as soon as a time that suits you opens up.',
      `<div class="bk-summary"><div><b>${timeHeader()}</b></div></div>
       <form id="bk-wait-form" class="bk-form">
         <label>Full name<input name="name" required autocomplete="name"></label>
         <label>Email - we’ll write here when a time opens<input name="email" type="email" required autocomplete="email" inputmode="email" placeholder="you@example.com"></label>
         <label>Phone (optional)<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(305) 555-1234"></label>
         <p class="bk-block-title" style="margin:6px 0 -4px">When can you come?</p>
         <p class="bk-sub" style="margin:0">Leave a field empty if it doesn’t matter. We’ll only write about times that fit.</p>
         <div class="bk-wait-grid">
           <label>From date<input name="dateFrom" type="date" min="${waitDate(0)}" max="${waitDate(90)}"></label>
           <label>To date<input name="dateTo" type="date" min="${waitDate(0)}" max="${waitDate(90)}"></label>
           <label>Start no earlier than<input name="timeFrom" type="time" step="900"></label>
           <label>Start no later than<input name="timeTo" type="time" step="900"></label>
         </div>
         <label>Only on (optional)
           <select name="days">
             <option value="any">Any day of the week</option>
             <option value="weekdays">Weekdays only</option>
             <option value="weekends">Weekends only</option>
           </select>
         </label>
         <label class="bk-agree">
           <input type="checkbox" name="agree" required>
           <span>I understand this is not a booking and does not hold a time. If one opens, I’ll get an email and whoever books first gets it. We keep my details only for this - <a href="privacy-policy.html" target="_blank" rel="noopener">privacy policy</a>.</span>
         </label>
         ${turnstile}
         <button type="submit" class="btn btn-gold bk-submit">Join the waiting list</button>
         <div class="bk-error" id="bk-form-err" hidden></div>
       </form>`, { back: true });
    renderTurnstile();
    document.getElementById('bk-wait-form').addEventListener('submit', submitWait);
  }

  async function submitWait(e) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('.bk-submit');
    const err = document.getElementById('bk-form-err');
    err.hidden = true;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const fd = new FormData(form);
      const dateFrom = fd.get('dateFrom') || '', dateTo = fd.get('dateTo') || '';
      const timeFrom = fd.get('timeFrom') || '', timeTo = fd.get('timeTo') || '';
      // Ошибки диапазона ловим до отправки: человеку понятнее, чем ответ сервера.
      if (dateFrom && dateTo && dateTo < dateFrom) throw new Error('The last date must not be before the first date.');
      if (timeFrom && timeTo && timeTo < timeFrom) throw new Error('The latest start time must not be before the earliest.');
      await api('/api/waitlist-join', {
        a: { serviceId: state.serviceId, masterId: state.masterId || undefined, length: state.length || undefined },
        b: state.second
          ? { serviceId: state.second.serviceId, masterId: state.second.masterId || undefined, length: state.second.length || undefined }
          : undefined,
        prefs: {
          days: fd.get('days'),
          dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
          timeFrom: timeFrom || undefined, timeTo: timeTo || undefined,
        },
        customer: { name: fd.get('name'), email: fd.get('email'), phone: normalizePhone(fd.get('phone')) || undefined },
        source: (typeof window.vsSource === 'function' ? window.vsSource() : null) || undefined,
        turnstileToken: turnstileToken(form),
      });
      state.step = 'done';
      shell('You’re on the list', 'We’ll email you as soon as a time opens.',
        `<div class="bk-summary bk-summary-done">
           <div><b>${timeHeader()}</b></div>
           <div>We’ll check every hour and keep your request for 30 days.</div>
         </div>
         <p class="bk-sub" style="margin-top:14px">A confirmation is on its way to your email, with a link to leave the list any time.</p>
         <a href="index.html" class="btn btn-dark" style="margin-top:18px;display:inline-block">Back to site</a>`,
        { eyebrow: 'Waiting list' });
    } catch (e2) {
      resetTurnstile();
      err.textContent = /turnstile|spam check/i.test(e2.message || '')
        ? 'Couldn’t verify you’re human. Please tap the button again, or call/WhatsApp us.'
        : e2.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = 'Join the waiting list';
    }
  }

  // ── Подсказка про Same Time ─────────────────────────────────────────
  // Маникюр и педикюр можно сделать одновременно у двух мастеров: вдвое
  // быстрее. Когда клиент собрал именно такую пару, напоминаем об этом и
  // показываем ближайшее время комбо, чтобы он мог перейти на него одним тапом.

  /** Комбо Same Time, которое заменяет выбранные две услуги, или null. */
  function sameTimeFor() {
    if (!state.second || !state.categories) return null;
    const ids = [state.serviceId, state.second.serviceId];
    if (ids[0] === ids[1]) return null;
    for (const cat of state.categories) {
      for (const sub of cat.subcategories) {
        for (const s of sub.services) {
          if (s.dualMaster && Array.isArray(s.parts) && ids.every((id) => s.parts.includes(id))) return s;
        }
      }
    }
    return null;
  }

  /** Длительность услуги: у выбранного мастера, а если мастер не выбран, типовая. */
  function serviceMinutes(serviceId, masterId) {
    const s = getService(serviceId);
    const e = s && (s.masters || []).find((m) => m.masterId === masterId);
    return (e && e.durationMin) || (s && s.durationMin) || 0;
  }

  /** Подгружаем ближайшее время комбо один раз на пару услуг. */
  function loadSameTime() {
    const combo = sameTimeFor();
    if (!combo) { state.sameTime = null; return; }
    if (state.sameTime && state.sameTime.id === combo.id) return;   // уже есть или грузится
    const mine = { id: combo.id, slots: null };
    state.sameTime = mine;
    api('/api/availability', {
      serviceId: combo.id,
      from: new Date().toISOString(), to: new Date(Date.now() + 21 * 86400000).toISOString(),
    }).then((r) => {
      if (state.sameTime !== mine) return;   // пара уже другая
      mine.slots = (r.slots || []).slice(0, 3);
      if (state.step === 'time') renderTime();
    }).catch(() => { if (state.sameTime === mine) mine.slots = []; });
  }

  function sameTimeHtml() {
    const combo = sameTimeFor();
    const st = state.sameTime;
    if (!combo || !st || st.id !== combo.id || !st.slots || !st.slots.length) return '';
    const seq = serviceMinutes(state.serviceId, state.masterId) + serviceMinutes(state.second.serviceId, state.second.masterId);
    const btns = st.slots.map((s, i) =>
      `<button type="button" class="bk-soon" data-act="sametime" data-i="${i}">
         <span class="bk-soon-day">${dayLabel(s.startAt)}</span>
         <span class="bk-soon-time">${timeLabel(s.startAt)}</span>
       </button>`).join('');
    return `<div class="bk-pair-box bk-pair-tip">
        <span class="bk-pair-text"><b>Faster: do both at the same time</b><br>
          <span class="bk-pair-sub">Ksenia does your manicure while Anastasia does your pedicure: ${fmtDur(combo.durationMin).trim()}${seq > combo.durationMin ? ` instead of ${fmtDur(seq).trim()}` : ''}, ${fmtMoney(combo.price)} in total. Soonest times:</span></span>
        <div class="bk-soon-row">${btns}</div>
      </div>`;
  }

  // Услуги, которые можно добавить: ногти, другого вида, чем первая.
  function extraServices() {
    const first = getService(state.serviceId);
    const nail = state.categories.find((c) => c.id === 'nail');
    const out = [];
    for (const sub of (nail ? nail.subcategories : [])) {
      if (!first || sub.id === first.sub.id) continue;
      const list = sub.services.filter((s) => pairable({ ...s, cat: nail, sub }));
      if (list.length) out.push({ sub, list });
    }
    return out;
  }

  function renderExtraService() {
    state.step = 'xsvc';
    const groups = extraServices();
    const body = groups.map((g) => `
      <p class="bk-block-title">${g.sub.name}</p>
      <div class="bk-list">${g.list.map((svc) => `
        <button class="bk-svc" data-act="xsvc" data-id="${svc.id}">
          <span class="bk-svc-main">
            <span class="bk-svc-name">${svc.name}</span>
            <span class="bk-svc-dur">⏱ ${fmtDur(svc.durationMin)}</span>
          </span>
          <span class="bk-svc-price">${priceRange(svc)} ›</span>
        </button>`).join('')}</div>`).join('');
    shell('Add another service', 'It will follow your first service, with no gap. Pick what to add.',
      body || '<p class="bk-sub">Nothing to add to this service online. Please call (754) 202-6666.</p>', { back: true });
  }

  function renderExtraMaster() {
    state.step = 'xmaster';
    const svc = getService(state.xPick.serviceId);
    const masters = svc.masters.map((m) => ({ ...state.masters[m.masterId], price: m.price }));
    if (masters.length === 1) return pickExtraMaster(masters[0].id);
    const cards = masters.map((m) =>
      `<button class="bk-master" data-act="xmaster" data-id="${m.id}">
         <span class="bk-master-av">${m.name[0]}</span>
         <span class="bk-master-body">
           <span class="bk-master-name">${m.name}</span>
           <span class="bk-master-role">${m.role}</span>
         </span>
         <span class="bk-master-price">${fmtMoney(m.price)} ›</span>
       </button>`).join('');
    const any = `<button class="bk-master bk-master-any" data-act="xmaster" data-id="">
         <span class="bk-master-av">★</span>
         <span class="bk-master-body">
           <span class="bk-master-name">Any specialist</span>
           <span class="bk-master-role">Compare all available times</span>
         </span>
         <span class="bk-master-price">›</span>
       </button>`;
    shell('Choose your specialist', `For ${svc.name}.`, `<div class="bk-list">${any}${cards}</div>`, { back: true });
  }

  function renderExtraLength() {
    state.step = 'xlength';
    const svc = getService(state.xPick.serviceId);
    const lengths = lengthsFor(svc.id, state.xPick.masterId) || [];
    const cards = lengths.map((L) =>
      `<button class="bk-master" data-act="xlength" data-id="${L.id}">
         <span class="bk-master-body">
           <span class="bk-master-name">${L.name} length</span>
           <span class="bk-master-role">${svc.name}</span>
         </span>
         <span class="bk-master-price">${fmtMoney(L.price)} ›</span>
       </button>`).join('');
    shell('Choose nail length', `${svc.name} · ${state.masters[state.xPick.masterId].name}`,
      `<div class="bk-list">${cards}</div>`, { back: true });
  }

  /** Мастер для второй услуги выбран: нужна длина (если есть) или сразу время. */
  function pickExtraMaster(masterId) {
    state.xPick.masterId = masterId || null;
    const lengths = lengthsFor(state.xPick.serviceId, state.xPick.masterId);
    if (lengths) return renderExtraLength();
    return finishExtra(null);
  }

  function finishExtra(length) {
    state.second = { serviceId: state.xPick.serviceId, masterId: state.xPick.masterId, length: length || null };
    state.xPick = null;
    state.slot = null;
    loadTime();
  }

  async function loadTime() {
    state.step = 'time';
    const now = new Date();
    // Слоты в кэше принадлежат конкретной услуге, мастеру и длине. Сменил
    // услугу (например, вернулся назад и выбрал другую) - прежние слоты
    // чужие, и запись на них уходила бы с неверным мастером.
    const sec = state.second ? [state.second.serviceId, state.second.masterId || '', state.second.length || ''].join(':') : '';
    const sig = [state.serviceId, state.masterId || '', state.length || '', sec].join('|');
    if (state.cacheSig !== sig) {
      state.cacheSig = sig;
      state.monthCache = {};
      state.monthCursor = null;
      state.selectedDay = null;
      state.slot = null;
    }
    state.monthCache = state.monthCache || {};
    if (!state.monthCursor) state.monthCursor = { y: now.getFullYear(), m: now.getMonth() };
    shell('Pick a date & time', timeHeader(), `<div class="bk-loading">Loading availability…</div>`, { back: true });
    try {
      await loadMonth(state.monthCursor.y, state.monthCursor.m);
      // подтягиваем следующий месяц, если в текущем уже ничего нет
      const cur = state.monthCache[monthKey(state.monthCursor.y, state.monthCursor.m)];
      if (!Object.keys(cur).length) {
        const lim = monthLimits();
        const nxt = new Date(state.monthCursor.y, state.monthCursor.m + 1, 1);
        if (monthIndex(nxt.getFullYear(), nxt.getMonth()) <= monthIndex(lim.last.y, lim.last.m)) {
          state.monthCursor = { y: nxt.getFullYear(), m: nxt.getMonth() };
          await loadMonth(state.monthCursor.y, state.monthCursor.m);
        }
      }
      pickDefaultDay();
      renderTime();
    } catch (e) {
      shell('Pick a date & time', timeHeader(), `<div class="bk-error">Could not load availability: ${e.message}</div>`, { back: true });
    }
  }

  function currentMonthDays() {
    return state.monthCache[monthKey(state.monthCursor.y, state.monthCursor.m)] || {};
  }

  function pickDefaultDay() {
    const byDay = currentMonthDays();
    const days = Object.keys(byDay).sort();
    if (!state.selectedDay || !byDay[state.selectedDay]) state.selectedDay = days[0] || null;
  }

  // ближайшие свободные слоты - быстрый путь для тех, кому «когда угодно, но скорее»
  function soonestHtml() {
    const keys = Object.keys(state.monthCache).sort();
    const out = [];
    for (const k of keys) {
      for (const d of Object.keys(state.monthCache[k]).sort()) {
        for (const s of state.monthCache[k][d]) {
          out.push({ day: d, slot: s });
          if (out.length >= CONFIG.soonestCount) break;
        }
        if (out.length >= CONFIG.soonestCount) break;
      }
      if (out.length >= CONFIG.soonestCount) break;
    }
    if (!out.length) return '';
    const chips = out.map(({ day, slot }) => {
      const i = state.monthCache[monthKey(+day.slice(0, 4), +day.slice(5, 7) - 1)][day].indexOf(slot);
      const who = slot.pair ? `<em>${pairTag(slot)}</em>`
        : (!state.masterId && slot.masterId ? `<em>${state.masters[slot.masterId]?.name || ''}</em>` : '');
      return `<button class="bk-soon" data-act="slot" data-day="${day}" data-i="${i}">
                <span class="bk-soon-day">${dayLabel(slot.startAt)}</span>
                <span class="bk-soon-time">${timeLabel(slot.startAt)}</span>${who}
              </button>`;
    }).join('');
    return `<div class="bk-soonest">
              <p class="bk-block-title">Soonest available</p>
              <div class="bk-soon-row">${chips}</div>
            </div>`;
  }

  function calendarHtml() {
    const { y, m } = state.monthCursor;
    const lim = monthLimits();
    const idx = monthIndex(y, m);
    const canPrev = idx > monthIndex(lim.first.y, lim.first.m);
    const canNext = idx < monthIndex(lim.last.y, lim.last.m);
    const byDay = currentMonthDays();

    // сетка с понедельника
    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    let cells = '';
    for (let i = 0; i < firstDow; i++) cells += `<span class="bk-cal-cell bk-cal-empty" aria-hidden="true"></span>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const has = !!byDay[key];
      const isSel = key === state.selectedDay;
      const isToday = key === todayKey;
      const cls = ['bk-cal-day', has ? 'has' : 'none', isSel ? 'on' : '', isToday ? 'today' : ''].filter(Boolean).join(' ');
      cells += has
        ? `<button class="${cls}" data-act="day" data-id="${key}" aria-label="${dayLabel(byDay[key][0].startAt)}, ${byDay[key].length} times available">${d}<span class="bk-cal-dot" aria-hidden="true"></span></button>`
        : `<span class="${cls}" aria-disabled="true">${d}</span>`;
    }

    const dows = CONFIG.dowLabels.map((w) => `<span class="bk-cal-dow">${w}</span>`).join('');
    const empty = Object.keys(byDay).length ? '' :
      `<p class="bk-cal-empty-note">No free times this month. Try the next one.</p>`;

    return `<div class="bk-plan">
      <p class="bk-block-title">Plan ahead</p>
      <div class="bk-cal-head">
        <button class="bk-cal-nav" data-act="month" data-dir="-1" ${canPrev ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <span class="bk-cal-title">${monthTitle(y, m)}</span>
        <button class="bk-cal-nav" data-act="month" data-dir="1" ${canNext ? '' : 'disabled'} aria-label="Next month">›</button>
      </div>
      <div class="bk-cal-grid" role="grid">${dows}${cells}</div>
      ${empty}
    </div>`;
  }

  function slotsHtml() {
    const byDay = currentMonthDays();
    const list = byDay[state.selectedDay] || [];
    if (!list.length) return '';
    const slots = list.map((s, i) => {
      const tag = s.pair ? `<span class="bk-slot-who">${pairTag(s)}</span>`
        : (!state.masterId && s.masterId ? `<span class="bk-slot-who">${state.masters[s.masterId]?.name || ''}</span>` : '');
      return `<button class="bk-slot" data-act="slot" data-i="${i}" data-day="${state.selectedDay}">${timeLabel(s.startAt)}${tag}</button>`;
    }).join('');
    return `<div class="bk-day-slots">
              <p class="bk-block-title">${dayLabel(list[0].startAt)} · ${list.length} time${list.length > 1 ? 's' : ''}</p>
              <div class="bk-slots">${slots}</div>
            </div>`;
  }

  function renderTime() {
    loadSameTime();
    const anySlots = Object.values(state.monthCache).some((byDay) => Object.keys(byDay).length);
    if (!anySlots && Object.keys(state.monthCache).length >= 2) {
      shell('Pick a date & time', timeHeader(),
        `${pairControlHtml()}${sameTimeHtml()}${calendarHtml()}<div class="bk-error">${state.second
          ? 'No time fits both services back to back. Try other specialists or remove one service, or call us at (754) 202-6666.'
          : 'Nothing free in this window. Please call us at (754) 202-6666 and we will find a time.'}</div>${waitlistHtml(true)}`,
        { back: true });
      return;
    }
    shell('Pick a date & time', timeHeader(),
      `${pairControlHtml()}${sameTimeHtml()}${soonestHtml()}${calendarHtml()}${slotsHtml()}${waitlistHtml(false)}`, { back: true });
  }

  async function goMonth(dir) {
    const lim = monthLimits();
    const d = new Date(state.monthCursor.y, state.monthCursor.m + dir, 1);
    const idx = monthIndex(d.getFullYear(), d.getMonth());
    if (idx < monthIndex(lim.first.y, lim.first.m) || idx > monthIndex(lim.last.y, lim.last.m)) return;
    state.monthCursor = { y: d.getFullYear(), m: d.getMonth() };
    state.selectedDay = null;
    const key = monthKey(state.monthCursor.y, state.monthCursor.m);
    if (!state.monthCache[key]) {
      const btns = root.querySelectorAll('.bk-cal-nav');
      btns.forEach((b) => (b.disabled = true));
      const grid = root.querySelector('.bk-cal-grid');
      if (grid) grid.classList.add('is-loading');
      try { await loadMonth(state.monthCursor.y, state.monthCursor.m); }
      catch (e) {
        shell('Pick a date & time', timeHeader(), `<div class="bk-error">Could not load availability: ${e.message}</div>`, { back: true });
        return;
      }
    }
    pickDefaultDay();
    renderTime();
  }

  // Приводим телефон к E.164 (Square требует код страны), но даём вводить как удобно.
  // 10 цифр → US (+1); 11 с ведущей «1» → +1…; ввод, начатый с «+» → как есть;
  // иначе считаем, что код страны клиент уже указал.
  function normalizePhone(raw) {
    const s = String(raw || '').trim();
    const d = s.replace(/[^\d]/g, '');
    if (!d) return '';
    if (s[0] === '+') return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return '+' + d;
  }

  function renderDetails() {
    state.step = 'details';
    const svc = getService(state.serviceId);
    const m = state.masters[state.slot.masterId];
    const masterLabel = svc.dualMaster
      ? svc.dualMaster.map((s) => (state.masters[s.masterId] || {}).name).filter(Boolean).join(' + ')
      : (m ? m.name : '');
    const _ls = lengthsFor(state.serviceId, state.slot.masterId);
    const _lenName = _ls && state.length ? (_ls.find((L) => L.id === state.length) || {}).name : null;
    track('begin_checkout', { currency: 'USD', value: state.slot.price, items: [gaItem()] });
    // Две услуги подряд: по строке на каждую, с её временем и мастером.
    const segLines = (state.slot.segments || []).map((sg) => {
      const sv = getService(sg.serviceId);
      const ls = lengthsFor(sg.serviceId, sg.masterId);
      const ln = ls && sg.length ? (ls.find((L) => L.id === sg.length) || {}).name : null;
      const who = (state.masters[sg.masterId] || {}).name || '';
      return `<div>${timeLabel(sg.startAt)} · <b>${sv.name}${ln ? ' · ' + ln + ' length' : ''}</b> · ${who} · ${fmtMoney(sg.price)}</div>`;
    }).join('');
    const summary = state.slot.pair
      ? `<div class="bk-summary">
          <div>${dayLabel(state.slot.startAt)} · ${fmtDur(state.slot.durationMin)} in total</div>
          ${segLines}
          <div id="bk-total-line"></div>
        </div>`
      : `
      <div class="bk-summary">
        <div><b>${svc.name}${_lenName ? ' · ' + _lenName + ' length' : ''}</b></div>
        <div>${dayLabel(state.slot.startAt)}, ${timeLabel(state.slot.startAt)} · ${fmtDur(svc.durationMin)}</div>
        <div>${masterLabel} · ${fmtMoney(state.slot.price)}</div>
        <div id="bk-total-line"></div>
      </div>`;
    const turnstile = CONFIG.turnstileSiteKey
      ? `<div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div>` : '';
    // Массаж - это не «слот в календаре», а приём. Спрашиваем, с чем человек идёт:
    // Иван успевает подготовиться, а клиент видит, что сеанс строят под него.
    // Чипсы, а не только текст: заполняют в один тап, поэтому реально заполняют.
    const isMassage = !!(svc.cat && svc.cat.id === 'massage');
    const intake = isMassage
      ? `<div class="bk-intake">
           <span class="bk-intake-title">What should Ivan work on?</span>
           <span class="bk-intake-hint">Tap everything that applies - it lets him plan the session before you arrive.</span>
           <div class="bk-intake-chips">
             ${MASSAGE_CONCERNS.map((c) => `<button type="button" class="bk-chip" data-concern="${c}" aria-pressed="false">${c}</button>`).join('')}
           </div>
           <label>Anything else he should know? (optional)
             <span class="bk-intake-hint">Please mention allergies, medication, injuries or pregnancy - they change how Ivan works.</span>
             <textarea name="note" rows="3" placeholder="When it started, which movement sets it off, and anything he should avoid."></textarea>
           </label>
         </div>`
      : `<label>Note (optional)<textarea name="note" rows="2"></textarea></label>`;
    shell('Your details', 'Pay in person at your appointment.',
      `${summary}
       <form id="bk-form" class="bk-form">
         <label>Full name<input name="name" required autocomplete="name"></label>
         <label>Phone
           <input name="phone" type="tel" inputmode="tel" required autocomplete="tel" placeholder="(305) 555-1234" title="Your mobile number - we’ll text your confirmation">
         </label>
         <label>Email - we’ll send your confirmation and directions<input name="email" type="email" required autocomplete="email" inputmode="email" placeholder="you@example.com" title="Your confirmation and directions are sent here"></label>
         ${intake}
         <label>Package or gift certificate code (optional)<input name="packageGan" placeholder="16 digits from your card - we apply it to this visit"></label>
         <div id="bk-design"></div>
         <div id="bk-addon"></div>
         <label class="bk-agree">
           <input type="checkbox" name="agreePolicy" required>
           <span>I can cancel or reschedule free up to 24 hours before. Later than that is 50%, a no-show is the full price — <a href="cancellation-policy.html" target="_blank" rel="noopener">cancellation policy</a>. We keep your details only to run your appointment - <a href="privacy-policy.html" target="_blank" rel="noopener">privacy policy</a>.</span>
         </label>
         ${turnstile}
         <button type="submit" class="btn btn-gold bk-submit">Confirm booking</button>
         <div class="bk-error" id="bk-form-err" hidden></div>
       </form>`, { back: true });
    renderTurnstile();
    renderDesignBlock();
    renderAddonBlock();     // если опции уже загружены (например, вернулись назад)
    updateAddonSummary();
    const _form = document.getElementById('bk-form');
    // Переключение чипсов зон. Делегируем на форму: чипсы рисуются вместе с ней.
    _form.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.bk-chip');
      if (!chip || !_form.contains(chip)) return;
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    });
    // Телефон нормализуем при отправке (см. normalizePhone), а НЕ по ходу ввода - чтобы
    // клиент мог писать привычно: (305) 555-1234. Код страны (+1) подставляется сам.
    _form.addEventListener('submit', submitBooking);
    // Гель-маникюр к массажу не предлагается тому, кто платит пакетом или сертификатом.
    _form.elements.packageGan.addEventListener('input', () => { renderAddonBlock(); renderDesignBlock(); updateAddonSummary(); });
  }

  // Дизайн ногтей: доплата, время записи не меняет. Руки и ноги - каждый
  // отдельная доплата. Только к маникюру и педикюру, кроме «Extras» (там дизайн
  // как отдельная услуга); к массажу - на гель-маникюре, добавленном к нему.
  function designAreas() {
    if (!state.designs) return [];
    const areas = new Set();
    const add = (s) => {
      if (!s || !s.cat || s.cat.id !== 'nail' || (s.sub && s.sub.id === 'extras')) return;
      if (s.dualMaster) { areas.add('hands'); areas.add('feet'); }
      else if (s.sub && s.sub.id === 'pedicure') areas.add('feet');
      else areas.add('hands');
    };
    add(getService(state.serviceId));
    if (state.second) add(getService(state.second.serviceId));
    if (isMassageNow() && state.addon) areas.add('hands');
    return ['hands', 'feet'].filter((a) => areas.has(a));
  }

  function renderDesignBlock() {
    const box = document.getElementById('bk-design');
    if (!box) return;
    const areas = designAreas();
    for (const a of ['hands', 'feet']) if (!areas.includes(a)) state.design[a] = null;
    if (!areas.length) { box.innerHTML = ''; return; }
    box.innerHTML = areas.map((area, n) => {
      const rows = state.designs.options.map((o) => {
        const on = state.design[area] === o.id;
        return `<button type="button" class="bk-addon-opt${on ? ' on' : ''}" data-act="design" data-area="${area}" data-id="${o.id}" aria-pressed="${on}">
            <span class="bk-addon-main"><span class="bk-addon-name">${o.name}</span></span>
          </button>`;
      }).join('');
      const what = area === 'feet' ? 'your toes' : (isMassageNow() ? 'your gel manicure' : 'your hands');
      return `
        <div class="bk-addon-box">
          <p class="bk-addon-title">Add a nail design to ${what} - +${fmtMoney(state.designs.priceUsd)}</p>
          <p class="bk-addon-sub">Your appointment time stays the same. Tap again to remove it.${n === 0 ? ' For something else, choose Other and describe it in the note.' : ''}</p>
          <div class="bk-design-grid">${rows}</div>
        </div>`;
    }).join('');
  }

  /** Сколько дизайнов выбрано (только по тем частям, что есть в записи). */
  function designCount() {
    return designAreas().filter((a) => state.design[a]).length;
  }
  function designPrice() {
    return state.designs ? designCount() * (Number(state.designs.priceUsd) || 0) : 0;
  }
  /** Что уходит на сервер: { hands: 'chrome', feet: 'ombre' } или ничего. */
  function selectedDesigns() {
    const out = {};
    for (const a of designAreas()) if (state.design[a]) out[a] = state.design[a];
    return Object.keys(out).length ? out : undefined;
  }

  function isMassageNow() {
    const s = getService(state.serviceId);
    return !!(s && s.cat && s.cat.id === 'massage');
  }

  async function submitBooking(e) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('.bk-submit');
    const err = document.getElementById('bk-form-err');
    err.hidden = true;
    btn.disabled = true; btn.textContent = 'Booking…';
    try {
      const fd = new FormData(form);
      const phone = normalizePhone(fd.get('phone'));
      // Выбранные зоны + свободный текст склеиваем в одну заметку: она уходит
      // в Square (customer_note) и в уведомления владельцу.
      const areas = Array.from(form.querySelectorAll('.bk-chip[aria-pressed="true"]'))
        .map((b) => b.dataset.concern).filter(Boolean);
      const note = [areas.length ? 'Areas: ' + areas.join(', ') : '', (fd.get('note') || '').trim()]
        .filter(Boolean).join(' · ');
      // Две услуги подряд: основная - та, что идёт первой по времени, вторая
      // начинается в её конце. Все данные берём из выбранного времени.
      const segs = state.slot.pair ? state.slot.segments : null;
      const res = await api('/api/book', {
        serviceId: segs ? segs[0].serviceId : state.serviceId,
        masterId: segs ? segs[0].masterId : state.slot.masterId,
        length: segs ? (segs[0].length || undefined) : (state.length || undefined),
        startAt: state.slot.startAt,
        serviceVariationVersion: segs ? undefined : state.slot.serviceVariationVersion,
        pair: segs
          ? { serviceId: segs[1].serviceId, masterId: segs[1].masterId, length: segs[1].length || undefined, startAt: segs[1].startAt }
          : undefined,
        customer: { name: fd.get('name'), email: fd.get('email'), phone, note },
        packageGan: (fd.get('packageGan') || '').replace(/\s+/g, '') || undefined,
        designs: selectedDesigns(),
        addon: state.addon && !(isMassageNow() && fd.get('packageGan'))
          ? { serviceId: state.addon.serviceId, startAt: state.addon.startAt, masterId: state.addon.masterId, length: state.addon.length || undefined }
          : undefined,
        gclid: storedClickId('gclid') || undefined,
        gbraid: storedClickId('gbraid') || undefined,
        wbraid: storedClickId('wbraid') || undefined,
        // Первое касание, записанное в analytics.js на любой странице.
        source: (typeof window.vsSource === 'function' ? window.vsSource() : null) || undefined,
        turnstileToken: turnstileToken(form),
      });
      renderDone(res);
    } catch (e2) {
      // Капча одноразовая - после ошибки берём свежий токен, иначе повтор «протухнет».
      resetTurnstile();

      // Воркер может вернуть не текст, а разбор: это время не подходит,
      // вот подходящие. Показываем их кнопками, чтобы человек не искал заново.
      const compact = parseCompact(e2.message);
      if (compact) {
        renderCompactChoice(compact);
        return;
      }

      const spam = /turnstile|spam check/i.test(e2.message || '');
      err.textContent = spam
        ? 'Couldn’t verify you’re human. Please tap Confirm to try again - or call/WhatsApp us and we’ll book you in.'
        : e2.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = 'Confirm booking';
    }
  }

  /** Ответ «нужно другое время» приходит разбором внутри сообщения об ошибке. */
  function parseCompact(msg) {
    if (!msg || msg.indexOf('needs_compact_slot') < 0) return null;
    try {
      const d = JSON.parse(msg);
      return d && d.code === 'needs_compact_slot' && Array.isArray(d.times) ? d : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Экран «выберите из этих окон».
   * Говорим правду: время не занято, оно требует подтверждения с нашей
   * стороны. Писать «уже занято» нельзя - человек может видеть его
   * свободным в соседней вкладке, и это поймают.
   */
  function renderCompactChoice(d) {
    const times = d.times.map((t) => `
      <button type="button" class="bk-slot" data-compact="${t}">
        <span>${timeLabel(t)}</span>
        <span class="bk-slot-who">${dayLabel(t)}</span>
      </button>`).join('');

    shell('Let’s pick another time', d.message,
      times
        ? `<div class="bk-slots">${times}</div>
           <p class="bk-sub" style="margin-top:18px">Or call <a href="tel:+17542026666">(754) 202-6666</a> and we’ll set it up.</p>`
        : `<p class="bk-sub">Please call <a href="tel:+17542026666">(754) 202-6666</a> and we’ll find a time together.</p>`,
      { back: true, eyebrow: 'Online booking' });

    const root2 = document.getElementById('booking-app');
    root2.addEventListener('click', (ev) => {
      const b = ev.target.closest && ev.target.closest('[data-compact]');
      if (!b) return;
      // Возвращаемся к форме с уже выбранным новым временем: всё,
      // что человек ввёл, сохранено в state и подставится заново.
      state.slot = Object.assign({}, state.slot, { startAt: b.dataset.compact });
      renderDetails();
    }, { once: true });
  }

  function renderDone(res) {
    state.step = 'done';
    const svc = getService(state.serviceId);
    const m = state.masters[state.slot.masterId];
    const masterLabel = svc && svc.dualMaster
      ? svc.dualMaster.map((s) => (state.masters[s.masterId] || {}).name).filter(Boolean).join(' + ')
      : (m ? m.name : '');
    // Конверсия «бронь создана» - отдельно по категории услуги (nails/massage),
    // строго после успешного ответа воркера. Параметры собираем защищённо: отсутствие
    // любого необязательного поля не должно помешать отправке события.
    try {
      const _cat = svc && svc.cat;
      const _catId = _cat && _cat.id;
      const _catName = (_cat && _cat.name) || '';
      // Категория из id ('nail'/'massage'); фолбэк - по имени.
      const _serviceCategory = _catId === 'massage' || /massage/i.test(_catName) ? 'massage' : 'nails';
      const _slot = state.slot || {};
      const _ls = lengthsFor(state.serviceId, _slot.masterId);
      const _lenName = _ls && state.length ? ((_ls.find((L) => L.id === state.length) || {}).name) : null;
      const _fullName = ((svc && svc.name) || state.serviceId || '') + (_lenName ? ' · ' + _lenName : '');
      const _value = Number(_slot.price) || 0;
      // Товар для GA4 purchase - тот же, что в booking_completed.
      const _item = {
        item_id: (svc && svc.id) || state.serviceId || undefined,
        item_name: _fullName,
        item_category: (_cat && _cat.name) || undefined,
        item_variant: (m && m.name) || undefined,
        price: _value,
        quantity: 1,
      };
      trackBookingCompleted({
        service_category: _serviceCategory,
        service_name: _fullName,
        specialist: (m && m.name) || '',
        value: _value,
        currency: 'USD',
        booking_id: (res && res.bookingId) || '',
      }, _item);
    } catch (err) {
      try { console.error('tracking build failed', err); } catch (_) {}
    }
    // Дизайн платится сверх услуг: на самом визите (основная и вторая запись)
    // и на маникюре к массажу (там он вписан в строку доп-услуги).
    const designs = res.designs || [];
    const visitDesigns = designs.filter((d) => d.where !== 'addon');
    const addonDesigns = designs.filter((d) => d.where === 'addon');
    const sumUsd = (list) => list.reduce((s, d) => s + (Number(d.priceUsd) || 0), 0);
    const namesOf = (list) => list.map((d) => `${d.name} (${d.area})`).join(' + ');
    const segs = state.slot.pair ? state.slot.segments : null;
    const whoLabel = segs
      ? [...new Set(segs.map((sg) => (state.masters[sg.masterId] || {}).name).filter(Boolean))].join(' + ')
      : masterLabel;
    const payLine = res.paidWith === 'package'
      ? `${whoLabel} · Paid with package${res.sessionsLeft != null ? ` · ${res.sessionsLeft} sessions left` : ''}`
      : `${whoLabel} · ${fmtMoney(state.slot.price + sumUsd(visitDesigns))}${visitDesigns.length ? ` incl. ${namesOf(visitDesigns)} design${visitDesigns.length > 1 ? 's' : ''}` : ''} (pay in person)`;
    const designHtml = res.paidWith === 'package' && visitDesigns.length
      ? `<div class="bk-done-addon"><div><b>+ ${namesOf(visitDesigns)} design${visitDesigns.length > 1 ? 's' : ''}</b></div><div>${fmtMoney(sumUsd(visitDesigns))}, paid at the studio</div></div>`
      : '';
    // доп-услуга: подтверждена, либо честно сообщаем, что не прошла
    const addonHtml = res.addon
      ? `<div class="bk-done-addon">
           <div><b>+ ${res.addon.name}</b></div>
           <div>${dayLabel(res.addon.startAt)}, ${timeLabel(res.addon.startAt)} · ${res.addon.masterName} · ${fmtMoney(res.addon.priceWithDiscount + sumUsd(addonDesigns))} <s>${fmtMoney(res.addon.price)}</s>${addonDesigns.length ? ` · incl. ${namesOf(addonDesigns)} design` : ''}</div>
         </div>`
      : (res.addonFailed
          ? `<div class="bk-done-addon bk-done-addon-warn">
               We couldn’t hold the extra slot — we’ll call you to sort it out.
             </div>`
          : '');

    // Запись принимается сразу, а письмо с адресом и подсказкой про парковку
    // уходит при записи, поэтому «подтвердим позже» было бы неправдой.
    shell('You’re booked! 🎉', 'Your confirmation and directions are on their way to your email.',
      `<div class="bk-summary bk-summary-done">
         <div><b>${segs ? segs.map((sg) => getService(sg.serviceId).name).join(' + ') : svc.name}</b></div>
         <div>${dayLabel(state.slot.startAt)}, ${timeLabel(state.slot.startAt)}${segs ? ` · ${fmtDur(state.slot.durationMin)} in total` : ''}</div>
         ${segs ? segs.map((sg) => `<div>${timeLabel(sg.startAt)} · ${getService(sg.serviceId).name}</div>`).join('') : ''}
         <div>${payLine}</div>
         ${designHtml}
         ${addonHtml}
       </div>
       <a href="index.html" class="btn btn-dark" style="margin-top:18px;display:inline-block">Back to site</a>`,
      { eyebrow: 'Confirmed' });
  }

  // ── navigation ─────────────────────────────────────────────────────
  function back() {
    const order = ['category', 'subcategory', 'service', 'master', 'time', 'details'];
    const map = {
      details: 'time',
      wait: 'time',
      xsvc: 'time',
      xmaster: 'xsvc',
      xlength: 'xmaster',
      time: () => {
        const svc = getService(state.serviceId);
        if (svc && svc.dualMaster) return 'service';
        return lengthsFor(state.serviceId, state.masterId) ? 'length' : 'master';
      },
      length: 'master',
      master: 'service',
      service: () => {
        const cat = visibleCats().find((c) => c.id === state.categoryId);
        return cat.subcategories.length === 1 ? 'category' : 'subcategory';
      },
      subcategory: 'category',
    };
    let prev = map[state.step];
    if (typeof prev === 'function') prev = prev();
    // пропуск выбора мастера, если он был один
    if (prev === 'master') {
      const svc = getService(state.serviceId);
      if (svc.masters.length === 1) prev = 'service';
      // Мастер выбран карточкой: этого шага вперёд не было, назад его тоже
      // нет. Иначе renderMaster сам бы отправил клиента вперёд, по кругу.
      else if (state.preferMaster && svc.masters.some((m) => m.masterId === state.preferMaster)) prev = 'service';
    }
    ({ category: renderCategory, subcategory: renderSubcategory, service: renderService, master: renderMaster, length: renderLength, time: loadTime, details: renderDetails, xsvc: renderExtraService, xmaster: renderExtraMaster }[prev] || renderCategory)();
  }

  // ── click delegation ───────────────────────────────────────────────
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'back') return goBack();
    if (act === 'allmasters') {
      // Выход из режима «к мастеру»: полное меню и ссылка без ?master.
      state.preferMaster = null;
      state.serviceId = null; state.masterId = null; state.slot = null; state.length = null;
      state.second = null; state.xPick = null;
      setUrlParams({ master: null });
      return renderCategory();
    }
    if (act === 'cat') { state.categoryId = t.dataset.id; state.subcategoryId = null; return renderSubcategory(); }
    if (act === 'sub') { state.subcategoryId = t.dataset.id; return renderService(); }
    if (act === 'wait') { return renderWaitForm(); }
    if (act === 'xadd') { return renderExtraService(); }
    if (act === 'xrm') { state.second = null; state.sameTime = null; state.slot = null; return loadTime(); }
    if (act === 'sametime') {
      // Перешли на комбо Same Time: вместо двух услуг подряд одна запись у двух мастеров.
      const combo = sameTimeFor();
      const s = state.sameTime && state.sameTime.slots && state.sameTime.slots[+t.dataset.i];
      if (!combo || !s) return;
      state.serviceId = combo.id; state.masterId = null; state.length = null;
      state.second = null; state.xPick = null; state.sameTime = null;
      state.slot = s; state.selectedDay = dayKey(s.startAt);
      state.addon = null; state.addonOptions = null; state.design = { hands: null, feet: null };
      track('select_item', { items: [gaItem()] });
      return renderDetails();
    }
    if (act === 'xsvc') { state.xPick = { serviceId: t.dataset.id, masterId: null }; return renderExtraMaster(); }
    if (act === 'xmaster') { return pickExtraMaster(t.dataset.id); }
    if (act === 'xlength') { return finishExtra(t.dataset.id); }
    if (act === 'svc') {
      state.serviceId = t.dataset.id; state.masterId = null; state.slot = null; state.length = null;
      state.second = null; state.xPick = null; state.sameTime = null;   // другая первая услуга - вторая выбирается заново
      track('select_item', { items: [gaItem()] });
      const _svc = getService(state.serviceId);
      return _svc && _svc.dualMaster ? loadTime() : renderMaster();
    }
    if (act === 'master') { state.masterId = t.dataset.id || null; return maybeLengthThenTime(); }
    if (act === 'length') { state.length = t.dataset.id; return loadTime(); }
    if (act === 'day') { state.selectedDay = t.dataset.id; return renderTime(); }
    if (act === 'month') { return goMonth(+t.dataset.dir); }
    if (act === 'slot') {
      const day = t.dataset.day;
      const byDay = state.monthCache[monthKey(+day.slice(0, 4), +day.slice(5, 7) - 1)] || {};
      const s = (byDay[day] || [])[+t.dataset.i];
      if (!s) return;
      state.slot = s;
      state.selectedDay = day;
      state.addon = null;
      state.addonOptions = null;
      state.design = { hands: null, feet: null };
      renderDetails();
      // Массаж к ногтям предлагаем и к одной услуге, и к двум подряд: тогда
      // ищем вплотную ко всему блоку (slot.startAt и slot.durationMin - его).
      loadAddonOptions();   // подгружаем в фоне — форма не ждёт
      return;
    }
    if (act === 'design') {
      const area = t.dataset.area;
      if (area !== 'hands' && area !== 'feet') return;
      state.design[area] = state.design[area] === t.dataset.id ? null : t.dataset.id;   // повторный клик снимает
      renderDesignBlock();
      updateAddonSummary();
      return;
    }
    if (act === 'addon') {
      const i = +t.dataset.i;
      const opt = (state.addonOptions || [])[i];
      if (!opt) return;
      // повторный клик снимает выбор
      const same = state.addon && state.addon.startAt === opt.startAt && state.addon.serviceId === opt.serviceId
        && state.addon.masterId === opt.masterId && state.addon.length === opt.length;
      state.addon = same ? null : opt;
      renderAddonBlock();
      renderDesignBlock();
      updateAddonSummary();
      return;
    }
  });

  /** Правим параметры адресной строки без перезагрузки; null убирает параметр. */
  function setUrlParams(changes) {
    try {
      const u = new URL(location.href);
      for (const [k, v] of Object.entries(changes)) {
        if (v == null) u.searchParams.delete(k); else u.searchParams.set(k, v);
      }
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (_) { /* адресная строка - удобство, не необходимость */ }
  }

  /**
   * Открыть меню записи конкретного мастера. Зовётся и по клику на карточку
   * мастера, и из ссылки booking.html?master=ksenia.
   */
  function startWithMaster(id, { catId, subId } = {}) {
    if (!state.masters || !state.masters[id]) return false;
    state.preferMaster = id;
    state.serviceId = null; state.masterId = null; state.slot = null; state.length = null;
    state.addon = null; state.addonOptions = null;
    const cats = visibleCats();
    if (!cats.length) { state.preferMaster = null; return false; }

    const cat = cats.find((c) => c.id === catId) || (cats.length === 1 ? cats[0] : null);
    if (!cat) { renderCategory(); return true; }
    state.categoryId = cat.id;
    const sub = subId && cat.subcategories.find((s) => s.id === subId);
    if (sub) { state.subcategoryId = sub.id; renderService(); return true; }
    state.subcategoryId = null;
    renderSubcategory();
    return true;
  }

  // Клик по карточке мастера на странице записи. Без перезагрузки: клиент уже
  // здесь, и выбор не должен сбрасываться миганием страницы. Ссылка остаётся
  // настоящей, поэтому «открыть в новой вкладке» и копирование адреса работают.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-master-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!state.categories) return;   // каталог ещё не пришёл: пусть ссылка откроет страницу заново
    if (!startWithMaster(a.dataset.masterLink)) return;
    e.preventDefault();
    setUrlParams({ master: a.dataset.masterLink, category: null, subcategory: null, service: null });
    scrollToMenu();
  });

  /**
   * Подвести страницу к меню записи. Карточки мастеров стоят над ним, и на
   * телефоне меню после клика оказывается ниже экрана: без прокрутки человек
   * решит, что ничего не произошло. Отступ на липкую шапку считаем сами:
   * scrollIntoView прижал бы верх меню прямо под неё, и заголовок был бы закрыт.
   */
  function scrollToMenu() {
    try {
      const header = document.querySelector('header');
      const stuck = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().height : 0;
      const top = root.getBoundingClientRect().top + window.scrollY - stuck - 12;
      const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: Math.max(0, top), behavior: calm ? 'instant' : 'smooth' });
    } catch (_) { /* прокрутка - удобство, без неё меню всё равно открыто */ }
  }

  // ── Массаж в тот же день ───────────────────────────────────────────
  // Показываем только те сеансы, которые примыкают к выбранному слоту
  // (сразу после или прямо перед), чтобы не обещать невозможное.
  async function loadAddonOptions() {
    const svc = getService(state.serviceId);
    if (!svc || svc.dualMaster || (svc.cat.id !== 'nail' && svc.cat.id !== 'massage')) return;
    try {
      const r = await api('/api/addon-slots', {
        startAt: state.slot.startAt,
        durationMin: state.slot.durationMin || svc.durationMin,
        fromCategory: svc.cat.id,
      });
      state.addonOptions = r.options || [];
      state.addonDiscount = r.discountUsd || 20;
      renderAddonBlock();
    } catch (_) { /* нет доп-услуг — просто не показываем блок */ }
  }

  function renderAddonBlock() {
    const box = document.getElementById('bk-addon');
    if (!box) return;
    const opts = state.addonOptions || [];
    const form = document.getElementById('bk-form');
    const withPackage = isMassageNow() && form && form.elements.packageGan && form.elements.packageGan.value.trim();
    if (!opts.length || withPackage) { if (withPackage) state.addon = null; box.innerHTML = ''; return; }
    const toNails = isMassageNow();

    const rows = opts.map((o, i) => {
      const on = state.addon && state.addon.startAt === o.startAt && state.addon.serviceId === o.serviceId
        && state.addon.masterId === o.masterId && state.addon.length === o.length;
      const when = o.when === 'after' ? `right after your ${toNails ? 'massage' : 'nails'}` : `right before your ${toNails ? 'massage' : 'nails'}`;
      const label = toNails
        ? `Gel manicure${o.lengthName ? ' (' + o.lengthName.toLowerCase() + ')' : ''} · ${o.masterName}`
        : `${o.durationMin} min massage · ${o.masterName}`;
      return `<button type="button" class="bk-addon-opt${on ? ' on' : ''}" data-act="addon" data-i="${i}" aria-pressed="${on}">
          <span class="bk-addon-main">
            <span class="bk-addon-name">${label}</span>
            <span class="bk-addon-when">${when} · ${timeLabel(o.startAt)}</span>
          </span>
          <span class="bk-addon-price"><s>${fmtMoney(o.price)}</s> ${fmtMoney(o.priceWithDiscount)}</span>
        </button>`;
    }).join('');

    box.innerHTML = `
      <div class="bk-addon-box">
        <p class="bk-addon-title">${toNails ? 'Add a Russian manicure' : 'Add a massage'} the same day — save $${state.addonDiscount || 20}</p>
        <p class="bk-addon-sub">One visit instead of two. ${toNails ? 'Only times right next to your massage are shown.' : 'Ivan is free around your appointment.'}</p>
        ${rows}
      </div>`;
  }

  // подстрока с итогом в сводке заказа
  function updateAddonSummary() {
    const el = document.getElementById('bk-total-line');
    if (!el) return;
    const pair = !!(state.slot && state.slot.pair);
    if (!state.addon && !designPrice() && !pair) { el.innerHTML = ''; return; }
    const total = (Number(state.slot.price) || 0) + (state.addon ? Number(state.addon.priceWithDiscount) || 0 : 0) + designPrice();
    const parts = [];
    if (state.addon) parts.push(isMassageNow() ? 'gel manicure' : state.addon.durationMin + ' min massage');
    if (designPrice()) parts.push(designCount() > 1 ? 'designs' : 'design');
    el.innerHTML = pair && !parts.length
      ? `<div class="bk-total"><b>${fmtMoney(total)} total</b></div>`
      : `<div class="bk-total">${pair ? '2 services ' : ''}+ ${parts.join(' + ')} · <b>${fmtMoney(total)} total</b></div>`;
  }

  // ── диплинк по параметрам ссылки ───────────────────────────────────
  // booking.html?service=ID&master=ID → сразу к услуге (и мастеру)
  // booking.html?subcategory=ID → сразу к списку услуг подраздела
  // booking.html?category=ID → сразу к подразделам раздела
  function applyDeepLink() {
    const p = new URLSearchParams(location.search);
    const serviceId = p.get('service');
    const masterId = p.get('master');
    const lengthParam = p.get('length');
    const subId = p.get('subcategory');
    const catId = p.get('category');

    // ?master=ksenia без услуги: меню записи этого мастера. С услугой
    // (?service=…&master=…) работает прежний путь - его используют письма.
    if (masterId && !serviceId && startWithMaster(masterId, { catId, subId })) return;

    if (serviceId) {
      const svc = getService(serviceId);
      if (svc) {
        state.categoryId = svc.cat.id;
        state.subcategoryId = svc.sub.id;
        state.serviceId = serviceId;
        if (svc.dualMaster) { track('select_item', { items: [gaItem()] }); return loadTime(); }
        if (masterId && svc.masters.some((m) => m.masterId === masterId)) state.masterId = masterId;
        if (lengthParam) {
          const ls = lengthsFor(serviceId, state.masterId);
          if (ls && ls.some((L) => L.id === lengthParam)) state.length = lengthParam;
        }
        // Ссылка из письма листа ожидания: к первой услуге добавляется вторая
        // (?add=…&addmaster=…&addlength=…), чтобы клиент не собирал пару заново.
        const addId = p.get('add');
        const s2 = addId ? getService(addId) : null;
        if (s2 && pairable(svc) && pairable(s2) && s2.id !== svc.id && s2.sub.id !== svc.sub.id) {
          const am = p.get('addmaster');
          const aMaster = am && s2.masters.some((m) => m.masterId === am) ? am : null;
          const als = aMaster ? lengthsFor(addId, aMaster) : null;
          const al = p.get('addlength');
          state.second = { serviceId: addId, masterId: aMaster, length: als && al && als.some((L) => L.id === al) ? al : null };
        }
        track('select_item', { items: [gaItem()] });
        return state.masterId ? maybeLengthThenTime() : renderMaster();
      }
    }
    if (subId) {
      for (const c of state.categories) {
        const sub = c.subcategories.find((s) => s.id === subId);
        if (sub) { state.categoryId = c.id; state.subcategoryId = subId; return renderService(); }
      }
    }
    if (catId) {
      const c = state.categories.find((x) => x.id === catId);
      if (c) { state.categoryId = catId; return renderSubcategory(); }
    }
    renderCategory();
  }

  // ── Ближайшее окно каждого мастера ────────────────────────────────
  //
  // Раньше под именами стояли зашитые обещания: «2-3 weeks ahead»,
  // «available this week». Они устаревали молча и работали против нас:
  // в свободную неделю отпугивали, в занятую обещали несуществующее.
  // Теперь дата берётся из /api/next-available — он уже считает ближайший
  // свободный слот каждого мастера и кеширует ответ на стороне воркера.
  //
  // Ногти спрашиваем один раз: у гель-маникюра оба мастера, и один ответ
  // покрывает и Ксению, и Анастасию.
  const NEXT_FOR = [
    { serviceId: 'gel-manicure', masters: ['ksenia', 'anastasia'] },
    { serviceId: 'full-body-reset', masters: ['ivan'] },
  ];
  const NEXT_HORIZON_DAYS = 21;   // настолько вперёд ищет воркер

  /** «today», «tomorrow», «Thursday», «Nov 4» — чем ближе, тем короче. */
  function whenWord(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOf(d) - startOf(new Date())) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    // В пределах недели день недели читается как расстояние, а дата
    // заставляет считать.
    if (days < 7) return d.toLocaleDateString(CONFIG.locale, { weekday: 'long' });
    return d.toLocaleDateString(CONFIG.locale, { month: 'short', day: 'numeric' });
  }

  async function paintNextAvailable() {
    const cells = document.querySelectorAll('.bk-spec-avail[data-master]');
    if (!cells.length) return;

    const next = {};     // мастер → ISO ближайшего слота
    const asked = {};     // мастер → ответил ли ЕГО запрос
    await Promise.all(NEXT_FOR.map(async (g) => {
      let res = null;
      try {
        res = await api('/api/next-available', { serviceId: g.serviceId });
      } catch (_) {
        // Молча: в разметке уже стоит запасной текст без даты.
      }
      for (const m of g.masters) {
        // Признак ведём по каждому мастеру отдельно. Иначе упавший запрос
        // по ногтям в паре с удачным по массажу выдал бы Ксении «занято
        // на 3+ недели» — ложь из-за сетевой ошибки, а не из-за занятости.
        asked[m] = !!res;
        if (res && res.next && res.next[m]) next[m] = res.next[m];
      }
    }));

    cells.forEach((el) => {
      const credit = (el.dataset.credit || '').trim();
      const id = el.dataset.master;
      const word = next[id] ? whenWord(next[id]) : null;

      let tail = null;
      if (word) {
        tail = `next opening ${word}`;
      } else if (asked[id]) {
        // Ответ пришёл, но мастера в нём нет — значит в горизонте поиска
        // у него пусто. Это и есть занятость, сказанная честно.
        tail = `booked ${Math.round(NEXT_HORIZON_DAYS / 7)}+ weeks out`;
      }
      // Запрос не прошёл — оставляем запасной текст из разметки.
      if (!tail) return;

      // Склеиваем только непустые части: у мастера может не быть заслуги,
      // и точка-разделитель не должна висеть в начале строки.
      el.textContent = [credit, tail].filter(Boolean).join(' · ');
    });
  }

  // ── boot ───────────────────────────────────────────────────────────
  (async function init() {
    captureClickIds();
    // Раздел из адреса применяем сразу, не дожидаясь каталога: страница
    // ногтей ведёт сюда с ?category=nail, и ряд мастеров не должен сначала
    // показать всех троих, а потом убрать лишнего.
    try { syncSpecialists(new URLSearchParams(location.search).get('category')); } catch (_) {}
    // Не ждём: карточки мастеров живут отдельно от формы записи, и сбой
    // здесь не должен мешать записаться.
    paintNextAvailable().catch(() => {});
    try {
      const cat = await api('/api/catalog');
      state.business = cat.business; state.masters = cat.masters; state.categories = cat.categories;
      state.designs = cat.designs || null;
      applyDeepLink();
    } catch (e) {
      root.innerHTML = `<div class="bk-card"><div class="bk-error">Booking is temporarily unavailable (${e.message}).<br>Please call (754) 202-6666.</div></div>`;
    }
  })();
})();
