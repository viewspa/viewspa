/**
 * View Spa — Booking Worker (Cloudflare)
 *
 * Тонкий прокси между сайтом (GitHub Pages) и Square Bookings API.
 * Хранит секретный Square-токен, прячет его от браузера, добавляет
 * защиту от спама (Cloudflare Turnstile).
 *
 * Эндпоинты:
 *   GET  /api/catalog       → каталог услуг/мастеров/цен (без секретов)
 *   POST /api/availability  → свободные слоты {serviceId, masterId?, from, to}
 *   POST /api/book          → создать запись {serviceId, masterId, startAt, customer, turnstileToken}
 *   GET  /api/health        → проверка живости + статус Appointments
 *
 * Переменные окружения (wrangler.toml / secrets):
 *   SQUARE_ACCESS_TOKEN  (secret)  — токен Square
 *   SQUARE_API_BASE                — https://connect.squareupsandbox.com или connect.squareup.com
 *   SQUARE_LOCATION_ID             — ID локации
 *   SQUARE_VERSION                 — например 2025-10-16
 *   TURNSTILE_SECRET    (secret)   — секрет Cloudflare Turnstile (можно пусто на этапе разработки)
 *   ALLOWED_ORIGIN                 — домен сайта для CORS (например https://view-spa.com)
 */

import { CATALOG, MASTERS, BUSINESS, PACKAGES, CERTIFICATE, indexServices } from './catalog.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(await health(env), env);
      }
      if (url.pathname === '/api/catalog' && request.method === 'GET') {
        return json(publicCatalog(), env);
      }
      if (url.pathname === '/api/availability' && request.method === 'POST') {
        return json(await availability(request, env), env);
      }
      if (url.pathname === '/api/book' && request.method === 'POST') {
        return json(await book(request, env), env);
      }
      if (url.pathname === '/api/cancel-booking' && request.method === 'GET') {
        return cancelBookingPage(url, env);
      }
      if (url.pathname === '/api/accept-booking' && request.method === 'GET') {
        return acceptBookingPage(url, env);
      }
      if (url.pathname === '/api/payment-config' && request.method === 'GET') {
        return json(paymentConfig(env), env);
      }
      if (url.pathname === '/api/packages' && request.method === 'GET') {
        return json({ packages: Object.values(PACKAGES), certificate: CERTIFICATE }, env);
      }
      if (url.pathname === '/api/buy-package' && request.method === 'POST') {
        return json(await buyPackage(request, env), env);
      }
      if (url.pathname === '/api/buy-certificate' && request.method === 'POST') {
        return json(await buyCertificate(request, env), env);
      }
      if (url.pathname === '/api/package-balance' && request.method === 'POST') {
        return json(await packageBalance(request, env), env);
      }
      return json({ error: 'Not found' }, env, 404);
    } catch (err) {
      return json({ error: err.message || 'Internal error' }, env, err.status || 500);
    }
  },
};

// ── Каталог для фронтенда (без внутренних square id) ────────────────
function publicCatalog() {
  const masters = Object.fromEntries(
    Object.values(MASTERS).map((m) => [m.id, { id: m.id, name: m.name, role: m.role }])
  );
  // Возвращаем структуру как есть — squareId фронту не нужен, но и не вреден.
  return { business: BUSINESS, masters, categories: CATALOG.categories };
}

// ── Проверка живости + статус Appointments ──────────────────────────
async function health(env) {
  let appointments = false;
  let detail = null;
  try {
    const res = await square(env, 'GET', '/v2/bookings/business-booking-profile');
    appointments = !!res.business_booking_profile;
  } catch (e) {
    detail = e.message;
  }
  return {
    ok: true,
    env: env.SQUARE_API_BASE?.includes('sandbox') ? 'sandbox' : 'production',
    location: env.SQUARE_LOCATION_ID,
    appointmentsEnabled: appointments,
    detail,
  };
}

