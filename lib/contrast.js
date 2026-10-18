/*
 * Colour readability. Pure functions (no DOM), testable in Node.
 *   ratio()        WCAG 2.x contrast ratio
 *   apca()         APCA-W3 lightness contrast (Lc), the model proposed for WCAG 3. Informational only:
 *                  WCAG 2.x ratios are still what accessibility rules and audits use.
 *   grade()        which WCAG levels a ratio reaches
 *   suggest()      the nearest foreground colour that reaches a target ratio
 *   simulate()     how a colour looks with common colour-vision deficiencies
 */
const DFContrast = (() => {
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() with comma or space syntax. Returns {r,g,b,a} or null.
  function parse(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    let m = /^#([0-9a-f]{3,4})$/.exec(s);
    if (m) {
      const v = m[1].split('').map((x) => parseInt(x + x, 16));
      return { r: v[0], g: v[1], b: v[2], a: v[3] == null ? 1 : v[3] / 255 };
    }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    }
    m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      if (p.length < 3) return null;
      const ch = (x) => (x.endsWith('%') ? (parseFloat(x) / 100) * 255 : parseFloat(x));
      const out = { r: ch(p[0]), g: ch(p[1]), b: ch(p[2]), a: p[3] == null ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]) };
      return [out.r, out.g, out.b, out.a].some((x) => isNaN(x)) ? null : { r: clamp(out.r, 0, 255), g: clamp(out.g, 0, 255), b: clamp(out.b, 0, 255), a: clamp(out.a, 0, 1) };
    }
    return null;
  }
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  // A translucent colour drawn over an opaque background.
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });

  const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);

  // ratio() is rounded for display; grade() works on exact() so 4.496:1 (shown as 4.5) is not a pass.
  // Text colour over a background; a translucent text colour is composited over the background first.
  function exact(fgIn, bgIn) {
    const bg = typeof bgIn === 'string' ? parse(bgIn) : bgIn;
    let fg = typeof fgIn === 'string' ? parse(fgIn) : fgIn;
    if (!fg || !bg) return null;
    if (fg.a < 1) fg = over(fg, bg.a < 1 ? over(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg);
    const [x, y] = [lum(fg), lum(bg)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }
  const ratio = (fg, bg) => {
    const r = exact(fg, bg);
    return r == null ? null : Math.round(r * 100) / 100;
  };

  // APCA-W3 0.0.98G. Positive = dark text on a light background, negative = light on dark.
  function apca(fgIn, bgIn) {
    const fg = typeof fgIn === 'string' ? parse(fgIn) : fgIn;
    const bg = typeof bgIn === 'string' ? parse(bgIn) : bgIn;
    if (!fg || !bg) return null;
    const y = (c) => {
      const v = 0.2126729 * Math.pow(c.r / 255, 2.4) + 0.7151522 * Math.pow(c.g / 255, 2.4) + 0.072175 * Math.pow(c.b / 255, 2.4);
      return v < 0.022 ? v + Math.pow(0.022 - v, 1.414) : v;
    };
    const yt = y(fg);
    const yb = y(bg);
    if (Math.abs(yb - yt) < 0.0005) return 0;
    let out;
    if (yb > yt) {
      const s = (Math.pow(yb, 0.56) - Math.pow(yt, 0.57)) * 1.14;
      out = s < 0.1 ? 0 : s - 0.027;
    } else {
      const s = (Math.pow(yb, 0.65) - Math.pow(yt, 0.62)) * 1.14;
      out = s > -0.1 ? 0 : s + 0.027;
    }
    return Math.round(out * 1000) / 10;
  }

  // WCAG 2.x thresholds. "ui" is the 3:1 needed for icons, borders and focus indicators.
  function grade(r) {
    if (r == null) return null;
    return { aaNormal: r >= 4.5, aaLarge: r >= 3, aaaNormal: r >= 7, aaaLarge: r >= 4.5, ui: r >= 3 };
  }
  const required = (large, level = 'AA') => (level === 'AAA' ? (large ? 4.5 : 7) : large ? 3 : 4.5);

  /* ---------- nearest passing colour ---------- */
  function toHsl({ r, g, b }) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    let h = 0,
      s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  }
  function fromHsl({ h, s, l }) {
    const f = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a: 1 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return { r: f(p, q, h + 1 / 3) * 255, g: f(p, q, h) * 255, b: f(p, q, h - 1 / 3) * 255, a: 1 };
  }
  // Moves the foreground's lightness (keeping hue and saturation) just far enough to reach `target`.
  // Tries both directions and returns the closer one that works, or null if neither does.
  function suggest(fgIn, bgIn, target = 4.5) {
    const fg0 = typeof fgIn === 'string' ? parse(fgIn) : fgIn;
    const bg = typeof bgIn === 'string' ? parse(bgIn) : bgIn;
    if (!fg0 || !bg) return null;
    const fg = fg0.a < 1 ? over(fg0, bg) : fg0;
    if (exact(fg, bg) >= target) return { hex: hex(fg), ratio: ratio(fg, bg), changed: false };
    const hsl = toHsl(fg);
    const search = (towardLight) => {
      let lo = hsl.l,
        hi = towardLight ? 1 : 0;
      if (exact(fromHsl({ ...hsl, l: hi }), bg) < target) return null;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (exact(fromHsl({ ...hsl, l: mid }), bg) >= target) hi = mid;
        else lo = mid;
      }
      // The search works on exact values; the colour handed back is a rounded hex, which can land a
      // hair under the target. Nudge until the rounded colour itself passes.
      let l = hi;
      let out = fromHsl({ ...hsl, l });
      for (let i = 0; i < 60 && exact(parse(hex(out)), bg) < target; i++) {
        l = clamp(l + (towardLight ? 0.002 : -0.002), 0, 1);
        out = fromHsl({ ...hsl, l });
      }
      const rounded = parse(hex(out));
      return exact(rounded, bg) >= target ? { hex: hex(rounded), ratio: ratio(rounded, bg), changed: true, delta: Math.abs(l - hsl.l) } : null;
    };
    const a = search(true);
    const b = search(false);
    const best = a && b ? (a.delta <= b.delta ? a : b) : a || b;
    return best ? { hex: best.hex, ratio: best.ratio, changed: true } : null;
  }

  /* ---------- colour-vision simulation (Machado et al. 2009, severity 1.0, applied in linear RGB) ---------- */
  const MATRICES = {
    protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
    tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
  };
  const unlin = (v) => {
    v = clamp(v, 0, 1);
    return 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  };
  function simulate(color, kind) {
    const c = typeof color === 'string' ? parse(color) : color;
    if (!c) return null;
    if (kind === 'achromatopsia') {
      const y = unlin(lum(c));
      return { r: y, g: y, b: y, a: c.a };
    }
    const M = MATRICES[kind];
    if (!M) return c;
    const v = [lin(c.r), lin(c.g), lin(c.b)];
    const o = M.map((row) => unlin(row[0] * v[0] + row[1] * v[1] + row[2] * v[2]));
    return { r: o[0], g: o[1], b: o[2], a: c.a };
  }
  const VISION = ['normal', 'protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia'];

  return { parse, hex, over, ratio, exact, apca, grade, required, suggest, simulate, VISION };
})();
if (typeof module !== 'undefined') module.exports = DFContrast;
