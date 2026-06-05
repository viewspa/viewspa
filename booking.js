/**
 * View Spa — booking flow (front-end).
 * Шаги: Category → Subcategory → Service → Master/Any → Date&Time → Details → Done.
 * Общается с Cloudflare Worker (см. CONFIG.apiBase).
 */
(function () {
  'use strict';

  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const CONFIG = {
    // Локально — wrangler dev; на проде — URL воркера (заполнить после деплоя).
    apiBase: isLocal ? 'http://localhost:8787' : 'https://viewspa-booking.ivanseydametov.workers.dev',
    // На localhost — тестовый site key Turnstile (всегда проходит, для разработки),
    // на проде — реальный публичный site key.
    turnstileSiteKey: isLocal ? '1x00000000000000000000AA' : '0x4AAAAAADdzLSWcgv1JlXj3',
    daysToShow: 21,
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
    slot: null,
    slotsByDay: null,
    selectedDay: null,
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
    const ps = svc.masters.map((m) => m.price);
    const lo = Math.min(...ps), hi = Math.max(...ps);
    return lo === hi ? fmtMoney(lo) : `${fmtMoney(lo)}–${fmtMoney(hi)}`;
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

  // Рендер Turnstile с ожиданием загрузки скрипта (виджет на динамической форме).
  function renderTurnstile() {
    if (!CONFIG.turnstileSiteKey) return;
    const el = root.querySelector('.cf-turnstile');
    if (!el || el.dataset.rendered === '1') return;
    let tries = 0;
    const tryRender = () => {
      if (window.turnstile && window.turnstile.render) {
        try { window.turnstile.render(el, { sitekey: CONFIG.turnstileSiteKey }); el.dataset.rendered = '1'; }
        catch (_) {}
      } else if (tries++ < 60) {
        setTimeout(tryRender, 100);
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
    const cur = STEPS.indexOf(state.step === 'subcategory' ? 'category' : state.step);
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
    // если всего одна подкатегория — пропускаем
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

  function renderMaster() {
    state.step = 'master';
    const svc = getService(state.serviceId);
    const masters = svc.masters.map((m) => ({ ...state.masters[m.masterId], price: m.price }));
    // один мастер — пропускаем выбор
    if (masters.length === 1) { state.masterId = masters[0].id; return loadTime(); }
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

  async function loadTime() {
    state.step = 'time';
    const svc = getService(state.serviceId);
    shell('Pick a date & time', `${svc.name}${state.masterId ? ' · ' + state.masters[state.masterId].name : ''}`,
      `<div class="bk-loading">Loading availability…</div>`, { back: true });
    try {
      const from = new Date();
      const to = new Date(Date.now() + CONFIG.daysToShow * 86400000);
      const { slots } = await api('/api/availability', {
        serviceId: state.serviceId, masterId: state.masterId || undefined,
        from: from.toISOString(), to: to.toISOString(),
      });
      const byDay = {};
      for (const s of slots) { (byDay[dayKey(s.startAt)] ||= []).push(s); }
      state.slotsByDay = byDay;
      state.selectedDay = Object.keys(byDay).sort()[0] || null;
      renderTime();
    } catch (e) {
      shell('Pick a date & time', '', `<div class="bk-error">Could not load availability: ${e.message}</div>`, { back: true });
    }
  }

  function renderTime() {
    const svc = getService(state.serviceId);
    const days = Object.keys(state.slotsByDay).sort();
    if (!days.length) {
      shell('Pick a date & time', svc.name, `<div class="bk-error">No available times in the next ${CONFIG.daysToShow} days. Please call us at (754) 202-6666.</div>`, { back: true });
      return;
    }
    const dayTabs = days.map((d) => {
      const iso = state.slotsByDay[d][0].startAt;
      return `<button class="bk-day ${d === state.selectedDay ? 'on' : ''}" data-act="day" data-id="${d}">${dayLabel(iso)}</button>`;
    }).join('');
    const slots = (state.slotsByDay[state.selectedDay] || [])
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .map((s, i) => {
        const tag = !state.masterId && s.masterId ? `<span class="bk-slot-who">${state.masters[s.masterId]?.name || ''}</span>` : '';
        return `<button class="bk-slot" data-act="slot" data-i="${i}" data-day="${state.selectedDay}">${timeLabel(s.startAt)}${tag}</button>`;
      }).join('');
    shell('Pick a date & time', `${svc.name}${state.masterId ? ' · ' + state.masters[state.masterId].name : ''}`,
      `<div class="bk-days">${dayTabs}</div><div class="bk-slots">${slots}</div>`, { back: true });
  }

  function renderDetails() {
    state.step = 'details';
    const svc = getService(state.serviceId);
    const m = state.masters[state.slot.masterId];
    track('begin_checkout', { currency: 'USD', value: state.slot.price, items: [gaItem()] });
    const summary = `
      <div class="bk-summary">
        <div><b>${svc.name}</b></div>
        <div>${dayLabel(state.slot.startAt)}, ${timeLabel(state.slot.startAt)} · ${fmtDur(svc.durationMin)}</div>
        <div>${m ? m.name : ''} · ${fmtMoney(state.slot.price)}</div>
      </div>`;
    const turnstile = CONFIG.turnstileSiteKey
      ? `<div class="cf-turnstile" data-sitekey="${CONFIG.turnstileSiteKey}"></div>` : '';
    shell('Your details', 'Pay in person at your appointment.',
      `${summary}
       <form id="bk-form" class="bk-form">
         <label>Full name<input name="name" required autocomplete="name"></label>
         <label>Email<input name="email" type="email" required autocomplete="email"></label>
         <label>Phone (optional)<input name="phone" type="tel" autocomplete="tel"></label>
         <label>Note (optional)<textarea name="note" rows="2"></textarea></label>
         <label>Package / gift card code (optional)<input name="packageGan" placeholder="Have a prepaid package? Enter code to redeem"></label>
         ${turnstile}
         <button type="submit" class="btn btn-gold bk-submit">Confirm booking</button>
         <div class="bk-error" id="bk-form-err" hidden></div>
       </form>`, { back: true });
    renderTurnstile();
    document.getElementById('bk-form').addEventListener('submit', submitBooking);
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
      const tsToken = form.querySelector('[name="cf-turnstile-response"]')?.value;
      const res = await api('/api/book', {
        serviceId: state.serviceId,
        masterId: state.slot.masterId,
        startAt: state.slot.startAt,
        serviceVariationVersion: state.slot.serviceVariationVersion,
        customer: { name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), note: fd.get('note') },
        packageGan: (fd.get('packageGan') || '').replace(/\s+/g, '') || undefined,
        turnstileToken: tsToken,
      });
      renderDone(res);
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Confirm booking';
    }
  }

  function renderDone(res) {
    state.step = 'done';
    const svc = getService(state.serviceId);
    const m = state.masters[state.slot.masterId];
    // GA4 конверсия по услуге (импортируется в Google Ads)
    track('purchase', {
      transaction_id: res.bookingId,
      currency: 'USD',
      value: state.slot.price,
      items: [gaItem()],
    });
    track('booking_completed', {
      currency: 'USD',
      value: state.slot.price,
      booking_id: res.bookingId,
      service_id: svc.id,
      service_name: svc.name,
      master: m ? m.name : '',
      source: 'site_booking',
    });
    const payLine = res.paidWith === 'package'
      ? `${m ? m.name : ''} · Paid with package${res.sessionsLeft != null ? ` · ${res.sessionsLeft} sessions left` : ''}`
      : `${m ? m.name : ''} · ${fmtMoney(state.slot.price)} (pay in person)`;
    shell('You’re booked! 🎉', 'A confirmation email is on its way.',
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
      details: 'time', time: 'master', master: 'service',
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
    ({ category: renderCategory, subcategory: renderSubcategory, service: renderService, master: renderMaster, time: loadTime, details: renderDetails }[prev] || renderCategory)();
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
      state.serviceId = t.dataset.id; state.masterId = null; state.slot = null;
      track('select_item', { items: [gaItem()] });
      return renderMaster();
    }
    if (act === 'master') { state.masterId = t.dataset.id || null; return loadTime(); }
    if (act === 'day') { state.selectedDay = t.dataset.id; return renderTime(); }
    if (act === 'slot') {
      const s = state.slotsByDay[t.dataset.day][+t.dataset.i];
      state.slot = s; return renderDetails();
    }
  });

  // ── диплинк по параметрам ссылки ───────────────────────────────────
  // booking.html?service=ID&master=ID  → сразу к услуге (и мастеру)
  // booking.html?subcategory=ID        → сразу к списку услуг подраздела
  // booking.html?category=ID           → сразу к подразделам раздела
  function applyDeepLink() {
    const p = new URLSearchParams(location.search);
    const serviceId = p.get('service');
    const masterId = p.get('master');
    const subId = p.get('subcategory');
    const catId = p.get('category');

    if (serviceId) {
      const svc = getService(serviceId);
      if (svc) {
        state.categoryId = svc.cat.id;
        state.subcategoryId = svc.sub.id;
        state.serviceId = serviceId;
        if (masterId && svc.masters.some((m) => m.masterId === masterId)) state.masterId = masterId;
        track('select_item', { items: [gaItem()] });
        return state.masterId ? loadTime() : renderMaster();
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
    try {
      const cat = await api('/api/catalog');
      state.business = cat.business; state.masters = cat.masters; state.categories = cat.categories;
      applyDeepLink();
    } catch (e) {
      root.innerHTML = `<div class="bk-card"><div class="bk-error">Booking is temporarily unavailable (${e.message}).<br>Please call (754) 202-6666.</div></div>`;
    }
  })();
})();