// ── Поиск доступности ───────────────────────────────────────────────
// Разрешение вариации услуги с учётом длины (Short/Medium/Long у некоторых услуг).
// Если length не передан или у услуги нет длин — берётся базовая вариация мастера.
function pickVariation(entry, length) {
  if (length && Array.isArray(entry.lengths)) {
    const L = entry.lengths.find((x) => x.id === length);
    if (L) return { squareVariationId: L.squareVariationId, price: L.price, durationMin: entry.durationMin };
  }
  return { squareVariationId: entry.squareVariationId, price: entry.price, durationMin: entry.durationMin };
}

async function availability(request, env) {
  const body = await request.json();
  const { serviceId, masterId, from, to, length } = body;
  const services = indexServices();
  const svc = services[serviceId];
  if (!svc) throw httpError(400, `Unknown service: ${serviceId}`);

  // Кандидаты «мастер + его вариация услуги» (своя цена/variation на каждого).
  let candidates = svc.masters.filter((m) => m.squareVariationId);
  if (masterId) {
    candidates = candidates.filter((m) => m.masterId === masterId);
    if (!candidates.length) throw httpError(400, `Master ${masterId} does not offer ${serviceId}`);
  }
  if (!candidates.length) throw httpError(400, 'No seeded variations for this service');

  const teamToMaster = Object.fromEntries(
    Object.values(MASTERS)
      .filter((m) => m.squareTeamMemberId)
      .map((m) => [m.squareTeamMemberId, m.id])
  );

  // Square: один запрос = одна service_variation_id. Цена у мастеров разная →
  // у каждого своя вариация → ищем по каждой и объединяем результат.
  const slotMap = new Map(); // ключ startAt|masterId → слот (дедуп)
  for (const c of candidates) {
    const teamId = env.SANDBOX_TEAM_OVERRIDE || MASTERS[c.masterId]?.squareTeamMemberId;
    if (!teamId) continue;
    const v = pickVariation(c, length);
    const query = {
      query: {
        filter: {
          start_at_range: { start_at: toRfc3339(from), end_at: toRfc3339(to) },
          location_id: env.SQUARE_LOCATION_ID,
          segment_filters: [
            { service_variation_id: v.squareVariationId, team_member_id_filter: { any: [teamId] } },
          ],
        },
      },
    };
    const res = await square(env, 'POST', '/v2/bookings/availability/search', query);
    for (const a of res.availabilities || []) {
      const seg = a.appointment_segments?.[0] || {};
      const mId = teamToMaster[seg.team_member_id] || c.masterId;
      slotMap.set(`${a.start_at}|${mId}`, {
        startAt: a.start_at,
        masterId: mId,
        teamMemberId: seg.team_member_id,
        durationMin: seg.duration_minutes,
        price: v.price,
        serviceVariationId: v.squareVariationId,
        serviceVariationVersion: seg.service_variation_version,
      });
    }
  }

  const slots = [...slotMap.values()].sort((x, y) => x.startAt.localeCompare(y.startAt));
  return { serviceId, slots };
}

