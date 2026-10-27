async () => {
  const trig = document.querySelector('.dshmcp-trigger');
  if (!trig) return { fatal: 'no trigger' };
  if (trig.getAttribute('aria-expanded') !== 'true') trig.click();
  await new Promise(r => setTimeout(r, 1800));
  const panel = document.querySelector('.dshmcp-panel');
  if (!panel) return { fatal: 'no panel' };

  window.__MIN_BODY = 14;
  window.__MIN_LABEL = 12;
  const ROOT = panel;

  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const cache = {};
  const rgba = (s) => {
    if (!s || s === 'transparent') return [0, 0, 0, 0];
    if (cache[s]) return cache[s];
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    let a = 1; const inner = (/\(([^)]*)\)/.exec(s) || [])[1] || '';
    const parts = inner.split(/[\s,/]+/).filter(Boolean);
    const raw = inner.includes('/') ? parts[parts.length - 1] : (/^(rgba|hsla)\(/.test(s) && parts.length === 4 ? parts[3] : null);
    if (raw) a = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
    return (cache[s] = [d[0], d[1], d[2], a]);
  };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const opaqueBg = (e) => {
    if (/^(IMG|VIDEO|CANVAS|PICTURE|IFRAME)$/.test(e.tagName) || e instanceof SVGElement) return null;
    const cs = getComputedStyle(e);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
    const c = rgba(cs.backgroundColor); return c[3] > 0.9 ? c : undefined;
  };
  const bgOf = (el) => {
    const own = opaqueBg(el); if (own !== undefined) return own;
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
      for (const e of document.elementsFromPoint(x, y)) {
        if (e === el || el.contains(e)) continue;
        const b = opaqueBg(e); if (b !== undefined) return b;
      }
      return [255, 255, 255, 1];
    }
    for (let e = el.parentElement; e && e.nodeType === 1; e = e.parentElement) { const b = opaqueBg(e); if (b !== undefined) return b; }
    return [255, 255, 255, 1];
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const scaleOf = (el) => { if (!(el instanceof SVGElement) || !el.getScreenCTM) return 1; const m = el.getScreenCTM(); return m ? Math.hypot(m.a, m.b) || 1 : 1; };
  const CAPTION = 'figcaption, footer, small, caption, aside, sup, sub, [class*=caption], [class*=credit], [class*=footnote], [class*=meta]';
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05; };
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const fam = (s) => (s || '').split(',')[0].replace(/["']/g, '').trim();

  const out = { small: [], lowContrast: [], eyebrows: [], dots: 0, emDashLabels: 0, arrows: 0, numbered: [],
                accentWord: [], cardKit: 0, hairlines: 0, radiusZero: 0, radiusTotal: 0, monoSmall: 0,
                broken: [], fonts: {}, display: null, body: null, headlineSerif: false, textColors: {}, bg: null,
                bodySmall: [], relImgs: [], textTotal: 0 };

  const all = Array.from(ROOT.querySelectorAll('*'));
  const cardSig = {};
  let displayEl = null, maxFs = 0;
  for (const el of all) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const t = ownText(el);
    const fs = parseFloat(cs.fontSize) * scaleOf(el);
    if (t.length > 1) {
      out.textTotal += t.length;
      if (fs > maxFs) { maxFs = fs; displayEl = el; }
      const f = fam(cs.fontFamily); out.fonts[f] = (out.fonts[f] || 0) + t.length;
      const col = rgba(cs.color); const key = col.slice(0, 3).join(',');
      out.textColors[key] = (out.textColors[key] || 0) + t.length * fs;
      if (fs < (window.__MIN_LABEL || 12)) out.small.push({ text: t.slice(0, 30), px: Math.round(fs) });
      if (t.length >= 28 && !el.closest(CAPTION) && fs < (window.__MIN_BODY || 14)) out.bodySmall.push({ text: t.slice(0, 30), px: Math.round(fs) });
      const bg = bgOf(el);
      if (bg) { const a = col[3] * opacityOf(el);
        const fg = [0, 1, 2].map((i) => col[i] * a + bg[i] * (1 - a));
        const c = contrast(fg, bg); const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
        if (c < (large ? 3 : 4.5)) out.lowContrast.push({ text: t.slice(0, 30), ratio: Math.round(c * 100) / 100, px: fs }); }
      const latin = t.replace(/[^A-Za-z]/g, '');
      const caps = cs.textTransform === 'uppercase' || (latin.length >= 3 && latin === latin.toUpperCase());
      const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) / fs;
      if (caps && latin.length >= 2 && ls >= 0.06 && fs <= 15) out.eyebrows.push(t.slice(0, 30));
      if (/\s·\s/.test(t)) out.dots += (t.match(/\s·\s/g) || []).length;
      if (/^[A-Z][A-Z\s]{1,20}\s—\s\S/.test(t)) out.emDashLabels++;
      if (/→\s*$/.test(t) && (el.closest('a,button') || cs.cursor === 'pointer')) out.arrows++;
      if (/^0\d([\s./—-]|$)/.test(t) && t.length <= 6) out.numbered.push(t);
      if (/mono/i.test(cs.fontFamily) && fs <= 14) out.monoSmall++;
    }
    if (cs.boxShadow !== 'none' && parseFloat(cs.borderRadius) > 0) {
      const sig = cs.borderRadius + '|' + cs.boxShadow; cardSig[sig] = (cardSig[sig] || 0) + 1;
    }
    const r = el.getBoundingClientRect();
    if (r.width > 200 && ['Top', 'Bottom', 'Left', 'Right'].some((s) => cs['border' + s + 'Style'] !== 'none' && parseFloat(cs['border' + s + 'Width']) > 0 && parseFloat(cs['border' + s + 'Width']) <= 1)) out.hairlines++;
    if (r.width > 120 && r.height > 60 && (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.borderStyle !== 'none')) {
      out.radiusTotal++; if (parseFloat(cs.borderRadius) === 0) out.radiusZero++;
    }
  }
  out.cardKit = Math.max(0, ...Object.values(cardSig));

  const h = displayEl;
  if (h) { const cs = getComputedStyle(h); out.display = fam(cs.fontFamily);
    const first = cs.fontFamily.split(',').map((x) => x.replace(/["']/g, '').trim()).find((x) => document.fonts.check(`16px "${x}"`) || /^(serif|sans-serif|monospace)$/.test(x)) || out.display;
    out.headlineSerif = !/sans/i.test(first) && /(^serif$|garamond|newsreader|serif|caslon|playfair|fraunces|cormorant|tiempos|lora|baskerville|didot|bodoni|georgia|times|songti|宋|明朝|mincho)/i.test(first); }

  const p = Array.from(ROOT.querySelectorAll('p, li')).find((e) => visible(e) && e.textContent.trim().length > 20);
  if (p) { const cs = getComputedStyle(p); out.body = fam(cs.fontFamily); out.bodyPx = parseFloat(cs.fontSize); }

  const rootEl = ROOT;
  out.bg = rgba(getComputedStyle(rootEl).backgroundColor);
  out.path = 'LIVE client.js panel';
  out.errors = [];
  return out;
}
