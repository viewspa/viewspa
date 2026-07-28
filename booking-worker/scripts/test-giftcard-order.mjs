// SANDBOX: покупка пакета через ИМЕНОВАННЫЙ заказ (чтобы карта/чек были подписаны).
const T = 'EAAAl0uKB8ljr7dQpU1ulu8HcIGgWQRiiIHv0yjPLVtYUxjJ7AK6l2-wxaWfTon-';
const B = 'https://connect.squareupsandbox.com', V = '2025-10-16', LOC = 'LYY1AVETYA7A3';
const uid = () => crypto.randomUUID();
async function sq(path, body) {
  const r = await fetch(B + path, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'Square-Version': V, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) };
}
(async () => {
  const name = '4 Massage Sessions (60 min each)';
  // 1. Именованный заказ
  const ord = await sq('/v2/orders', {
    idempotency_key: uid(),
    order: { location_id: LOC, line_items: [{ name, quantity: '1', item_type: 'GIFT_CARD', base_price_money: { amount: 30000, currency: 'USD' } }] },
  });
  const orderId = ord.d.order?.id, lineUid = ord.d.order?.line_items?.[0]?.uid, total = ord.d.order?.total_money?.amount;
  console.log('1) ORDER', ord.status, orderId, 'lineUid:', lineUid, 'total:', total, 'lineName:', ord.d.order?.line_items?.[0]?.name, ord.d.errors || '');
  if (!ord.ok) return;

  // 2. Платёж по заказу
  const pay = await sq('/v2/payments', { idempotency_key: uid(), source_id: 'cnon:card-nonce-ok', amount_money: { amount: total, currency: 'USD' }, location_id: LOC, order_id: orderId });
  console.log('2) PAYMENT', pay.status, pay.d.payment?.id || pay.d.errors);
  if (!pay.ok) return;

  // 3. Карта
  const gc = await sq('/v2/gift-cards', { idempotency_key: uid(), location_id: LOC, gift_card: { type: 'DIGITAL' } });
  const gcId = gc.d.gift_card?.id, gan = gc.d.gift_card?.gan;
  console.log('3) GIFT CARD', gc.status, gcId, 'GAN', gan, gc.d.errors || '');
  if (!gc.ok) return;

  // 4. Активация через заказ (имя берётся из line item)
  const act = await sq('/v2/gift-cards/activities', {
    idempotency_key: uid(),
    gift_card_activity: { type: 'ACTIVATE', location_id: LOC, gift_card_id: gcId, activate_activity_details: { order_id: orderId, line_item_uid: lineUid } },
  });
  console.log('4) ACTIVATE(order)', act.status, 'balance:', act.d.gift_card_activity?.gift_card_balance_money, act.d.errors || '');
})();