// ── Создание записи ─────────────────────────────────────────────────
async function book(request, env) {
  const body = await request.json();
  const { serviceId, masterId, startAt, customer, turnstileToken, packageGan, length } = body;

  await verifyTurnstile(env, turnstileToken, request);
  await ensureRequiresConfirmation(env);

  // Телефон — основной контакт; email необязателен (но если есть — используем для де-дупликации).
  if (!customer?.name || (!customer?.phone && !customer?.email)) {
    throw httpError(400, 'Name and a phone number (or email) are required');
  }

  const services = indexServices();
  const svc = services[serviceId];
  if (!svc) throw httpError(400, `Unknown service: ${serviceId}`);

  const master = MASTERS[masterId];
  if (!master?.squareTeamMemberId) throw httpError(400, `Unknown or unseeded master: ${masterId}`);

  const masterEntry = svc.masters.find((m) => m.masterId === masterId && m.squareVariationId);
  if (!masterEntry) throw httpError(400, `Master ${masterId} does not offer ${serviceId}`);

  // Вариация с учётом выбранной длины (Short/Medium/Long), иначе базовая.
  const chosen = pickVariation(masterEntry, length);

  // ── Если оплата пакетом/сертификатом — проверяем карту ДО создания записи ──
  let redeemPlan = null;
  if (packageGan) {
    const card = await getGiftCard(env, packageGan);
    if (!card || card.state !== 'ACTIVE') throw httpError(400, 'Package/gift card is not active');
    const meta = env.PACKAGES ? await env.PACKAGES.get(`gan:${packageGan}`, 'json') : null;
    const amountCents = meta ? meta.sessionRateCents : chosen.price * 100;
    if (meta && meta.serviceId && meta.serviceId !== serviceId) {
      const cov = indexServices()[meta.serviceId];
      throw httpError(400, `This package covers ${cov ? cov.name : meta.serviceId}, not this service`);
    }
    const balance = card.balance_money?.amount || 0;
    if (balance < amountCents) throw httpError(400, 'Insufficient balance on this package/card');
    redeemPlan = { giftCardId: card.id, amountCents, meta };
  }

  // Версия вариации обязательна для CreateBooking. Берём из выбранного слота,
  // иначе подтягиваем актуальную из каталога.
  let variationVersion = body.serviceVariationVersion;
  if (!variationVersion) {
    const obj = await square(env, 'GET', `/v2/catalog/object/${chosen.squareVariationId}`);
    variationVersion = obj.object?.version;
  }

  // Найти/создать клиента в Square
  const customerId = await findOrCreateCustomer(env, customer);

  const booking = {
    booking: {
      location_id: env.SQUARE_LOCATION_ID,
      start_at: toRfc3339(startAt),
      customer_id: customerId,
      customer_note: customer.note || '',
      appointment_segments: [
        {
          team_member_id: env.SANDBOX_TEAM_OVERRIDE || master.squareTeamMemberId,
          service_variation_id: chosen.squareVariationId,
          service_variation_version: variationVersion,
          duration_minutes: masterEntry.durationMin || svc.durationMin,
        },
      ],
    },
    idempotency_key: crypto.randomUUID(),
  };

  const res = await square(env, 'POST', '/v2/bookings', booking);
  const bookingId = res.booking?.id;
  const result = { ok: true, bookingId, status: res.booking?.status };

  // ── WhatsApp уведомления владельцу (CallMeBot — бесплатно) ─────────
  if (bookingId && env.CALLMEBOT_APIKEY) {
    const phones = (env.OWNER_PHONES || '17542026638,17542026666').split(',').map(s => s.trim().replace(/^\+/, '')).filter(Boolean);
    const timeStr2 = fmtBookingTime(startAt);
    const msgText = `📅 View Spa — новая запись!\n👤 ${customer.name}\n✂️ ${svc.name}\n💇 ${master.name}\n🕐 ${timeStr2}\n💵 $${chosen.price}\n📞 ${customer.phone || '—'}\n📧 ${customer.email || '—'}`;
    const apiKeys = env.CALLMEBOT_APIKEY.split(',').map(s => s.trim());
    for (let i = 0; i < phones.length; i++) {
      const key = apiKeys[i] || apiKeys[0];
      sendCallMeBot(phones[i], msgText, key).catch(() => {});
    }
  }

  // ── Email уведомление владельцу ─────────────────────────────────────
  if (env.OWNER_EMAIL && bookingId) {
    const workerBase = 'https://viewspa-booking.ivanseydametov.workers.dev';
    const acceptToken = await makeHmac(env, bookingId, 'accept');
    const cancelToken = await makeHmac(env, bookingId, 'cancel');
    const acceptUrl = `${workerBase}/api/accept-booking?id=${bookingId}&token=${acceptToken}`;
    const cancelUrl = `${workerBase}/api/cancel-booking?id=${bookingId}&token=${cancelToken}`;
    const timeStr = fmtBookingTime(startAt);
    await sendCodeEmail(env, {
      to: env.OWNER_EMAIL,
      subject: `📅 Новая запись (ожидает подтверждения): ${customer.name} — ${svc.name}`,
      html: emailShell('Новая запись — требует подтверждения', `
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#888;width:110px">Клиент</td><td><b>${customer.name}</b></td></tr>
          <tr><td style="padding:6px 0;color:#888">Email</td><td>${customer.email || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Телефон</td><td>${customer.phone || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Услуга</td><td><b>${svc.name}</b></td></tr>
          <tr><td style="padding:6px 0;color:#888">Специалист</td><td>${master.name}</td></tr>
          <tr><td style="padding:6px 0;color:#888">Дата/время</td><td><b>${timeStr}</b></td></tr>
          <tr><td style="padding:6px 0;color:#888">Цена</td><td>$${chosen.price}</td></tr>
          ${customer.note ? `<tr><td style="padding:6px 0;color:#888">Заметка</td><td>${customer.note}</td></tr>` : ''}
        </table>
        <hr style="margin:20px 0;border:none;border-top:1px solid #eee">
        <table style="border-collapse:collapse">
          <tr>
            <td style="padding-right:12px">
              <a href="${acceptUrl}" style="display:inline-block;padding:12px 24px;background:#27ae60;color:#fff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:bold">
                ✅ Подтвердить
              </a>
            </td>
            <td>
              <a href="${cancelUrl}" style="display:inline-block;padding:12px 24px;background:#c0392b;color:#fff;text-decoration:none;border-radius:4px;font-size:14px;font-weight:bold">
                ❌ Отменить
              </a>
            </td>
          </tr>
        </table>
        <p style="font-size:11px;color:#aaa;margin:12px 0 0">
          Booking ID: ${bookingId} · Клиент видит статус «ожидает подтверждения» пока вы не нажмёте кнопку.
        </p>`),
    }).catch(() => {});
  }

  // ── Списываем сессию/сертификат после успешной записи ──
  if (redeemPlan) {
    const act = await square(env, 'POST', '/v2/gift-cards/activities', {
      idempotency_key: crypto.randomUUID(),
      gift_card_activity: {
        type: 'REDEEM', location_id: env.SQUARE_LOCATION_ID, gift_card_id: redeemPlan.giftCardId,
        redeem_activity_details: { amount_money: { amount: redeemPlan.amountCents, currency: 'USD' } },
      },
    });
    const newBalance = act.gift_card_activity?.gift_card_balance_money?.amount ?? null;
    result.paidWith = 'package';
    result.balanceCents = newBalance;
    if (redeemPlan.meta && newBalance != null) {
      result.sessionsLeft = Math.floor(newBalance / redeemPlan.meta.sessionRateCents);
    }
  }
  return result;
}

