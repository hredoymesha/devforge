// Property and fuzz tests for the code that handles hostile input. Inputs come from seeded
// generators (e2e/fuzzgen.js), so a failure prints its seed and can be replayed:
//   FUZZ_SEED=123 FUZZ_ROUNDS=5000 node --test test/fuzz.test.js
// Time budgets catch catastrophic backtracking, which a hostile page could use to freeze the panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gen = require('../e2e/fuzzgen.js');
const Safe = require('../lib/safe.js');
const Site = require('../lib/site.js');
const Zip = require('../lib/zip.js');
const Probe = require('../lib/secprobe.js');

const SEED = gen.seedFromEnv(20260511);
const ROUNDS = gen.roundsFromEnv(1500);
const where = (extra) => ' (seed ' + SEED + (extra ? ', ' + extra : '') + ')';

function within(ms, label, fn) {
  const t = Date.now();
  const out = fn();
  const spent = Date.now() - t;
  assert.ok(spent < ms, label + ' took ' + spent + ' ms, budget ' + ms + ' ms');
  return out;
}

/* ---------- private-address check ---------- */

const PAGE = 'https://public.example/';
const ip4 = (n) => [Number((n >> 24n) & 255n), Number((n >> 16n) & 255n), Number((n >> 8n) & 255n), Number(n & 255n)];
const toBig4 = (o) => o.reduce((a, x) => a * 256n + BigInt(x), 0n);
const cidr = (base, bits, width) => ({ base, bits: BigInt(bits), width: BigInt(width) });
const inCidr = (n, c) => n >> (c.width - c.bits) === c.base >> (c.width - c.bits);
// Special-purpose IPv4 space, written as CIDR blocks (not copied from lib/safe.js).
const V4_SPECIAL = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, b]) => cidr(toBig4(a.split('.').map(Number)), b, 32));
const oracle4 = (o) => V4_SPECIAL.some((c) => inCidr(toBig4(o), c));

test('private IPv4 check agrees with a CIDR table for every spelling the URL parser accepts' + where(), () => {
  const r = gen.rng(SEED);
  let parsed = 0;
  for (let i = 0; i < ROUNDS; i++) {
    // Half the draws come from inside a special block so the private side is well covered.
    const o = r.chance(0.5) ? ip4(BigInt(r.int(2 ** 31)) * 2n + BigInt(r.int(2))) : ip4(V4_SPECIAL[r.int(V4_SPECIAL.length)].base + BigInt(r.int(255)));
    for (const sp of gen.ipv4Spellings(o)) {
      let u;
      try {
        u = new URL('http://' + sp + '/');
      } catch (_) {
        continue; // not a spelling the URL parser accepts
      }
      parsed++;
      const m = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(u.hostname);
      if (!m) assert.equal(u.hostname.replace(/\.$/, ''), o.join('.'), 'spelling ' + sp + ' is not ' + o.join('.') + where());
      const got = Safe.blocksPrivate(u.href, PAGE);
      assert.equal(got, oracle4(o), sp + ' -> ' + u.hostname + ' for ' + o.join('.') + where());
    }
  }
  assert.ok(parsed > ROUNDS * 8, 'enough spellings were accepted by the parser: ' + parsed);
});

