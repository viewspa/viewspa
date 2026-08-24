// Google Analytics 4 + Google Ads
//
// ── Задача 1: Google Ads конверсия ──────────────────────────────────────────
// Маркетолог создаёт конверсионное действие в Google Ads и присылает ДВА значения.
// Вставь их сюда — больше нигде правок не нужно, конверсия на экране успеха заработает.
//   VS_ADS_TAG_ID    — тег аккаунта Ads, напр. 'AW-123456789'
//                      Именно он пишет куку _gcl_aw из gclid на лендинге → без него
//                      конверсия уйдёт без привязки к клику (снова direct).
//   VS_ADS_CONVERSION — полное действие для send_to, напр. 'AW-123456789/AbC-D_efG'
// Пока оба пустые — экран успеха пишет в консоль «skipped», а не молча ничего не делает.
var VS_ADS_TAG_ID    = 'AW-17742148410';
var VS_ADS_CONVERSION = 'AW-17742148410/jnJjCJf8udwcELrmjoxC';
window.VS_ADS_CONVERSION = VS_ADS_CONVERSION;

// gtag() должен существовать ДО загрузки библиотеки, иначе события на быстрых действиях
// (экран «You're booked!») отбрасываются. Стаб кладёт вызовы в dataLayer; библиотека
// разбирает очередь, когда догрузится. Это стандартный сниппет Google — отложена только
// сама вставка <script> ниже, ради производительности.
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
window.gtag = gtag;
gtag('js', new Date());
gtag('config', 'G-P0GR3YZQQL', { send_page_view: true });
if (VS_ADS_TAG_ID) gtag('config', VS_ADS_TAG_ID); // включает _gcl_aw (conversion linker в пределах домена — по умолчанию)

// Вставка gtag.js — сразу, без таймера.
// Раньше загрузка откладывалась на 3 сек после load ради производительности, но пока
// библиотека не загрузилась, GA4 не фиксирует начало сеанса и его источник: кто успевал
// уйти или кликнуть дальше за эти секунды, попадал в отчёты как Unassigned. За 22.08
// так потерялось 6 сеансов из 7 и половина дохода. Скрипт async и разметку не блокирует,
// так что выигрыш в скорости был десятки миллисекунд, а цена — половина атрибуции.
// vsEnsureAnalytics остаётся публичной и идемпотентной: экран успеха всё равно её зовёт.
var _vsGtagRequested = false;
function vsEnsureAnalytics() {
  if (_vsGtagRequested) return;
  _vsGtagRequested = true;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-P0GR3YZQQL';
  document.head.appendChild(s);
}
window.vsEnsureAnalytics = vsEnsureAnalytics;
vsEnsureAnalytics();

// ── Источник визита ────────────────────────────────────────────────────────
// Запоминаем первое касание на ЛЮБОЙ странице (раньше метки клика ловились
// только на booking.html — реклама, ведущая на /massage, теряла gclid).
// Пишем один раз и не перезаписываем 90 дней: нужен именно первый источник,
// а не тот заход, в котором человек дошёл до записи.
(function () {
  var KEY = 'vs_src';
  var MAX_AGE = 90 * 86400000;

  function read() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!o || !o.t || Date.now() - o.t > MAX_AGE) return null;
      return o;
    } catch (_) { return null; }
  }

  function paid(o) {
    return !!(o && (o.gclid || o.gbraid || o.wbraid || o.utm_source));
  }

  function capture() {
    try {
      var prev = read();
      var p = new URLSearchParams(location.search);
      // Обычно первое касание не перезаписываем. Исключение: раньше записан
      // заход без меток, а сейчас человек пришёл по рекламе или по ссылке
      // с utm. Такой визит важнее — иначе оплаченный клик потеряется, а
      // владелец увидит «прямой заход» и решит, что реклама не работает.
      var hasMarker = !!(p.get('gclid') || p.get('gbraid') || p.get('wbraid') || p.get('utm_source'));
      if (prev && (paid(prev) || !hasMarker)) return;
      var ref = '';
      try {
        // Внутренние переходы источником не считаются.
        if (document.referrer && new URL(document.referrer).hostname !== location.hostname) {
          ref = new URL(document.referrer).hostname;
        }
      } catch (_) {}

      var src = {
        t: Date.now(),
        ref: ref || '',
        land: (location.pathname || '/').slice(0, 120),
        utm_source: p.get('utm_source') || '',
        utm_medium: p.get('utm_medium') || '',
        utm_campaign: p.get('utm_campaign') || '',
        gclid: p.get('gclid') || '',
        gbraid: p.get('gbraid') || '',
        wbraid: p.get('wbraid') || '',
      };
      // Если перезаписали более ранний заход - сохраняем дату первого касания.
      if (prev) src.t0 = prev.t0 || prev.t;
      // Прямой заход без реферера и меток тоже пишем - это тоже ответ.
      localStorage.setItem(KEY, JSON.stringify(src));
    } catch (_) {}
  }

  capture();
  window.vsSource = read;
})();