// ── Клиент Square ───────────────────────────────────────────────────
async function findOrCreateCustomer(env, customer) {
  // Ищем по email, иначе по телефону — чтобы не плодить дубликаты.
  const filter = customer.email
    ? { email_address: { exact: customer.email } }
    : (customer.phone ? { phone_number: { exact: customer.phone } } : null);
  if (filter) {
    const search = await square(env, 'POST', '/v2/customers/search', {
      query: { filter },
      limit: 1,
    });
    if (search.customers?.length) return search.customers[0].id;
  }

  const [given, ...rest] = (customer.name || '').trim().split(/\s+/);
  const created = await square(env, 'POST', '/v2/customers', {
    given_name: given || customer.name,
    family_name: rest.join(' ') || undefined,
    email_address: customer.email || undefined,
    phone_number: customer.phone || undefined,
    idempotency_key: crypto.randomUUID(),
  });
  return created.customer.id;
}

// ── Оплата: Web Payments + подарочные карты (пакеты/сертификаты) ─────
function paymentConfig(env) {
  return {
    applicationId: env.SQUARE_APP_ID,
    locationId: env.SQUARE_LOCATION_ID,
    env: env.SQUARE_API_BASE?.includes('sandbox') ? 'sandbox' : 'production',
  };
}

async function getGiftCard(env, gan) {
  try {
    const res = await square(env, 'POST', '/v2/gift-cards/from-gan', { gan });
    return res.gift_card || null;
  } catch { return null; }
}