const g6 = (groups) => groups.map((x) => BigInt(x)).reduce((a, x) => (a << 16n) | x, 0n);
const embedded4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
function oracle6(g) {
  const n = g6(g);
  const c6 = (groups, bits) => inCidr(n, cidr(g6(groups), bits, 128));
  if (c6([0, 0, 0, 0, 0, 0, 0, 0], 96)) return true; // ::/96 covers ::, ::1 and the IPv4-compatible block
  if (c6([0, 0, 0, 0, 0, 0xffff, 0, 0], 96)) return oracle4(embedded4(g[6], g[7]));
  if (c6([0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96)) return oracle4(embedded4(g[6], g[7]));
  if (c6([0x2002, 0, 0, 0, 0, 0, 0, 0], 16)) return oracle4(embedded4(g[1], g[2]));
  return [[[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], [[0xfec0, 0, 0, 0, 0, 0, 0, 0], 10], [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8], [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32]].some(([b, bits]) => c6(b, bits));
}
function v6Spellings(g, r) {
  const hex = (x) => x.toString(16);
  const full = g.map(hex).join(':');
  const padded = g.map((x) => hex(x).padStart(4, '0')).join(':');
  // Compress the longest run of zero groups, the way people (and RFC 5952) write it.
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  const squeezed = best[1] >= 2 ? g.slice(0, best[0]).map(hex).join(':') + '::' + g.slice(best[0] + best[1]).map(hex).join(':') : full;
  const out = [full, padded.toUpperCase(), squeezed, squeezed.toUpperCase()];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) out.push('::ffff:' + embedded4(g[6], g[7]).join('.'));
  return out.map((s) => '[' + s + ']').concat(r.chance(0.2) ? ['[' + squeezed + ']'] : []);
}

test('private IPv6 check agrees with a CIDR table, including mapped, NAT64 and 6to4 forms' + where(), () => {
  const r = gen.rng(SEED + 1);
  const anchors = [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0xffff, 0, 0], [0x64, 0xff9b, 0, 0, 0, 0, 0, 0], [0x2002, 0, 0, 0, 0, 0, 0, 0], [0xfc00, 0, 0, 0, 0, 0, 0, 0], [0xfe80, 0, 0, 0, 0, 0, 0, 0], [0xff02, 0, 0, 0, 0, 0, 0, 0], [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], [0x2606, 0x4700, 0, 0, 0, 0, 0, 0]];
  let compared = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const g = r.chance(0.3) ? Array.from({ length: 8 }, () => r.int(65536)) : anchors[r.int(anchors.length)].map((x, k) => (x === 0 && r.chance(0.8) ? (k >= 6 || r.chance(0.3) ? r.int(65536) : 0) : x));
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0) g[0] = 0; // keep the ::/96 family reachable
    for (const sp of v6Spellings(g, r)) {
      let u;
      try {
        u = new URL('http://' + sp + '/');
      } catch (_) {
        continue;
      }
      compared++;
      assert.equal(Safe.blocksPrivate(u.href, PAGE), oracle6(g), sp + ' -> ' + u.hostname + where());
    }
  }
  assert.ok(compared > ROUNDS * 3);
});

test('the private-address check never throws and always answers true or false' + where(), () => {
  const r = gen.rng(SEED + 2);
  for (let i = 0; i < ROUNDS * 2; i++) {
    const url = gen.hostileUrl(r);
    const got = Safe.blocksPrivate(url, r.chance(0.7) ? PAGE : gen.hostileUrl(r));
    assert.equal(typeof got, 'boolean', JSON.stringify(url) + where());
    assert.equal(typeof Safe.isPrivateHost(url), 'boolean');
  }
});

test('names for loopback and local hosts are refused in every case and with trailing dots' + where(), () => {
  const r = gen.rng(SEED + 3);
  for (let i = 0; i < 300; i++) {
    const name = ['localhost', 'LocalHost', 'a.localhost', 'x.y.LOCALHOST', 'printer.local', 'db.internal', 'router.home.arpa'][r.int(7)] + '.'.repeat(r.int(3));
    assert.equal(Safe.blocksPrivate('http://' + name + ':8080/x', PAGE), true, name);
  }
});

/* ---------- CSS rewriting ---------- */

