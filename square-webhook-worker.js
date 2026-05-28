/**
 * Cloudflare Worker — Square Booking → GA4 Measurement Protocol
 *
 * Развёртывание:
 *   1. Зайди на dash.cloudflare.com → Workers & Pages → Create Worker
 *   2. Вставь этот код → Deploy
 *   3. Добавь переменные окружения (Settings → Variables):
 *        SQUARE_WEBHOOK_SIG_KEY   — из Square Developer → Webhooks → Signature key
 *        GA4_MEASUREMENT_ID       — G-P0GR3YZQQL
 *        GA4_API_SECRET           — создать в GA4: Admin → Data Streams → Measurement Protocol API secrets
 *   4. Зайди в Square Developer → Webhooks → Add endpoint:
 *        URL: https://<имя-воркера>.<subdomain>.workers.dev/square-webhook
 *        Events: booking.created, booking.cancelled
 */

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'POST' || url.pathname !== '/square-webhook') {
      return new Response('Not found', { status: 404 });
    }

    const body = await request.text();

    // ── Верификация подписи Square ──────────────────────────────────────────
    const squareSig = request.headers.get('x-square-hmacsha256-signature');
    if (!squareSig || !env.SQUARE_WEBHOOK_SIG_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    const isValid = await verifySquareSignature(
      env.SQUARE_WEBHOOK_SIG_KEY,
      request.url,
      body,
      squareSig
    );

    if (!isValid) {
      return new Response('Signature mismatch', { status: 401 });
    }

    // ── Парсинг события ─────────────────────────────────────────────────────
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }

    if (event.type === 'booking.created') {
      await handleBookingCreated(event.data?.object?.booking, env);
    }

    return new Response('OK', { status: 200 });
  }
};

// ── Обработка нового бронирования ──────────────────────────────────────────
async function handleBookingCreated(booking, env) {
  if (!booking) return;

  const segment    = booking.appointment_segments?.[0] ?? {};
  const serviceId  = segment.service_variation_id ?? 'unknown';
  const durationMs = (segment.duration_minutes ?? 60) * 60 * 1000;
  const clientId   = booking.customer_id ?? crypto.randomUUID();

  // Определяем цену по длительности сессии
  const durationMin = segment.duration_minutes ?? 60;
  const price = durationMin <= 45 ? 59 : durationMin <= 60 ? 85 : 110;

  // Имя услуги для отчётов
  const serviceName = durationMin <= 45
    ? 'Express 45 min'
    : durationMin <= 60
      ? 'Full Body Reset 60 min'
      : 'Total Body Restoration 90 min';

  await sendGA4Event(env, {
    client_id: String(clientId),
    events: [
      {
        name: 'booking_completed',
        params: {
          currency:     'USD',
          value:        price,
          booking_id:   booking.id,
          service_name: serviceName,
          service_id:   serviceId,
          source:       'square_webhook'
        }
      },
      // Стандартное событие purchase для Google Ads Smart Bidding
      {
        name: 'purchase',
        params: {
          transaction_id: booking.id,
          currency:       'USD',
          value:          price,
          items: [
            {
              item_id:   serviceId,
              item_name: serviceName,
              price:     price,
              quantity:  1
            }
          ]
        }
      }
    ]
  });
}

// ── GA4 Measurement Protocol ────────────────────────────────────────────────
async function sendGA4Event(env, payload) {
  const endpoint = `${GA4_ENDPOINT}?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`;

  const response = await fetch(endpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload)
  });

  // GA4 Measurement Protocol возвращает 204 при успехе
  if (!response.ok && response.status !== 204) {
    console.error('GA4 MP error:', response.status, await response.text());
  }
}

// ── Верификация HMAC-SHA256 подписи Square ──────────────────────────────────
async function verifySquareSignature(sigKey, requestUrl, body, signature) {
  const encoder    = new TextEncoder();
  const keyData    = encoder.encode(sigKey);
  const msgData    = encoder.encode(requestUrl + body);

  const cryptoKey  = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );

  const hashBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const computed   = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));

  return computed === signature;
}