// Именованный заказ (подпись «4 Massage Sessions…») → платёж картой → выпуск карты →
// активация через заказ (оплачено = загружено). label виден в Square (продажа/чек).
async function purchaseGiftCard(env, { amountCents, paymentToken, buyer, label }) {
  if (!paymentToken) throw httpError(400, 'Missing payment token');

  // 1. Заказ с понятным названием позиции (тип GIFT_CARD)
  const ord = await square(env, 'POST', '/v2/orders', {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: [{ name: label || 'Gift Card', quantity: '1', item_type: 'GIFT_CARD', base_price_money: { amount: amountCents, currency: 'USD' } }],
    },
  });
  const orderId = ord.order?.id;
  const lineUid = ord.order?.line_items?.[0]?.uid;
  const total = ord.order?.total_money?.amount ?? amountCents;

  // 2. Платёж по заказу
  await square(env, 'POST', '/v2/payments', {
    idempotency_key: crypto.randomUUID(),
    source_id: paymentToken,
    amount_money: { amount: total, currency: 'USD' },
    location_id: env.SQUARE_LOCATION_ID,
    order_id: orderId,
    buyer_email_address: buyer?.email,
    note: label || 'View Spa',
  });

  // 3. Выпуск цифровой карты
  const gc = await square(env, 'POST', '/v2/gift-cards', {
    idempotency_key: crypto.randomUUID(),
    location_id: env.SQUARE_LOCATION_ID,
    gift_card: { type: 'DIGITAL' },
  });
  const giftCardId = gc.gift_card?.id, gan = gc.gift_card?.gan;

  // 4. Активация через заказ (имя/сумма берутся из позиции)
  await square(env, 'POST', '/v2/gift-cards/activities', {
    idempotency_key: crypto.randomUUID(),
    gift_card_activity: {
      type: 'ACTIVATE', location_id: env.SQUARE_LOCATION_ID, gift_card_id: giftCardId,
      activate_activity_details: { order_id: orderId, line_item_uid: lineUid },
    },
  });
  return { giftCardId, gan, orderId };
}

async function buyPackage(request, env) {
  const body = await request.json();
  const { packageId, paymentToken, buyer, turnstileToken } = body;
  await verifyTurnstile(env, turnstileToken, request);
  if (!buyer?.email || !buyer?.name) throw httpError(400, 'Name and email are required');
  const pkg = PACKAGES[packageId];
  if (!pkg) throw httpError(400, `Unknown package: ${packageId}`);

  const { gan } = await purchaseGiftCard(env, {
    amountCents: pkg.priceCents, paymentToken, buyer, label: pkg.name,
  });

  const expiresAt = new Date(Date.now() + pkg.expiryDays * 86400000).toISOString();
  if (env.PACKAGES) {
    await env.PACKAGES.put(`gan:${gan}`, JSON.stringify({
      packageId: pkg.id, name: pkg.name, sessionRateCents: pkg.sessionRateCents,
      sessionsTotal: pkg.sessions, serviceId: pkg.serviceId, buyerEmail: buyer.email,
      expiresAt, createdAt: new Date().toISOString(),
    }));
  }
  const emailSent = await sendCodeEmail(env, {
    to: buyer.email,
    subject: `Your ${pkg.name} — View Spa`,
    html: emailShell('Your package is ready 🎉', `
      <p>Hi ${buyer.name}, thank you for your purchase!</p>
      <p><b>${pkg.name}</b><br>${pkg.sessions} sessions · valid until ${new Date(expiresAt).toLocaleDateString()}</p>
      <p>Your code (enter it when booking online to redeem a session):</p>
      <p style="font-size:22px;letter-spacing:2px;font-weight:bold">${fmtGan(gan)}</p>
      <p><a href="https://viewspa.miami/booking.html">Book a session →</a></p>`),
  });
  return { ok: true, gan, name: pkg.name, balanceCents: pkg.priceCents, sessions: pkg.sessions, expiresAt, emailSent };
}

