/* PDPA/cookie consent banner — shown once per browser, dismissed to localStorage. */
(function () {
  var KEY = 'mq_cookie_ok';
  try { if (localStorage.getItem(KEY)) return; } catch (_) { return; }

  var banner = document.createElement('div');
  banner.id = 'mq-cookie-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'ข้อมูลคุกกี้');
  banner.style.cssText = [
    'position:fixed;bottom:0;left:0;right:0',
    'background:#1e3a5f;color:#e8edf5',
    'padding:12px 16px',
    'display:flex;flex-wrap:wrap;gap:10px;align-items:center',
    'z-index:10000;font-family:system-ui,sans-serif;font-size:14px',
    'box-shadow:0 -2px 10px rgba(0,0,0,.25)',
    'line-height:1.5',
  ].join(';');

  banner.innerHTML =
    '<span style="flex:1;min-width:200px">' +
      'เว็บไซต์นี้ใช้คุกกี้เพื่อให้บริการและปรับปรุงประสบการณ์ของท่าน ' +
      'ตามนโยบาย <a href="/privacy" style="color:#7dd3fc;text-decoration:underline">ความเป็นส่วนตัว</a> (PDPA)' +
    '</span>' +
    '<div style="display:flex;gap:10px;flex-shrink:0;align-items:center">' +
      '<a href="/privacy" style="color:#93c5fd;font-size:13px;text-decoration:none">ตั้งค่า</a>' +
      '<button id="mq-cookie-accept" style="background:#16876f;color:#fff;border:none;padding:8px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700;white-space:nowrap">ยอมรับ</button>' +
    '</div>';

  function accept() {
    try { localStorage.setItem(KEY, '1'); } catch (_) {}
    banner.remove();
  }

  function init() {
    document.body.appendChild(banner);
    document.getElementById('mq-cookie-accept').addEventListener('click', accept);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
