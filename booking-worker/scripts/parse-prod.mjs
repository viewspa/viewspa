// Разбор боевого каталога Square → сводка услуг/вариаций/цен/мастеров.
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(new URL('./prod-catalog.json', import.meta.url)));
const tm = { 'TM88oB8jHjE9r-yU': 'Kseniia', 'TMkBPRu_rgW5FH6i': 'Anastasia', 'TMlp1LGewyypzn4u': 'Ivan' };
for (const o of data.objects || []) {
  if (o.type !== 'ITEM') continue;
  const d = o.item_data || {};
  if (d.product_type !== 'APPOINTMENTS_SERVICE') continue;
  console.log(`\n# ${d.name}  [item ${o.id}]`);
  for (const v of d.variations || []) {
    const vd = v.item_variation_data || {};
    const price = vd.price_money ? '$' + (vd.price_money.amount / 100) : (vd.pricing_type || '?');
    const dur = vd.service_duration ? vd.service_duration / 60000 + 'm' : '?';
    const who = (vd.team_member_ids || []).map((id) => tm[id] || id).join(',') || '(none)';
    const book = vd.available_for_booking ? '' : ' [NOT bookable]';
    console.log(`   - ${vd.name} | ${dur} | ${price} | ${who} | var ${v.id}${book}`);
  }
}
