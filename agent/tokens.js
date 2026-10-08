/*
 * Design token extraction: reads the computed styles of visible elements and tallies the values a
 * page actually uses (colors, type scale, spacing, radii, shadows), plus the custom properties
 * declared on :root. Naming and export formats are done in the panel (lib/tokens.js).
 */
(() => {
  const DF = window.__DF;
  if (!DF || DF.designTokens) return;
  const { target, isOwn, allSheets, MAX_NODES } = DF.kit;

  // Normalises rgb()/rgba() to #rrggbb or #rrggbbaa and returns null for transparent. Wide-gamut
  // values (oklch(), color(display-p3 …)) are kept verbatim rather than squashed into sRGB.
  function toHex(c) {
    if (!c || /^(transparent|none|currentcolor|auto)$/i.test(c)) return null;
    const m = /^rgba?\(([^)]+)\)$/.exec(c);
    if (!m) return /^[a-z-]+\(/i.test(c) ? c : null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    if (p.length < 3 || p.some((x, i) => i < 3 && isNaN(x))) return null;
    const a = p[3] == null || isNaN(p[3]) ? 1 : p[3];
    if (a === 0) return null;
    const hx = (n) =>
      Math.max(0, Math.min(255, Math.round(n)))
        .toString(16)
        .padStart(2, '0');
    return '#' + hx(p[0]) + hx(p[1]) + hx(p[2]) + (a < 1 ? hx(a * 255) : '');
  }

  function tally(map, key, role) {
    if (key == null || key === '') return;
    const e = map.get(key) || { value: key, count: 0, roles: {} };
    e.count++;
    if (role) e.roles[role] = (e.roles[role] || 0) + 1;
    map.set(key, e);
  }
  const top = (map, n) => [...map.values()].sort((a, b) => b.count - a.count).slice(0, n);

  function rootVariables() {
    const out = [];
    const seen = new Set();
    const cs = getComputedStyle(document.documentElement);
    for (const sheet of allSheets(document)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue; // cross-origin sheet
      }
      const walk = (list) => {
        for (const r of list) {
          if (r.cssRules && r.type !== 1) walk(r.cssRules);
          if (r.type !== 1 || !/(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText)) continue;
          for (let i = 0; i < r.style.length; i++) {
            const name = r.style[i];
            if (!name.startsWith('--') || seen.has(name)) continue;
            seen.add(name);
            out.push({
              name,
              declared: r.style.getPropertyValue(name).trim(),
              resolved: cs.getPropertyValue(name).trim(),
            });
          }
        }
      };
      walk(rules);
      if (out.length > 400) break;
    }
    return out;
  }

  function designTokens(h) {
    const root = h ? target(h) : document.body || document.documentElement;
    const colors = new Map();
    const families = new Map();
    const sizes = new Map();
    const weights = new Map();
    const lineHeights = new Map();
    const spacing = new Map();
    const radii = new Map();
    const shadows = new Map();
    let scanned = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el = root;
    while (el && scanned < Math.min(MAX_NODES, 8000)) {
      if (
        !isOwn(el) &&
        !/^(SCRIPT|STYLE|LINK|META|HEAD|TITLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)
      ) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if ((r.width || r.height) && cs.display !== 'none' && cs.visibility !== 'hidden') {
          scanned++;
          const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          if (hasText) {
            tally(colors, toHex(cs.color), 'text');
            tally(
              families,
              cs.fontFamily
                .split(',')[0]
                .trim()
                .replace(/^["']|["']$/g, '')
            );
            tally(sizes, cs.fontSize);
            tally(weights, cs.fontWeight);
            if (cs.lineHeight !== 'normal') tally(lineHeights, cs.lineHeight);
          }
          tally(colors, toHex(cs.backgroundColor), 'background');
          if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none')
            tally(colors, toHex(cs.borderTopColor), 'border');
          if (el instanceof SVGElement) {
            tally(colors, toHex(cs.fill), 'fill');
            tally(colors, toHex(cs.stroke), 'stroke');
          }
          for (const p of [
            'marginTop',
            'marginRight',
            'marginBottom',
            'marginLeft',
            'paddingTop',
            'paddingRight',
            'paddingBottom',
            'paddingLeft',
            'rowGap',
            'columnGap',
          ]) {
            const val = cs[p];
            if (val && /px$/.test(val) && parseFloat(val) > 0) tally(spacing, val);
          }
          if (cs.borderTopLeftRadius !== '0px') tally(radii, cs.borderTopLeftRadius);
          if (cs.boxShadow && cs.boxShadow !== 'none') tally(shadows, cs.boxShadow);
        }
      }
      el = walker.nextNode();
    }
    const byPx = (a, b) => parseFloat(a.value) - parseFloat(b.value);
    return {
      scope: h ? DF.kit.label(root) : 'page',
      scanned,
      colors: top(colors, 48),
      typography: {
        families: top(families, 10),
        sizes: top(sizes, 24).sort(byPx),
        weights: top(weights, 10).sort((a, b) => +a.value - +b.value),
        lineHeights: top(lineHeights, 12).sort(byPx),
      },
      spacing: top(spacing, 24).sort(byPx),
      radii: top(radii, 12).sort(byPx),
      shadows: top(shadows, 10),
      variables: rootVariables(),
      provenance: 'observed (computed styles of visible elements)',
    };
  }

  DF.extend({ designTokens });
})();
