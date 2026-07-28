// Проставляет диплинки booking.html?... в ссылках сайта (маникюр/массаж).
// Запуск: node scripts/deeplink.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NAIL_SVC = {
  'Russian Gel Manicure': 'gel-manicure',
  'Hard Gel Extension': 'hard-gel-extension',
  'Manicure with Regular Polish': 'manicure-regular-polish',
  'Manicure (No Polish)': 'manicure-no-polish',
  'Russian Smart Gel Pedicure': 'smart-gel-pedicure',
  'Pedicure with Regular Polish': 'pedicure-regular-polish',
  'Pedicure (No Polish)': 'pedicure-no-polish',
  'Gel Polish Removal': 'gel-polish-removal',
  'Nail Designs': 'nail-designs',
};
const MASTER = { Ksenia: 'ksenia', Anastasia: 'anastasia' };

const MASSAGE_SVC = {
  'Full Body Reset (60 min)': 'full-body-reset',
  'Total Body Restoration (90 min)': 'total-body-restoration',
  'Express Targeted Reset (45 min)': 'express-targeted-reset',
};

function processManicure() {
  const path = join(SITE, 'manicure.html');
  let html = readFileSync(path, 'utf8');
  let svcLinks = 0;
  const parts = html.split('<div class="svc-item">');
  for (let i = 1; i < parts.length; i++) {
    const nameMatch = parts[i].match(/<h3>([^<]+)<\/h3>/);
    const sid = nameMatch && NAIL_SVC[nameMatch[1].trim()];
    if (!sid) continue;
    parts[i] = parts[i].replace(
      /(<span class="staff-n">([^<]*)<\/span><a )href="booking\.html"/g,
      (_, pre, staff) => {
        svcLinks++;
        const mid = MASTER[staff.trim()];
        const q = `?service=${sid}` + (mid ? `&master=${mid}` : '');
        return `${pre}href="booking.html${q}"`;
      }
    );
  }
  html = parts.join('<div class="svc-item">');
  // остальные ссылки (Check Availability / nav / hero) → раздел Manicure
  const ctas = (html.match(/href="booking\.html"/g) || []).length;
  html = html.replace(/href="booking\.html"/g, 'href="booking.html?subcategory=manicure"');
  writeFileSync(path, html);
  console.log(`manicure.html: ${svcLinks} service links, ${ctas} CTA links → subcategory=manicure`);
}

function processMassage() {
  const path = join(SITE, 'massage.html');
  let html = readFileSync(path, 'utf8');
  let cardLinks = 0;
  const parts = html.split('<div class="svc-card">');
  for (let i = 1; i < parts.length; i++) {
    const nameMatch = parts[i].match(/<h3>([^<]+)<\/h3>/);
    const sid = nameMatch && MASSAGE_SVC[nameMatch[1].trim()];
    if (!sid) continue;
    parts[i] = parts[i].replace(/href="booking\.html"/, () => {
      cardLinks++;
      return `href="booking.html?service=${sid}&master=ivan"`;
    });
  }
  html = parts.join('<div class="svc-card">');
  // остальные ссылки массажа → раздел Massage
  const ctas = (html.match(/href="booking\.html"/g) || []).length;
  html = html.replace(/href="booking\.html"/g, 'href="booking.html?category=massage"');
  writeFileSync(path, html);
  console.log(`massage.html: ${cardLinks} card links, ${ctas} CTA links → category=massage`);
}

processManicure();
processMassage();
console.log('done');
