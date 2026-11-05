// Seeded generators of hostile input, shared by test/fuzz.test.js (Node) and e2e/features.js
// (browser). The same seed always gives the same cases, so a failure can be replayed:
//   FUZZ_SEED=12345 node --test test/fuzz.test.js
// No dependency. mulberry32 is a small, well-known 32-bit generator.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  const chance = (p) => next() < p;
  const repeat = (s, min, max) => s.repeat(min + int(max - min + 1));
  return { next, int, pick, chance, repeat };
}

/* ---------- CSS ---------- */
const CSS_BITS = ['url(', 'url( ', ')', '"', "'", ' ', '\n', '\t', '\\', '/*', '*/', '@import ', '@import url(', 'a{', '}', ';', ':', 'background:', 'x.png', '/a/b.css', '../x', 'data:image/png;base64,AAAA', '\u0000', ' ', '%', '#frag', 'https://example.com/', '//cdn.example/x.woff2'];
function hostileCss(r, maxLen = 400) {
  let s = '';
  while (s.length < maxLen) {
    s += r.chance(0.12) ? r.repeat(r.pick(CSS_BITS), 2, 40) : r.pick(CSS_BITS);
  }
  return s;
}

/* ---------- HTML ---------- */
const RAW = ['noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'style', 'script', 'textarea', 'title'];
const TAGS = [...RAW, 'a', 'img', 'form', 'input', 'button', 'object', 'embed', 'meta', 'base', 'svg', 'math', 'template', 'div', 'p', 'table', 'select', 'option', 'link', 'video', 'source', 'details'];
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'data', 'poster', 'ping', 'background', 'cite', 'longdesc', 'manifest', 'xlink:href'];
const JS_URLS = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java&#9;script:alert(1)', '&#106;avascript:alert(1)', '\u0001javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>', 'DATA:TEXT/HTML;base64,PHNjcmlwdD4=', '​javascript:alert(1)'];
const EVENTS = ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus', 'ONCLICK', 'oNeRrOr', 'onanimationstart', 'onpointerdown', 'onbeforetoggle'];
function hostileHtml(r, size = 12) {
  const parts = [];
  const attrs = () => {
    let a = '';
    for (let i = r.int(4); i > 0; i--) {
      const k = r.int(5);
      if (k === 0) a += ' ' + r.pick(EVENTS) + '="alert(' + r.int(9) + ')"';
      else if (k === 1) a += ' ' + r.pick(URL_ATTRS) + '="' + r.pick(JS_URLS) + '"';
      else if (k === 2) a += ' srcdoc="<script>alert(1)</script>"';
      else if (k === 3) a += ' http-equiv="refresh" content="0;url=javascript:alert(1)"';
      else a += ' data-x="' + r.int(99) + '" title="</' + r.pick(RAW) + '><img src=x onerror=alert(1)>"';
    }
    return a;
  };
  for (let i = 0; i < size; i++) {
    const tag = r.pick(TAGS);
    const k = r.int(6);
    if (k === 0) parts.push('</' + r.pick(RAW) + '>');
    else if (k === 1) parts.push('<' + tag + attrs() + '>');
    else if (k === 2) parts.push('<' + tag + attrs() + '></' + tag + '>');
    else if (k === 3) parts.push('<' + r.pick(RAW) + '>' + '</' + r.pick(RAW) + '><img src=x onerror=alert(1)>' + '</' + r.pick(RAW) + '>');
    else if (k === 4) parts.push('text ' + r.int(1000) + ' <b>bold</b>');
    else parts.push('<!--' + (r.chance(0.5) ? '</noscript><img onerror=alert(1)>' : 'c') + '-->');
  }
  return parts.join('');
}

/* ---------- addresses ---------- */
const HOST_JUNK = ['', ' ', '\t', '\n', '\\', '@', '#', '?', '%', '[', ']', '::', '..', '.', '0x', '0X', '1e3', '٠', '１２７.０.０.１', '。', '‥', '%2e', '%31', '­'];
function hostileUrl(r) {
  const scheme = r.pick(['http:', 'https:', 'ws:', 'ftp:', 'file:', 'blob:', 'data:', '', '//', 'HTTP:', 'javascript:']);
  let host = '';
  for (let i = 1 + r.int(8); i > 0; i--) host += r.chance(0.5) ? r.pick(HOST_JUNK) : r.pick(['127', '0', '1', '10', '192', '168', 'localhost', 'a', 'example.com', 'ffff', 'fe80', '255', '[', ']', ':', '.']);
  return scheme + (r.chance(0.8) ? '//' : '') + (r.chance(0.2) ? 'user:pw@' : '') + host + (r.chance(0.3) ? ':' + r.pick(['80', '443', '2375', '99999', '0', '', 'x']) : '') + (r.chance(0.5) ? r.pick(['/', '/a?b#c', '\\x', '/../']) : '');
}

// Ways to write the same IPv4 address. Each is something the URL parser accepts and turns into
// dotted decimal, which is what the private-address check sees.
function ipv4Spellings(o) {
  const n = ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
  const oct = (x) => '0' + x.toString(8);
  const hex = (x) => '0x' + x.toString(16);
  const out = [
    o.join('.'),
    String(n),
    hex(n),
    '0X' + n.toString(16).toUpperCase(),
    o.map(oct).join('.'),
    o.map(hex).join('.'),
    [o[0], o[1], o[2] * 256 + o[3]].join('.'),
    [o[0], o[1] * 65536 + o[2] * 256 + o[3]].join('.'),
    [o[0], o[1], o[2], o[3]].map((x, i) => (i % 2 ? oct(x) : String(x))).join('.'),
    o.join('.') + '.',
    '[::ffff:' + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16) + ']',
    '[::ffff:' + o.join('.') + ']',
  ];
  return out;
}

/* ---------- names ---------- */
const NAME_BITS = ['..', '.', '/', '\\', ':', 'C:', 'c:', '\u0000', '\n', ' ', 'a', 'B', 'index.html', 'AUX', 'con', '%2e%2e', '~', '‮', 'é', '日本', '?', '*', '"', '<', '>', '|', 'x'.repeat(300), '//', '\\\\', '....//', '/..\\'];
function hostileName(r) {
  let s = '';
  for (let i = 1 + r.int(7); i > 0; i--) s += r.pick(NAME_BITS);
  return s;
}

const seedFromEnv = (fallback) => (process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) >>> 0 : fallback);
const roundsFromEnv = (fallback) => (process.env.FUZZ_ROUNDS ? Number(process.env.FUZZ_ROUNDS) || fallback : fallback);

module.exports = { rng, hostileCss, hostileHtml, hostileUrl, hostileName, ipv4Spellings, seedFromEnv, roundsFromEnv, RAW, URL_ATTRS };
