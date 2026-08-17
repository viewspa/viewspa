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

  const state = {
    business: null,
    masters: null,
    categories: null,
    step: 'category',
    categoryId: null,
    subcategoryId: null,
    serviceId: null,
    masterId: null, // null = «любой/сравнить»
    length: null, // выбранная длина (short/medium/long) для услуг с длинами
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
    const cur = STEPS.indexOf(state.step === 'subcategory' ? 'category' : (state.step === 'length' ? 'master' : state.step));
    return `<div class="bk-progress">${STEPS.map((s, i) =>
      `<span class="bk-pstep ${i <= cur ? 'on' : ''}">${labels[s]}</span>`).join('<span class="bk-pline"></span>')}</div>`;
  }

  function shell(title, sub, inner, opts = {}) {
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
    const cards = state.categories.map((c) =>
      `<button class="bk-tile" data-act="cat" data-id="${c.id}">
         <span class="bk-tile-name">${c.name}</span>
         <span class="bk-tile-meta">${c.subcategories.reduce((n, s) => n + s.services.length, 0)} services ›</span>
       </button>`).join('');
    shell('What would you like to book?', 'Choose a service category to start.', `<div class="bk-grid">${cards}</div>`);
  }

  function renderSubcategory() {
    state.step = 'subcategory';
    const cat = state.categories.find((c) => c.id === state.categoryId);
    // если всего одна подкатегория - пропускаем
    if (cat.subcategories.length === 1) { state.subcategoryId = cat.subcategories[0].id; return renderService(); }
    const cards = cat.subcategories.map((s) =>
      `<button class="bk-tile" data-act="sub" data-id="${s.id}">
         <span class="bk-tile-name">${s.name}</span>
         <span class="bk-tile-meta">${s.services.length} services ›</span>
       </button>`).join('');
    shell(cat.name, 'Pick a category.', `<div class="bk-grid">${cards}</div>`, { back: true });
  }

  function renderService() {
    state.step = 'service';
    const cat = state.categories.find((c) => c.id === state.categoryId);
    const sub = cat.subcategories.find((s) => s.id === state.subcategoryId);
    const rows = sub.services.map((svc) =>
      `<button class="bk-svc" data-act="svc" data-id="${svc.id}">
         <span class="bk-svc-main">
           <span class="bk-svc-name">${svc.name}</span>
           <span class="bk-svc-dur">⏱ ${fmtDur(svc.durationMin)}</span>
         </span>
         <span class="bk-svc-price">${priceRange(svc)} ›</span>
       </button>`).join('');
    shell(sub.name, 'Select a service.', `<div class="bk-list">${rows}</div>`, { back: true });
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
    const masters = svc.masters.map((m) => ({ ...state.masters[m.masterId], price: m.price }));
    // один мастер - пропускаем выбор
    if (masters.length === 1) { state.masterId = masters[0].id; return maybeLengthThenTime(); }
    const cards = masters.map((m) =>
      `<button class="bk-master" data-act="master" data-id="${m.id}">
         <span class="bk-master-av">${m.name[0]}</span>
         <span class="bk-master-body">
           <span class="bk-master-name">${m.name}</span>
           <span class="bk-master-role">${m.role}</span>
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

    const { slots } = await api('/api/availability', {
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
    return `${svc.name}${state.masterId ? ' · ' + state.masters[state.masterId].name : ''}`;
  }

  async function loadTime() {
    state.step = 'time';
    const now = new Date();
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
      const who = !state.masterId && slot.masterId ? `<em>${state.masters[slot.masterId]?.name || ''}</em>` : '';
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
      const tag = !state.masterId && s.masterId ? `<span class="bk-slot-who">${state.masters[s.masterId]?.name || ''}</span>` : '';
      return `<button class="bk-slot" data-act="slot" data-i="${i}" data-day="${state.selectedDay}">${timeLabel(s.startAt)}${tag}</button>`;
    }).join('');
    return `<div class="bk-day-slots">
              <p class="bk-block-title">${dayLabel(list[0].startAt)} · ${list.length} time${list.length > 1 ? 's' : ''}</p>
              <div class="bk-slots">${slots}</div>
            </div>`;
  }

  function renderTime() {
    const anySlots = Object.values(state.monthCache).some((byDay) => Object.keys(byDay).length);
    if (!anySlots && Object.keys(state.monthCache).length >= 2) {
      shell('Pick a date & time', timeHeader(),
        `${calendarHtml()}<div class="bk-error">Nothing free in this window. Please call us at (754) 202-6666 and we will find a time.</div>`,
        { back: true });
      return;
    }
    shell('Pick a date & time', timeHeader(),
      `${soonestHtml()}${calendarHtml()}${slotsHtml()}`, { back: true });
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
    const summary = `
      <div class="bk-summary">
        <div><b>${svc.name}${_lenName ? ' · ' + _lenName + ' length' : ''}</b></div>
        <div>${dayLabel(state.slot.startAt)}, ${timeLabel(state.slot.startAt)} · ${fmtDur(svc.durationMin)}</div>
        <div>${masterLabel} · ${fmtMoney(state.slot.price)}</div>
      </div>`;
    const turnstile = CONFIG.turnstileSiteKey
      ? `<div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div>` : '';
    shell('Your details', 'Pay in person at your appointment.',
      `${summary}
       <form id="bk-form" class="bk-form">
         <label>Full name<input name="name" required autocomplete="name"></label>
         <label>Phone
           <input name="phone" type="tel" inputmode="tel" required autocomplete="tel" placeholder="(305) 555-1234" title="Your mobile number - we’ll text your confirmation">
         </label>
         <label>Email (optional)<input name="email" type="email" autocomplete="email"></label>
         <label>Note (optional)<textarea name="note" rows="2"></textarea></label>
         <label>Package / gift card code (optional)<input name="packageGan" placeholder="Have a prepaid package? Enter code to redeem"></label>
         <label class="bk-agree">
           <input type="checkbox" name="agreePolicy" required>
           <span>I can cancel or reschedule free up to 24 hours before. Later than that is 50%, a no-show is the full price — <a href="cancellation-policy.html" target="_blank" rel="noopener">cancellation policy</a>.</span>
         </label>
         ${turnstile}
         <button type="submit" class="btn btn-gold bk-submit">Confirm booking</button>
         <div class="bk-error" id="bk-form-err" hidden></div>
       </form>`, { back: true });
    renderTurnstile();
    const _form = document.getElementById('bk-form');
    // Телефон нормализуем при отправке (см. normalizePhone), а НЕ по ходу ввода - чтобы
    // клиент мог писать привычно: (305) 555-1234. Код страны (+1) подставляется сам.
    _form.addEventListener('submit', submitBooking);
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
      const res = await api('/api/book', {
        serviceId: state.serviceId,
        masterId: state.slot.masterId,
        length: state.length || undefined,
        startAt: state.slot.startAt,
        serviceVariationVersion: state.slot.serviceVariationVersion,
        customer: { name: fd.get('name'), email: fd.get('email'), phone, note: fd.get('note') },
        packageGan: (fd.get('packageGan') || '').replace(/\s+/g, '') || undefined,
        gclid: storedClickId('gclid') || undefined,
        gbraid: storedClickId('gbraid') || undefined,
        wbraid: storedClickId('wbraid') || undefined,
        turnstileToken: turnstileToken(form),
      });
      renderDone(res);
    } catch (e2) {
      // Капча одноразовая - после ошибки берём свежий токен, иначе повтор «протухнет».
      resetTurnstile();
      const spam = /turnstile|spam check/i.test(e2.message || '');
      err.textContent = spam
        ? 'Couldn’t verify you’re human. Please tap Confirm to try again - or call/WhatsApp us and we’ll book you in.'
        : e2.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = 'Confirm booking';
    }
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
    const payLine = res.paidWith === 'package'
      ? `${masterLabel} · Paid with package${res.sessionsLeft != null ? ` · ${res.sessionsLeft} sessions left` : ''}`
      : `${masterLabel} · ${fmtMoney(state.slot.price)} (pay in person)`;
    shell('You’re booked! 🎉', 'We’ll confirm your appointment shortly.',
      `<div class="bk-summary bk-summary-done">
         <div><b>${svc.name}</b></div>
         <div>${dayLabel(state.slot.startAt)}, ${timeLabel(state.slot.startAt)}</div>
         <div>${payLine}</div>
       </div>
       <a href="index.html" class="btn btn-dark" style="margin-top:18px;display:inline-block">Back to site</a>`,
      { eyebrow: 'Confirmed' });
  }

  // ── navigation ─────────────────────────────────────────────────────
  function back() {
    const order = ['category', 'subcategory', 'service', 'master', 'time', 'details'];
    const map = {
      details: 'time',
      time: () => {
        const svc = getService(state.serviceId);
        if (svc && svc.dualMaster) return 'service';
        return lengthsFor(state.serviceId, state.masterId) ? 'length' : 'master';
      },
      length: 'master',
      master: 'service',
      service: () => {
        const cat = state.categories.find((c) => c.id === state.categoryId);
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
    }
    ({ category: renderCategory, subcategory: renderSubcategory, service: renderService, master: renderMaster, length: renderLength, time: loadTime, details: renderDetails }[prev] || renderCategory)();
  }

  // ── click delegation ───────────────────────────────────────────────
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'back') return back();
    if (act === 'cat') { state.categoryId = t.dataset.id; state.subcategoryId = null; return renderSubcategory(); }
    if (act === 'sub') { state.subcategoryId = t.dataset.id; return renderService(); }
    if (act === 'svc') {
      state.serviceId = t.dataset.id; state.masterId = null; state.slot = null; state.length = null;
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
      return renderDetails();
    }
  });

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

  // ── boot ───────────────────────────────────────────────────────────
  (async function init() {
    captureClickIds();
    try {
      const cat = await api('/api/catalog');
      state.business = cat.business; state.masters = cat.masters; state.categories = cat.categories;
      applyDeepLink();
    } catch (e) {
      root.innerHTML = `<div class="bk-card"><div class="bk-error">Booking is temporarily unavailable (${e.message}).<br>Please call (754) 202-6666.</div></div>`;
    }
  })();
})();