async function buyCertificate(request, env) {
  const body = await request.json();
  const { amountCents, paymentToken, buyer, turnstileToken } = body;
  await verifyTurnstile(env, turnstileToken, request);
  if (!buyer?.email || !buyer?.name) throw httpError(400, 'Name and email are required');
  const amt = Math.round(Number(amountCents) || 0);
  if (amt < CERTIFICATE.minCents || amt > CERTIFICATE.maxCents) {
    throw httpError(400, `Amount must be $${CERTIFICATE.minCents / 100}–$${CERTIFICATE.maxCents / 100}`);
  }
  const { gan } = await purchaseGiftCard(env, { amountCents: amt, paymentToken, buyer, label: `Gift Certificate $${amt / 100}` });
  const emailSent = await sendCodeEmail(env, {
    to: buyer.email,
    subject: 'Your View Spa gift certificate',
    html: emailShell('Your gift certificate 🎁', `
      <p>Hi ${buyer.name}, thank you!</p>
      <p><b>$${(amt / 100).toFixed(2)}</b> gift certificate</p>
      <p>Code (use at booking or in the salon):</p>
      <p style="font-size:22px;letter-spacing:2px;font-weight:bold">${fmtGan(gan)}</p>`),
  });
  return { ok: true, gan, balanceCents: amt, emailSent };
}

// ── Email доставки кода (Resend) ────────────────────────────────────
function fmtGan(gan) { return String(gan || '').replace(/(\d{4})(?=\d)/g, '$1 '); }

async function sendCodeEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'View Spa <noreply@viewspa.miami>',
        to: [to], subject, html,
      }),
    });
    return r.ok;
  } catch { return false; }
}

// ── CallMeBot WhatsApp уведомления (бесплатно) ──────────────────────
// Документация: https://www.callmebot.com/blog/free-api-whatsapp-messages/
// Каждый номер должен один раз активировать бота (см. инструкцию).
async function sendCallMeBot(phone, text, apikey) {
  if (!phone || !apikey) return false;
  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(text)}&apikey=${apikey}`;
    const r = await fetch(url);
    return r.ok;
  } catch { return false; }
}

function emailShell(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#faf7f2">
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#222;background:#fff">
      <h2 style="font-weight:normal;color:#A8842A">${title}</h2>${bodyHtml}
      <p style="font-size:12px;color:#999;margin-top:24px">View Spa &middot; 20200 W Dixie Hwy, Aventura FL &middot; (754) 202-6666</p>
    </div>
  </body></html>`;
}

async function packageBalance(request, env) {
  const { gan } = await request.json();
  if (!gan) throw httpError(400, 'Missing code');
  const card = await getGiftCard(env, gan);
  if (!card) throw httpError(404, 'Card not found');
  const meta = env.PACKAGES ? await env.PACKAGES.get(`gan:${gan}`, 'json') : null;
  const balanceCents = card.balance_money?.amount || 0;
  const out = { balanceCents, state: card.state };
  if (meta) {
    out.name = meta.name;
    out.sessionsLeft = Math.floor(balanceCents / meta.sessionRateCents);
    out.sessionsTotal = meta.sessionsTotal;
    out.expiresAt = meta.expiresAt;
  }
  return out;
}

