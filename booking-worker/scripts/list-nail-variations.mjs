/**
 * READ-ONLY. Печатает актуальные ID вариантов услуг Ksenia (Русский гель-маникюр и
 * Hard Gel Extension) из PRODUCTION-каталога Square. Ничего не меняет.
 *
 * Запуск (вставь свой PRODUCTION Square access token):
 *   SQUARE_ACCESS_TOKEN="EAAA...твой_боевой_токен..." node scripts/list-nail-variations.mjs
 *
 * Токен нигде не сохраняется — только используется для одного GET-запроса.
 */
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const BASE = process.env.SQUARE_API_BASE || 'https://connect.squareup.com'; // production
const V = '2025-10-16';

if (!TOKEN) {
  console.error('Нет токена. Запусти так:\n  SQUARE_ACCESS_TOKEN="твой_prod_токен" node scripts/list-nail-variations.mjs');
  process.exit(1);
}

async function sq(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Square-Version': V, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

const r = await sq('/v2/catalog/search', {
  object_types: ['ITEM'],
  query: { text_query: { keywords: ['Gel Manicure', 'Hard Gel Extension'] } },
});

console.log('HTTP', r.status, r.ok ? 'OK' : 'FAIL');
if (!r.ok) { console.log(JSON.stringify(r.data)); process.exit(1); }

for (const o of (r.data.objects || [])) {
  if (o.type !== 'ITEM') continue;
  const nm = o.item_data?.name || '';
  if (!/gel manicure|hard gel/i.test(nm)) continue;
  console.log(`\nITEM ${o.id}  «${nm}»`);
  for (const v of (o.item_data?.variations || [])) {
    const vd = v.item_variation_data;
    const price = (vd?.price_money?.amount || 0) / 100;
    console.log(`   VAR ${v.id}  «${vd?.name}»  $${price}  team=${JSON.stringify(vd?.team_member_ids || [])}`);
  }
}
console.log('\n(скопируй весь вывод и пришли мне)');
