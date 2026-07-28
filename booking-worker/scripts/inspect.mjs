/**
 * Диагностика sandbox-аккаунта Square.
 * Запуск:  node scripts/inspect.mjs
 *
 * Читает токен из .dev.vars. Ничего не меняет — только GET/чтение.
 * По его выводу пишется точный seed-скрипт.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const devVars = readFileSync(join(__dirname, '..', '.dev.vars'), 'utf8');
const TOKEN = (devVars.match(/SQUARE_ACCESS_TOKEN="?([^"\n]+)"?/) || [])[1];
const BASE = 'https://connect.squareupsandbox.com';
const VERSION = '2025-10-16';

async function sq(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Square-Version': VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function show(title, r) {
  console.log(`\n=== ${title} (${r.status}) ===`);
  console.log(JSON.stringify(r.data, null, 2).slice(0, 4000));
}

(async () => {
  if (!TOKEN) { console.error('No token in .dev.vars'); process.exit(1); }

  show('Business booking profile (Appointments status)', await sq('GET', '/v2/bookings/business-booking-profile'));
  show('Locations', await sq('GET', '/v2/locations'));
  show('Team members', await sq('POST', '/v2/team-members/search', { query: {} }));
  show('Catalog (services)', await sq('POST', '/v2/catalog/search', {
    object_types: ['ITEM'],
  }));
})();
