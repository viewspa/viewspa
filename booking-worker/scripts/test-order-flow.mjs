// SANDBOX: проверка Orders-флоу выпуска карты (как в purchaseGiftCard).
const T = 'EAAAl0uKB8ljr7dQpU1ulu8HcIGgWQRiiIHv0yjPLVtYUxjJ7AK6l2-wxaWfTon-';
const B = 'https://connect.squareupsandbox.com', V = '2025-10-16', LOC = 'LYY1AVETYA7A3';
const uid = () => crypto.randomUUID();
async function sq(path, body) {
  const r = await fetch(B + path, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'Square-Version': V, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) };
}
(async () => {
  const label = '4 Massage Sessions (60 min each)';
  const amount = 30000;
  const ord = await sq('/v2/orders', { idempotency_key: uid(), order: { location_id: LOC, line_items: [{ name: label, quantity: '1', item_type: 'GIFT_CARD', base_price_money: { amount, currency: 'USD' } }] } });
  console.log('1) ORDER', ord.status, ord.d.order?.id, 'total', ord.d.order?.total_money?.amount, ord.d.errors || '');
  const orderId = ord.d.order?.id, lineUid = ord.d.order?.line_items?.[0]?.uid;

  const pay = await sq('/v2/payments', { idempotency_key: uid(), source_id: 'cnon:card-nonce-ok', amount_money: { amount, currency: 'USD' }, location_id: LOC, order_id: orderId, note: label });
  console.log('2) PAYMENT', pay.status, pay.d.payment?.id, pay.d.errors || '');

  const gc = await sq('/v2/gift-cards', { idempotency_key: uid(), location_id: LOC, gift_card: { type: 'DIGITAL' } });
  console.log('3) GIFTCARD', gc.status, gc.d.gift_card?.gan, gc.d.errors || '');
  const gcId = gc.d.gift_card?.id, gan = gc.d.gift_card?.gan;

  const act = await sq('/v2/gift-cards/activities', { idempotency_key: uid(), gift_card_activity: { type: 'ACTIVATE', location_id: LOC, gift_card_id: gcId, activate_activity_details: { order_id: orderId, line_item_uid: lineUid } } });
  console.log('4) ACTIVATE', act.status, 'balance', act.d.gift_card_activity?.gift_card_balance_money, act.d.errors || '');

  const bal = await sq('/v2/gift-cards/from-gan', { gan });
  console.log('5) BALANCE', bal.status, bal.d.gift_card?.balance_money, bal.d.gift_card?.state);
})();
