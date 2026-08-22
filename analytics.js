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
