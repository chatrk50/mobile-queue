// White-label brand applier — fetch /api/brand and theme the page (name, primary colour, logo,
// title). Defaults to YO-DEE server-side, so this is a no-op for the existing shop. Include with
// <script src="/assets/brand.js"></script> and tag brand spots with data-brand-name / data-brand-short.
(async function () {
  try {
    const b = await (await fetch('/api/brand')).json();
    window.BRAND = b;
    if (b.theme) {
      document.documentElement.style.setProperty('--navy', b.theme);
      const m = document.querySelector('meta[name=theme-color]');
      if (m) m.setAttribute('content', b.theme);
    }
    if (b.logo) document.querySelectorAll('img.logo,[data-brand-logo]').forEach(function (el) { el.src = b.logo; });
    document.querySelectorAll('[data-brand-name]').forEach(function (el) { el.textContent = b.name; });
    document.querySelectorAll('[data-brand-short]').forEach(function (el) { el.textContent = b.short; });
    if (b.name) document.title = document.title.replace(/YO-DEE Yogurt/g, b.name).replace(/YO-DEE/g, b.short || b.name);
  } catch (e) { /* keep YO-DEE defaults baked into the HTML */ }
})();
