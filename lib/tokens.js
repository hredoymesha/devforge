// Turns raw token tallies from the page agent (agent/tokens.js) into named tokens and exports them
// as CSS custom properties, SCSS, W3C design-token JSON or a Tailwind theme. Pure functions.
const DFTokens = (() => {
  function parseHex(hex) {
    const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return {
      r: n >> 16,
      g: (n >> 8) & 255,
      b: n & 255,
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  function toHsl(c) {
    const r = c.r / 255,
      g = c.g / 255,
      b = c.b / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }
  // Hue buckets roughly matching the names designers use (and Tailwind's palette).
  const HUES = [
    [15, 'red'],
    [40, 'orange'],
    [65, 'yellow'],
    [100, 'lime'],
    [150, 'green'],
    [185, 'teal'],
    [200, 'cyan'],
    [245, 'blue'],
    [270, 'indigo'],
    [295, 'purple'],
    [330, 'pink'],
    [360, 'red'],
  ];
  function colorName(hex) {
    const c = parseHex(hex);
    if (!c) return 'color';
    const { h, s, l } = toHsl(c);
    if (l > 0.97) return 'white';
    if (l < 0.03) return 'black';
    const family = s < 0.12 ? 'gray' : HUES.find(([max]) => h < max)[1];
    // 50 = lightest … 950 = darkest, in steps of 50 at the ends and 100 in the middle.
    const raw = Math.round((1 - l) * 1000);
    const step = raw <= 75 ? 50 : raw >= 925 ? 950 : Math.round(raw / 100) * 100;
    return `${family}-${step}`;
  }

  const px = (v) => String(Math.round(parseFloat(v) * 100) / 100).replace('.', '_');
  function uniqueNames(items, nameOf) {
    const used = new Map();
    return items.map((it) => {
      const base = nameOf(it);
      const n = (used.get(base) || 0) + 1;
      used.set(base, n);
      return { ...it, name: n === 1 ? base : `${base}-${n}` };
    });
  }

  // Normalised, named token set. `minCount` drops one-off values that are rarely real tokens.
  function build(raw, opts) {
    const min = (opts && opts.minCount) || 1;
    const keep = (list) => (list || []).filter((x) => x.count >= min);
    return {
      colors: uniqueNames(keep(raw.colors), (c) =>
        c.value[0] === '#' ? colorName(c.value) : 'color'
      ),
      fontFamilies: uniqueNames(keep(raw.typography && raw.typography.families), (f) =>
        /mono|code|courier|consol/i.test(f.value)
          ? 'mono'
          : /serif/i.test(f.value) && !/sans/i.test(f.value)
            ? 'serif'
            : 'sans'
      ),
      fontSizes: uniqueNames(
        keep(raw.typography && raw.typography.sizes),
        (s) => 'size-' + px(s.value)
      ),
      fontWeights: uniqueNames(
        keep(raw.typography && raw.typography.weights),
        (w) => 'weight-' + w.value
      ),
      lineHeights: uniqueNames(
        keep(raw.typography && raw.typography.lineHeights),
        (s) => 'leading-' + px(s.value)
      ),
      spacing: uniqueNames(keep(raw.spacing), (s) => 'space-' + px(s.value)),
      radii: uniqueNames(keep(raw.radii), (r) => 'radius-' + px(r.value)),
      shadows: uniqueNames(keep(raw.shadows), () => 'shadow'),
    };
  }

  const GROUPS = [
    ['colors', 'color'],
    ['fontFamilies', 'font'],
    ['fontSizes', 'font'],
    ['fontWeights', 'font'],
    ['lineHeights', 'line'],
    ['spacing', ''],
    ['radii', ''],
    ['shadows', ''],
  ];
  const varName = (prefix, name) => (prefix ? `${prefix}-${name}` : name);

  function toCss(t) {
    const lines = [':root {'];
    for (const [key, prefix] of GROUPS) {
      if (!t[key].length) continue;
      lines.push(`  /* ${key} */`);
      for (const x of t[key]) lines.push(`  --${varName(prefix, x.name)}: ${x.value};`);
    }
    lines.push('}');
    return lines.join('\n') + '\n';
  }
  function toScss(t) {
    const lines = [];
    for (const [key, prefix] of GROUPS) {
      if (!t[key].length) continue;
      lines.push(`// ${key}`);
      for (const x of t[key]) lines.push(`$${varName(prefix, x.name)}: ${x.value};`);
      lines.push('');
    }
    return lines.join('\n');
  }
  // W3C Design Tokens Community Group format ($type / $value).
  function toJson(t) {
    const out = {};
    const put = (group, type, list, value = (x) => x.value) => {
      if (!list.length) return;
      out[group] = out[group] || {};
      for (const x of list)
        out[group][x.name] = { $type: type, $value: value(x), $description: `used ${x.count}×` };
    };
    put('color', 'color', t.colors);
    put('fontFamily', 'fontFamily', t.fontFamilies);
    put('fontSize', 'dimension', t.fontSizes);
    put('fontWeight', 'fontWeight', t.fontWeights, (x) => +x.value || x.value);
    put('lineHeight', 'dimension', t.lineHeights);
    put('spacing', 'dimension', t.spacing);
    put('radius', 'dimension', t.radii);
    put('shadow', 'shadow', t.shadows);
    return JSON.stringify(out, null, 2) + '\n';
  }
  function toTailwind(t) {
    const obj = (list, key = (x) => x.name) =>
      Object.fromEntries(list.map((x) => [key(x), x.value]));
    const strip = (prefix) => (x) => x.name.replace(prefix, '');
    const theme = {
      colors: obj(t.colors),
      fontFamily: Object.fromEntries(t.fontFamilies.map((f) => [f.name, [f.value]])),
      fontSize: obj(t.fontSizes, strip('size-')),
      fontWeight: obj(t.fontWeights, strip('weight-')),
      lineHeight: obj(t.lineHeights, strip('leading-')),
      spacing: obj(t.spacing, strip('space-')),
      borderRadius: obj(t.radii, strip('radius-')),
      boxShadow: obj(t.shadows),
    };
    return (
      '/** Generated by DevForge from computed styles. Review names before adopting. */\n' +
      "/** @type {import('tailwindcss').Config} */\n" +
      'module.exports = {\n  theme: {\n    extend: ' +
      JSON.stringify(theme, null, 2).replace(/\n/g, '\n    ') +
      ',\n  },\n};\n'
    );
  }

  // WCAG contrast ratio between two #rrggbb colors; null when either is not plain sRGB hex.
  function contrast(a, b) {
    const ca = parseHex(a),
      cb = parseHex(b);
    if (!ca || !cb) return null;
    const lum = ({ r, g, b: bb }) =>
      [r, g, bb]
        .map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        })
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [x, y] = [lum(ca), lum(cb)].sort((m, n) => n - m);
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
  }

  return { colorName, build, toCss, toScss, toJson, toTailwind, contrast, parseHex };
})();
if (typeof module !== 'undefined') module.exports = DFTokens;
