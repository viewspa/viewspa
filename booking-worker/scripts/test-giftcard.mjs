// SANDBOX: проверка полного денежного пути пакета.
// Платёж (тестовая карта) → выпуск карты → активация $300 → баланс → списание $75 → баланс.
const T = 'EAAAl0uKB8ljr7dQpU1ulu8HcIGgWQRiiIHv0yjPLVtYUxjJ7AK6l2-wxaWfTon-';
const B = 'https://connect.squareupsandbox.com';
const V = '2025-10-16';
const LOC = 'LYY1AVETYA7A3';
const uid = () => crypto.randomUUID();

async function sq(path, body, method = 'POST') {
  const r = await fetch(B + path, {
    method,
    headers: { Authorization: `Bearer ${T}`, 'Square-Version': V, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

(async () => {
  // 1. Платёж тестовой картой на $300
  const pay = await sq('/v2/payments', {
    idempotency_key: uid(), source_id: 'cnon:card-nonce-ok',
    amount_money: { amount: 30000, currency: 'USD' }, location_id: LOC,
    note: 'Test package 4 massage sessions',
  });
  const paymentId = pay.d.payment?.id;
  console.log('1) PAYMENT', pay.status, paymentId || pay.d.errors);
  if (!pay.ok) return;

  // 2. Создать цифровую подарочную карту
  const gc = await sq('/v2/gift-cards', {
    idempotency_key: uid(), location_id: LOC, gift_card: { type: 'DIGITAL' },
  });
  const gcId = gc.d.gift_card?.id, gan = gc.d.gift_card?.gan;
  console.log('2) GIFT CARD', gc.status, gcId, 'GAN:', gan, gc.d.errors || '');
  if (!gc.ok) return;

  // 3. Активировать на $300 (без привязки к заказу)
  const act = await sq('/v2/gift-cards/activities', {
    idempotency_key: uid(),
    gift_card_activity: {
      type: 'ACTIVATE', location_id: LOC, gift_card_id: gcId,
      activate_activity_details: { amount_money: { amount: 30000, currency: 'USD' }, buyer_payment_instrument_ids: [paymentId] },
    },
  });
  console.log('3) ACTIVATE', act.status, 'balance:', act.d.gift_card_activity?.gift_card_balance_money, act.d.errors || '');

  // 4. Баланс по GAN
  const bal1 = await sq('/v2/gift-cards/from-gan', { gan });
  console.log('4) BALANCE', bal1.status, bal1.d.gift_card?.balance_money, 'state:', bal1.d.gift_card?.state);

  // 5. Списать $75 (одна сессия)
  const red = await sq('/v2/gift-cards/activities', {
    idempotency_key: uid(),
    gift_card_activity: {
      type: 'REDEEM', location_id: LOC, gift_card_id: gcId,
      redeem_activity_details: { amount_money: { amount: 7500, currency: 'USD' } },
    },
  });
  console.log('5) REDEEM $75', red.status, 'balance:', red.d.gift_card_activity?.gift_card_balance_money, red.d.errors || '');

  // 6. Баланс после
  const bal2 = await sq('/v2/gift-cards/from-gan', { gan });
  console.log('6) BALANCE after', bal2.status, bal2.d.gift_card?.balance_money, '(≈', (bal2.d.gift_card?.balance_money?.amount || 0) / 7500, 'sessions left)');
})();
