/* YO-DEE language switch — shared engine (ไทย / English / ລາວ).
 * Pages are written in Thai. A page loads this engine plus its own dictionary (rows of
 * [thai, english, lao]) and calls YD_I18N_BOOT. The engine translates what the page SHOWS:
 * every text node and label attribute is looked up in the dictionary (exact phrase, or the phrase
 * with its numbers replaced by {n}); a MutationObserver does the same for anything rendered later.
 * Thai is the source of truth: switching back restores the original strings. */
(function () {
  const LANGS = { th: 'ไทย', en: 'EN', lo: 'ລາວ' };
  const KEY = 'yd_lang';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const NUM = /\d[\d,.]*/g;

  window.YD_I18N_BOOT = function (opts) {
    const rows = (opts && opts.rows) || [];
    const EN = Object.create(null), LO = Object.create(null);
    for (const [th, en, lo] of rows) { EN[th] = en; LO[th] = lo; }
    const DICTS = { en: EN, lo: LO };
    let lang = 'th';
    try { lang = localStorage.getItem(KEY) || 'th'; } catch (e) { /* private mode */ }
    if (!LANGS[lang]) lang = 'th';

    function tr(text) {
      if (lang === 'th') return null;
      const dict = DICTS[lang];
      const t = String(text).trim();
      if (!t) return null;
      let out = dict[t];
      if (out == null) {
        const nums = t.match(NUM);
        if (nums) {
          const p = dict[t.replace(NUM, '{n}')];
          if (p != null) { let i = 0; out = p.replace(/\{n\}/g, () => (i < nums.length ? nums[i++] : '')); }
        }
      }
      if (out == null) return null;
      return text.match(/^\s*/)[0] + out + text.match(/\s*$/)[0];
    }
    function applyText(node) {
      if (node.__th == null) node.__th = node.nodeValue;
      const v = lang === 'th' ? node.__th : (tr(node.__th) ?? node.__th);
      if (node.nodeValue !== v) { node.__tr = v; node.nodeValue = v; }
    }
    function applyEl(el) {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const k = '__th_' + a;
        if (el[k] == null) el[k] = el.getAttribute(a);
        const v = lang === 'th' ? el[k] : (tr(el[k]) ?? el[k]);
        if (el.getAttribute(a) !== v) el.setAttribute(a, v);
      }
    }
    const skip = (el) => el && el.nodeType === 1 && (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.id === 'ydLang' || el.hasAttribute('data-no-i18n'));
    function walk(root) {
      if (root.nodeType === 3) { if (!skip(root.parentNode)) applyText(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 11) return;
      if (root.nodeType === 1) { if (skip(root)) return; applyEl(root); }
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: (n) => (n.nodeType === 1 ? (skip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) : NodeFilter.FILTER_ACCEPT),
      });
      let n;
      while ((n = w.nextNode())) { if (n.nodeType === 1) applyEl(n); else applyText(n); }
    }
    const mo = new MutationObserver((muts) => {
      if (lang === 'th') return;
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach(walk);
        else if (m.type === 'characterData') { const n = m.target; if (n.nodeValue === n.__tr || skip(n.parentNode)) continue; n.__th = n.nodeValue; applyText(n); }
      }
    });
    let bar = null;
    function paint() {
      if (!bar) return;
      if (bar.dataset.mode === 'cycle') { bar.textContent = LANGS[lang]; bar.setAttribute('aria-label', 'Language: ' + LANGS[lang]); return; }
      bar.querySelectorAll('button').forEach((b) => { const on = b.dataset.lang === lang; b.style.background = on ? 'var(--accent,#00b5d8)' : 'transparent'; b.style.color = on ? '#fff' : 'var(--navy,#16314f)'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    }
    function setLang(l) {
      if (!LANGS[l]) return;
      lang = l;
      try { localStorage.setItem(KEY, l); } catch (e) { /* ignore */ }
      document.documentElement.lang = l;
      walk(document.body);
      paint();
      try { document.dispatchEvent(new CustomEvent('yd:lang', { detail: { lang: l } })); } catch (e) { /* old engines */ }
    }
    const order = Object.keys(LANGS);
    function cycle() { setLang(order[(order.indexOf(lang) + 1) % order.length]); }
    function mount() {
      if (bar || !document.body) return;
      const into = opts && opts.into ? document.querySelector(opts.into) : null;
      if (into) {
        // A single button in the page's own toolbar that cycles ไทย → EN → ລາວ.
        bar = document.createElement('button');
        bar.type = 'button'; bar.id = 'ydLang'; bar.dataset.mode = 'cycle';
        bar.className = (opts.className || 'ghost');
        bar.style.cssText = 'font-weight:800;font-size:12px;letter-spacing:.2px;min-width:44px;padding:0 10px;font-family:inherit';
        bar.title = 'ภาษา / Language / ພາສາ';
        bar.addEventListener('click', cycle);
        const before = opts.before ? into.querySelector(opts.before) : null;
        if (before) into.insertBefore(bar, before); else into.appendChild(bar);
      } else {
        bar = document.createElement('div');
        bar.id = 'ydLang';
        bar.setAttribute('role', 'group');
        bar.setAttribute('aria-label', 'Language');
        bar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:80;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(255,255,255,.94);border:1px solid var(--line,#e3e8ef);box-shadow:0 4px 14px rgba(16,40,70,.12);font-family:inherit';
        for (const [code, label] of Object.entries(LANGS)) {
          const b = document.createElement('button');
          b.type = 'button'; b.dataset.lang = code; b.textContent = label;
          b.style.cssText = 'border:none;border-radius:999px;padding:5px 9px;font-size:12px;font-weight:800;line-height:1;cursor:pointer;font-family:inherit;min-width:36px;min-height:26px';
          b.addEventListener('click', () => setLang(code));
          bar.appendChild(b);
        }
        document.body.appendChild(bar);
      }
      paint();
      document.documentElement.lang = lang;
      if (lang !== 'th') walk(document.body);
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
    window.YD_LANG = { get: () => lang, set: setLang, tr: (t) => (tr(t) ?? t), list: LANGS };
    return window.YD_LANG;
  };
})();
