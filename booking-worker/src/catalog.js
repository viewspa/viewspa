/**
 * Каталог View Spa — единый источник правды для интерфейса букинга.
 * ЗАПОЛНЕНО БОЕВЫМИ ДАННЫМИ из production Square (location LRR0VEQVKE8BT).
 *
 * В Square цена/длительность живут на ВАРИАЦИИ услуги и различаются по мастеру,
 * поэтому price/durationMin/squareVariationId хранятся в service.masters[].
 * service.durationMin — представительное значение для списка (до выбора мастера).
 *
 * Всё здесь редактируется вручную (названия, цены) — это просто карта на Square.
 */

export const BUSINESS = {
  name: 'View Spa',
  timezone: 'America/New_York',
  slotStepMinutes: 15,
  // Информативно (реальная доступность приходит из Square по расписанию мастеров).
  hours: {
    1: { open: '09:00', close: '21:00' }, 2: { open: '09:00', close: '21:00' },
    3: { open: '09:00', close: '21:00' }, 4: { open: '09:00', close: '21:00' },
    5: { open: '09:00', close: '21:00' }, 6: { open: '09:00', close: '21:00' },
  },
};

export const MASTERS = {
  ksenia: {
    id: 'ksenia',
    name: 'Ksenia',
    role: 'Head Nail Artist · Nailympia Champion 2025 · Owner',
    squareTeamMemberId: 'TM88oB8jHjE9r-yU',
  },
  anastasia: {
    id: 'anastasia',
    name: 'Anastasia',
    role: 'Nail Specialist · Smart Pedicure Expert',
    squareTeamMemberId: 'TMkBPRu_rgW5FH6i',
  },
  ivan: {
    id: 'ivan',
    name: 'Ivan',
    role: 'Massage Therapist',
    squareTeamMemberId: 'TMlp1LGewyypzn4u',
  },
};