test('rewriteCss and discoverCssUrls never throw and leave unmapped CSS exactly as it was' + where(), () => {
  const r = gen.rng(SEED + 4);
  for (let i = 0; i < ROUNDS; i++) {
    const css = gen.hostileCss(r);
    assert.equal(Site.rewriteCss(css, 'https://a.example/s/x.css', 'site/a.example/s/x.css', new Map()), css, JSON.stringify(css) + where());
    const found = Site.discoverCssUrls(css, 'https://a.example/s/x.css');
    assert.ok(Array.isArray(found) && found.every((u) => /^https?:\/\//.test(u)), where());
  }
});

test('rewriteCss points mapped addresses at the saved copy and touches nothing else' + where(), () => {
  const r = gen.rng(SEED + 5);
  const map = new Map([[Site.norm('https://a.example/img/a.png'), 'site/a.example/img/a.png']]);
  for (let i = 0; i < 300; i++) {
    const pad = gen.hostileCss(r, 60).replace(/url\(|@import|[)'"\\]/gi, '');
    const q = r.pick(['', '"', "'"]);
    const out = Site.rewriteCss(pad + 'a{background:url(' + q + '/img/a.png' + q + ')}' + pad, 'https://a.example/s/x.css', 'site/a.example/s/x.css', map);
    assert.ok(out.startsWith(pad) && out.endsWith(pad), where());
    assert.match(out, /url\("\.\.\/img\/a\.png"\)/, out + where());
  }
});

test('hostile CSS cannot freeze the rewrite (time budget)', () => {
  const cases = {
    'unclosed url( with spaces': 'url(' + ' '.repeat(80000),
    'many unclosed url(': 'url('.repeat(20000),
    'url( and quotes': 'url("' + 'a'.repeat(80000),
    'import and quote': '@import "' + 'x'.repeat(80000),
    'many url( and spaces': ('url(' + ' '.repeat(40)).repeat(2000),
    'many imports': '@import url(  '.repeat(10000),
  };
  for (const [name, css] of Object.entries(cases)) {
    within(1500, 'rewriteCss, ' + name, () => Site.rewriteCss(css, 'https://a.example/x.css', 'x.css', new Map()));
    within(1500, 'discoverCssUrls, ' + name, () => Site.discoverCssUrls(css, 'https://a.example/x.css'));
  }
});

/* ---------- paths and ZIP names ---------- */

function zipNames(buf) {
  // Names from the central directory. The writer uses no data descriptors, so a plain scan is exact.
  const names = [];
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(p + 28);
    const m = buf.readUInt16LE(p + 30);
    const k = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + n).toString('utf8'));
    p += 46 + n + m + k;
  }
  return names;
}
// What an extractor on Windows, macOS or Linux could turn into a path outside the folder, or a
// name that hides its real type.
const unsafeName = (n) =>
  n.split('/').some((s) => s === '..' || s === '.' || /^\.+$/.test(s.replace(/[ .]+$/, '')) || s === '') ||
  /^[a-zA-Z]:/.test(n) ||
  n.startsWith('/') ||
  n.includes('\\') ||
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being rejected
  /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(n);

test('ZIP entry names from hostile paths are safe and unique' + where(), async () => {
  const r = gen.rng(SEED + 6);
  for (let round = 0; round < 200; round++) {
    const files = Array.from({ length: 1 + r.int(12) }, () => ({ path: gen.hostileName(r), data: 'x' }));
    const names = zipNames(Buffer.from(await Zip.build(files).arrayBuffer()));
    assert.equal(names.length, files.length);
    const lower = names.map((n) => n.toLowerCase());
    assert.equal(new Set(lower).size, names.length, 'duplicate names ' + JSON.stringify(names) + where());
    for (const n of names) assert.ok(!unsafeName(n), 'unsafe entry name ' + JSON.stringify(n) + ' from ' + JSON.stringify(files.map((f) => f.path)) + where());
  }
});

test('sanitizePath and urlToPath keep every saved path inside the folder' + where(), () => {
  const r = gen.rng(SEED + 7);
  const used = new Map();
  for (let i = 0; i < ROUNDS / 2; i++) {
    const p = Site.sanitizePath(gen.hostileName(r));
    assert.ok(!unsafeName(p), JSON.stringify(p) + where());
    let url;
    try {
      url = new URL('https://' + r.pick(['a.example', 'B.example:8443', '127.0.0.1']) + '/' + gen.hostileName(r).replace(/[#?]/g, '') + '?q=' + r.int(5)).href;
    } catch (_) {
      continue;
    }
    const saved = Site.urlToPath(url, used);
    assert.ok(!unsafeName(saved) && saved.startsWith('site/'), JSON.stringify(saved) + ' from ' + url + where());
  }
});

test('a hostile ZIP name still produces an archive the system unzip accepts', async () => {
  let ok = true;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch (_) {
    ok = false;
  }
  if (!ok) return; // unzip is not installed here; the entry-name test above still ran
  const r = gen.rng(SEED + 8);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-fuzz-'));
  try {
    for (let i = 0; i < 20; i++) {
      const files = Array.from({ length: 6 }, () => ({ path: gen.hostileName(r), data: 'data ' + r.int(1000) }));
      const f = path.join(dir, 'z' + i + '.zip');
      fs.writeFileSync(f, Buffer.from(await Zip.build(files).arrayBuffer()));
      execFileSync('unzip', ['-tq', f]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- secret and signature detectors ---------- */

const NOISE = ['token', 'secret', 'password', 'api_key', 'apikey', '=', ':', '"', "'", ' ', '\n', 'AKIA', 'sk_live_', 'eyJ', '-----BEGIN ', 'ghp_', 'xox', 'SG.', 'AIza', '.', '_', '-', 'a', 'Z', '9'];
const noise = (r, n) => Array.from({ length: n }, () => r.pick(NOISE)).join('');

test('secret detectors return only masked values, whatever surrounds them' + where(), () => {
  const r = gen.rng(SEED + 9);
  const secrets = [
    'AKIA' + 'IOSFODNN7EXAMPLE',
    'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
    'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
    'xoxb-' + '123456789012-abcdefghijkl',
    'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q',
  ];
  for (let i = 0; i < ROUNDS / 3; i++) {
    const s = r.pick(secrets);
    const text = noise(r, 30) + ' ' + s + ' ' + noise(r, 30);
    const hits = Probe.scanSecrets(text, 'x.js');
    assert.ok(JSON.stringify(hits).indexOf(s) === -1, 'a value reached the result' + where());
    for (const h of Probe.scanSecretSpans(text)) assert.ok(h.start >= 0 && h.end <= text.length && h.end > h.start, where());
  }
});

test('detectors stay fast on hostile text (time budget)', () => {
  const r = gen.rng(SEED + 10);
  const inputs = [
    'api_key' + ' '.repeat(100000),
    ('token=' + 'a'.repeat(50)).repeat(5000),
    "password: '" + 'x'.repeat(200000),
    ('secret"' + ' '.repeat(3)).repeat(30000),
    '-----BEGIN '.repeat(20000),
    'eyJ' + 'a'.repeat(100000),
    noise(r, 200000),
  ];
  for (const text of inputs) {
    within(2500, 'scanSecrets', () => Probe.scanSecrets(text, 'x'));
    within(2500, 'scanSecretSpans', () => Probe.scanSecretSpans(text));
    within(1500, 'findErrorLeaks', () => Probe.findErrorLeaks(text));
    within(1500, 'parseRobots', () => Probe.parseRobots(text));
  }
});

test('regression: an app that answers every path with a changing HTML shell triggers no probe' + where(), () => {
  const r = gen.rng(SEED + 11);
  const words = ['Dashboard', 'Sign in', 'Admin', 'Loading', 'Debug console', 'Index', 'Stack overview', 'Error budget', 'Log in', 'Welcome', 'Docs', 'API reference', 'Status'];
  for (let i = 0; i < 300; i++) {
    const shell =
      '<!doctype html><html><head><title>' + r.pick(words) + '</title><link rel="stylesheet" href="/a' + r.int(99) + '.css"></head><body><div id="root">' +
      Array.from({ length: r.int(6) }, () => r.pick(words)).join(' ') + '</div><script src="/main.' + r.int(9999) + '.js"></script></body></html>';
    const res = { status: 200, type: 'text/html', text: shell };
    const base = Probe.baselineOf({ ...res, text: shell.replace(/\d+/g, '') });
    for (const p of Probe.PROBES) assert.equal(Probe.runProbe(p, res, { baseline: base }), null, p.id + ' fired on ' + shell + where());
  }
});
