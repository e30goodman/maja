(function () {
  var cfg = window.MAJA_ANALYTICS || {};
  var id = cfg.gaMeasurementId;
  if (!id || id === 'G-XXXXXXXXXX') return;

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', id, {
    anonymize_ip: true,
    send_page_view: true,
  });

  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  document.head.appendChild(script);

  window.majaTrack = function (eventName, params) {
    gtag('event', eventName, params || {});
  };

  document.addEventListener('click', function (event) {
    var el = event.target.closest('[data-track]');
    if (!el) return;
    majaTrack(el.getAttribute('data-track'), {
      event_category: 'promo',
      event_label: el.getAttribute('data-track-label') || (el.textContent || '').trim().slice(0, 80),
      page_path: window.location.pathname,
    });
  });
})();
