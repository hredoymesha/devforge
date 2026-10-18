/*
 * Token-aware rebuild: a second way to build page content in the Recreate tab.
 *
 * The standard method writes one rule per element straight from computed styles, which is exact but
 * repetitive. This pass turns that output into something a person would maintain:
 *   - colours and font families used more than once become CSS custom properties on :root
 *   - rules with identical declarations are merged into one grouped rule
 *   - optionally, px sizes become rem
 * The recreated layout is unchanged: custom properties resolve to the same values, and merged
 * rules cannot conflict because the generator gives every element its own class.
 *
 * Input is the CSS DevForge itself generated (flat rules plus @keyframes), not arbitrary CSS.
 */
const DFRebuild = (() => {
  // Splits generated CSS into top-level blocks, keeping @-rules (keyframes, media) intact.
  function blocks(css) {
    const out = [];
    let depth = 0;
    let start = 0;
    let inStr = null;
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(css.slice(start, i + 1).trim());
          start = i + 1;
        }
      }
    }
    const tail = css.slice(start).trim();
    if (tail) out.push(tail);
    return out.filter(Boolean);
  }

  function parseRule(block) {
    const m = /^([^{]+)\{([\s\S]*)\}$/.exec(block);
    if (!m || m[1].trim().startsWith('@')) return null;
    const decls = [];
    let cur = '';
    let paren = 0;
    let q = null;
    for (const ch of m[2]) {
      if (q) {
        cur += ch;
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        cur += ch;
      } else if (ch === '(') {
        paren++;
        cur += ch;
      } else if (ch === ')') {
        paren--;
        cur += ch;
      } else if (ch === ';' && paren === 0) {
        if (cur.trim()) decls.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) decls.push(cur.trim());
    return {
      selector: m[1].trim(),
      decls: decls
        .map((d) => {
          const i = d.indexOf(':');
          return i < 0 ? null : [d.slice(0, i).trim(), d.slice(i + 1).trim()];
        })
        .filter(Boolean),
    };
  }

  const COLOR = /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/gi;
  const COLOR_PROPS = /^(color|background|background-color|border(-[a-z]+)*-color|border(-[a-z]+)*|outline(-color)?|fill|stroke|box-shadow|text-shadow|text-decoration-color|caret-color)$/;

  function rebuild(css, opts = {}) {
    const stats = { rulesBefore: 0, rulesAfter: 0, colorTokens: 0, fontTokens: 0, merged: 0, bytesBefore: css.length, bytesAfter: 0 };
    const parsed = [];
    const passthrough = [];
    for (const b of blocks(css)) {
      const r = parseRule(b);
      if (r) {
        parsed.push(r);
        stats.rulesBefore++;
      } else passthrough.push(b);
    }
    // 1. count colours and font families
    const colorCount = new Map();
    const fontCount = new Map();
    const norm = (c) => c.toLowerCase().replace(/\s+/g, '');
    for (const r of parsed)
      for (const [p, v] of r.decls) {
        if (COLOR_PROPS.test(p)) for (const m of v.match(COLOR) || []) colorCount.set(norm(m), (colorCount.get(norm(m)) || 0) + 1);
        if (p === 'font-family') fontCount.set(v, (fontCount.get(v) || 0) + 1);
      }
    const minUses = opts.minUses || 2;
    const colorVars = new Map();
    [...colorCount].filter(([, n]) => n >= minUses).sort((a, b) => b[1] - a[1]).forEach(([c], i) => colorVars.set(c, '--color-' + (i + 1)));
    const fontVars = new Map();
    [...fontCount].filter(([, n]) => n >= minUses).sort((a, b) => b[1] - a[1]).forEach(([f], i) => fontVars.set(f, '--font-' + (i + 1)));
    stats.colorTokens = colorVars.size;
    stats.fontTokens = fontVars.size;

    // 2. substitute
    const toRem = (v) => v.replace(/(-?\d*\.?\d+)px\b/g, (_, n) => (+n === 0 ? '0' : Math.round((+n / 16) * 10000) / 10000 + 'rem'));
    const SIZE_PROPS = /^(font-size|padding(-[a-z]+)*|margin(-[a-z]+)*|gap|row-gap|column-gap|border-radius|line-height|letter-spacing)$/;
    for (const r of parsed)
      r.decls = r.decls.map(([p, v]) => {
        if (COLOR_PROPS.test(p)) v = v.replace(COLOR, (m) => (colorVars.has(norm(m)) ? 'var(' + colorVars.get(norm(m)) + ')' : m));
        if (p === 'font-family' && fontVars.has(v)) v = 'var(' + fontVars.get(v) + ')';
        if (opts.rem && SIZE_PROPS.test(p) && !/var\(/.test(v)) v = toRem(v);
        return [p, v];
      });

    // 3. merge rules with identical declarations (selectors keep their original order)
    const groups = new Map();
    for (const r of parsed) {
      const key = r.decls.map(([p, v]) => p + ':' + v).join(';');
      if (!groups.has(key)) groups.set(key, { selectors: [], decls: r.decls });
      groups.get(key).selectors.push(r.selector);
    }
    stats.merged = parsed.length - groups.size;
    stats.rulesAfter = groups.size;

    const rootVars = [...colorVars].map(([c, n]) => '  ' + n + ': ' + c + ';').concat([...fontVars].map(([f, n]) => '  ' + n + ': ' + f + ';'));
    const out = [];
    if (rootVars.length) out.push(':root {\n' + rootVars.join('\n') + '\n}');
    for (const g of groups.values()) out.push(g.selectors.join(',\n') + ' {\n' + g.decls.map(([p, v]) => '  ' + p + ': ' + v + ';').join('\n') + '\n}');
    out.push(...passthrough);
    const result = out.join('\n\n');
    stats.bytesAfter = result.length;
    return { css: result, stats };
  }

  return { rebuild, blocks, parseRule };
})();
if (typeof module !== 'undefined') module.exports = DFRebuild;