// ── Гарантируем что все записи требуют подтверждения владельца ───────
async function ensureRequiresConfirmation(env) {
  try {
    await square(env, 'PUT', '/v2/bookings/business-booking-profile', {
      business_booking_profile: { booking_policy: 'REQUIRES_CONFIRMATION' },
    });
  } catch (_) {
    // не блокируем бронирование если вызов не прошёл
  }
}

// ── HMAC токен для защиты action-ссылок (accept / cancel) ───────────
async function makeHmac(env, bookingId, action = 'cancel') {
  const secret = env.NOTIFY_SECRET || 'viewspa-dev-secret';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${action}:${bookingId}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Общий UI для action-страниц ──────────────────────────────────────
function actionPage(title, msg, ok = true) {
  const icon = ok ? '✅' : '❌';
  const color = ok ? '#27ae60' : '#c0392b';
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
    <body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#faf7f2">
      <div style="text-align:center;padding:40px;max-width:400px">
        <div style="font-size:48px;margin-bottom:16px">${icon}</div>
        <h2 style="color:${color};font-weight:normal;margin:0 0 12px">${title}</h2>
        <p style="color:#666;margin:0">${msg}</p>
        <p style="margin-top:24px"><a href="https://viewspa.miami" style="color:#A8842A">← viewspa.miami</a></p>
      </div>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html;charset=utf-8' } }
  );
}

// ── Подтверждение записи по ссылке из письма ─────────────────────────
async function acceptBookingPage(url, env) {
  const bookingId = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!bookingId || !token) return actionPage('Неверная ссылка', 'Параметры отсутствуют.', false);
  const expected = await makeHmac(env, bookingId, 'accept');
  if (expected !== token) return actionPage('Неверная ссылка', 'Токен не совпадает.', false);
  try {
    // Получаем актуальную версию записи, чтобы UpdateBooking прошёл
    const current = await square(env, 'GET', `/v2/bookings/${bookingId}`);
    const version = current.booking?.version;
    await square(env, 'PUT', `/v2/bookings/${bookingId}`, {
      idempotency_key: crypto.randomUUID(),
      booking: { version, status: 'ACCEPTED' },
    });
    return actionPage('Запись подтверждена', 'Клиент получит письмо с подтверждением от Square.');
  } catch (e) {
    return actionPage('Ошибка', e.message + ' Возможно, запись уже подтверждена или отменена.', false);
  }
}

// ── Отмена записи по ссылке из письма ───────────────────────────────
async function cancelBookingPage(url, env) {
  const bookingId = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!bookingId || !token) return actionPage('Неверная ссылка', 'Параметры отсутствуют.', false);
  const expected = await makeHmac(env, bookingId, 'cancel');
  if (expected !== token) return actionPage('Неверная ссылка', 'Токен не совпадает.', false);
  try {
    await square(env, 'POST', `/v2/bookings/${bookingId}/cancel`, { idempotency_key: crypto.randomUUID() });
    return actionPage('Запись отменена', 'Square уведомит клиента автоматически.');
  } catch (e) {
    return actionPage('Ошибка', e.message + ' Возможно, запись уже отменена или завершена.', false);
  }
}

// ── Форматирование времени записи ────────────────────────────────────
function fmtBookingTime(iso, tz = 'America/New_York') {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${date} at ${time} Eastern`;
}

// ── Cloudflare Turnstile ────────────────────────────────────────────
async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET) return; // отключено на этапе разработки
  if (!token) throw httpError(400, 'Missing Turnstile token');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!data.success) throw httpError(403, 'Spam check failed');
}

// ── Низкоуровневый вызов Square ─────────────────────────────────────
async function square(env, method, path, body) {
  const res = await fetch(`${env.SQUARE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': env.SQUARE_VERSION || '2025-10-16',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data.errors?.[0]?.detail || `Square ${res.status}`;
    throw httpError(res.status, msg);
  }
  return data;
}

// ── Утилиты ─────────────────────────────────────────────────────────
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function toRfc3339(value) {
  if (!value) return value;
  // принимаем как ISO-строку или Date
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