export const CATALOG = {
  categories: [
    {
      id: 'nail',
      name: 'Nail Services',
      subcategories: [
        {
          id: 'manicure',
          name: 'Manicure',
          services: [
            {
              id: 'gel-manicure',
              name: 'Russian / European Gel Manicure',
              durationMin: 120,
              masters: [
                { masterId: 'ksenia', price: 95, durationMin: 120, squareVariationId: '5BJB6WJTOFUE233GICWDTPRU',
                  lengths: [
                    { id: 'short',  name: 'Short',  price: 95,  squareVariationId: '5BJB6WJTOFUE233GICWDTPRU' },
                    { id: 'medium', name: 'Medium', price: 100, squareVariationId: 'QCQQVYPC25D73JOWRQ7X6VYM' },
                    { id: 'long',   name: 'Long',   price: 110, squareVariationId: 'A5UGFFZTE7XP5XJ2Q4334K32' },
                  ] },
                { masterId: 'anastasia', price: 85, durationMin: 120, squareVariationId: 'NRIKB6KFZE2XCITSWKV2S42Q' },
              ],
            },
            {
              id: 'hard-gel-extension',
              name: 'Hard Gel Extension',
              durationMin: 150,
              masters: [
                { masterId: 'ksenia', price: 130, durationMin: 150, squareVariationId: 'VZFBSMQL3W7OBLGNFHN3TPVG',
                  lengths: [
                    { id: 'short',  name: 'Short',  price: 130, squareVariationId: 'VZFBSMQL3W7OBLGNFHN3TPVG' },
                    { id: 'medium', name: 'Medium', price: 140, squareVariationId: 'TLXKODHN3PFWGTBAGLTDWHTD' },
                    { id: 'long',   name: 'Long',   price: 150, squareVariationId: 'I4WIRP5L2KROH3DIXUHBXF23' },
                  ] },
              ],
            },
            {
              id: 'manicure-regular-polish',
              name: 'Manicure with Regular Polish',
              durationMin: 60,
              masters: [
                { masterId: 'ksenia', price: 60, durationMin: 90, squareVariationId: 'HEG7RLP2YRG47P67TID3GFRS' },
                { masterId: 'anastasia', price: 50, durationMin: 60, squareVariationId: 'YJYV3VGUQA4Y3MZKORGKDSK3' },
              ],
            },
            {
              id: 'manicure-no-polish',
              name: 'Manicure (No Polish)',
              durationMin: 45,
              masters: [
                { masterId: 'ksenia', price: 50, durationMin: 45, squareVariationId: 'IVMGLSBHGGJCOOG55SZSNJG3' },
                { masterId: 'anastasia', price: 40, durationMin: 60, squareVariationId: 'SAJKK3Y54CCOYIOZVMSBJOL3' },
              ],
            },
          ],
        },
        {
          id: 'pedicure',
          name: 'Pedicure',
          services: [
            {
              id: 'smart-gel-pedicure',
              name: 'Russian Smart Gel Pedicure',
              durationMin: 120,
              masters: [
                { masterId: 'ksenia', price: 95, durationMin: 120, squareVariationId: '22NIMYHJEZWWN6HSFE6Y2QA2' },
                { masterId: 'anastasia', price: 85, durationMin: 120, squareVariationId: 'VNE3OGQQIKHGDLMA2G5MZHJD' },
              ],
            },
            {
              id: 'pedicure-regular-polish',
              name: 'Pedicure with Regular Polish',
              durationMin: 90,
              masters: [
                { masterId: 'ksenia', price: 85, durationMin: 90, squareVariationId: 'LOLINCRMWDUOD56TWAGW5MJ5' },
                { masterId: 'anastasia', price: 75, durationMin: 90, squareVariationId: 'ABLETWXH5R6ZTWIHAD62NNZO' },
              ],
            },
            {
              id: 'pedicure-no-polish',
              name: 'Pedicure (No Polish)',
              durationMin: 60,
              masters: [
                { masterId: 'ksenia', price: 75, durationMin: 60, squareVariationId: 'AISMN44KI4F5JYOECTH4JRQJ' },
                { masterId: 'anastasia', price: 65, durationMin: 60, squareVariationId: 'D566P66BHFXNO5PVHGR5E77C' },
              ],
            },
          ],
        },
        {
          id: 'extras',
          name: 'Extras & Combos',
          services: [
            {
              id: 'gel-polish-removal',
              name: 'Gel Polish Removal (foreign)',
              durationMin: 20,
              masters: [
                { masterId: 'ksenia', price: 25, durationMin: 20, squareVariationId: 'UBNEQUSJPOYMAPGM5YBWUYUH' },
                { masterId: 'anastasia', price: 25, durationMin: 20, squareVariationId: 'UBNEQUSJPOYMAPGM5YBWUYUH' },
              ],
            },
            {
              id: 'nail-designs',
              name: 'Nail Designs (French, Ombre, Chrome…)',
              durationMin: 20,
              masters: [
                { masterId: 'ksenia', price: 15, durationMin: 20, squareVariationId: 'DXHOBSRP7SEUCA45V5V2HKLK' },
                { masterId: 'anastasia', price: 15, durationMin: 20, squareVariationId: 'DXHOBSRP7SEUCA45V5V2HKLK' },
              ],
            },
            {
              id: 'mani-pedi-combo',
              name: 'Gel Manicure + Gel Pedicure (same time)',
              durationMin: 120,
              masters: [
                { masterId: 'ksenia', price: 190, durationMin: 120, squareVariationId: 'TC34QNP26F73Z736QC7DPUIP' },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'massage',
      name: 'Massage',
      subcategories: [
        {
          id: 'therapeutic',
          name: 'Therapeutic Massage',
          services: [
            {
              id: 'express-targeted-reset',
              name: 'Express Targeted Reset (45 min)',
              durationMin: 45,
              masters: [
                { masterId: 'ivan', price: 65, durationMin: 45, squareVariationId: 'AZW4FNAWBHCGC2N6WJVZIPKJ' },
              ],
            },
            {
              id: 'full-body-reset',
              name: 'Full Body Reset (60 min)',
              durationMin: 60,
              masters: [
                { masterId: 'ivan', price: 85, durationMin: 60, squareVariationId: 'EELD7H2CNJUSK5QHV2B355TH' },
              ],
            },
            {
              id: 'total-body-restoration',
              name: 'Total Body Restoration (90 min)',
              durationMin: 90,
              masters: [
                { masterId: 'ivan', price: 110, durationMin: 90, squareVariationId: 'MBA4QZOMPHBAE3ITCGAARRGU' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/**
 * Пакеты сессий. Пакет = подарочная карта Square с балансом = цене (оплачено=загружено).
 * sessionRateCents = priceCents / sessions (ровно делится). serviceId — какую услугу гасит.
 */
export const PACKAGES = {
  'massage-4': {
    id: 'massage-4',
    name: '4 Massage Sessions (60 min each)',
    priceCents: 30000,
    sessions: 4,
    sessionRateCents: 7500,
    serviceId: 'full-body-reset',
    expiryDays: 60,
    note: '4 × 60-min Full Body Reset · $75/session',
  },
  'massage-8': {
    id: 'massage-8',
    name: '8 Massage Sessions (60 min each)',
    priceCents: 59000,
    sessions: 8,
    sessionRateCents: 7375,
    serviceId: 'full-body-reset',
    expiryDays: 90,
    note: '8 × 60-min Full Body Reset · $73.75/session',
  },
};

/** Лимиты подарочного сертификата (произвольная сумма). */
export const CERTIFICATE = { minCents: 2500, maxCents: 100000 };

/** Плоский индекс услуг по id — удобно для бэкенда. */
export function indexServices(catalog = CATALOG) {
  const map = {};
  for (const cat of catalog.categories) {
    for (const sub of cat.subcategories) {
      for (const svc of sub.services) {
        map[svc.id] = { ...svc, categoryId: cat.id, subcategoryId: sub.id };
      }
    }
  }
  return map;
}
