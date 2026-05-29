// Google Analytics 4 — deferred after page load
window.addEventListener('load', function () { setTimeout(function () {
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=G-P0GR3YZQQL';
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', 'G-P0GR3YZQQL', { send_page_view: true });
  }, 3000); });
