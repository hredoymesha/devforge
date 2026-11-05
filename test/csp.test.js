const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../lib/csp.js');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64');
const FACTS = () => ({
  origin: 'https://app.example',
  loaded: {
    script: ['https://app.example', 'https://cdn.example', 'https://stats.example:8443'],
    style: ['https://cdn.example'],
    img: ['https://app.example', 'data:', 'https://img.example'],
    font: ['https://fonts.example'],
    connect: ['https://api.example'],
    media: [],
    frame: [],
  },
  inline: { scripts: [sha256('var a=1;'), sha256('var a=1;'), sha256('var b=2;')], styles: [sha256('a{b:c}')], handlers: 0, styleAttributes: 0 },
  forms: ['https://pay.example', 'https://app.example'],
});

test('the policy lists each origin once, uses self for the page, and hashes inline code', () => {
  const r = C.build(FACTS());
  assert.match(r.header, /^Content-Security-Policy-Report-Only: default-src 'self'; /);
  const row = (n) => r.rows.find((x) => x.name === n);
  assert.deepEqual(row('script-src').values.slice(0, 3), ["'self'", 'https://cdn.example', 'https://stats.example:8443']);
  assert.equal(row('script-src').values.filter((v) => v.startsWith("'sha256-")).length, 2, 'duplicate inline hashes are listed once');
  assert.ok(row('script-src').values.includes("'sha256-" + sha256('var b=2;') + "'"));
  assert.deepEqual(row('style-src').values, ["'self'", 'https://cdn.example', "'sha256-" + sha256('a{b:c}') + "'"]);
  assert.deepEqual(row('img-src').values, ["'self'", 'data:', 'https://img.example']);
  assert.deepEqual(row('font-src').values, ["'self'", 'https://fonts.example']);
  assert.deepEqual(row('connect-src').values, ["'self'", 'https://api.example']);
  assert.deepEqual(row('form-action').values, ["'self'", 'https://pay.example']);
  assert.deepEqual(row('object-src').values, ["'none'"]);
  assert.deepEqual(row('base-uri').values, ["'self'"]);
});

test('kinds that were not seen are left to default-src; the policy says it is generated and inferred', () => {
  const r = C.build(FACTS());
  assert.equal(r.rows.find((x) => x.name === 'media-src'), undefined);
  assert.equal(r.rows.find((x) => x.name === 'frame-src'), undefined);
  assert.match(r.provenance, /generated.*inferred/);
  assert.ok(r.notes.some((n) => /Report-Only policy blocks nothing/.test(n)));
  assert.ok(r.notes.some((n) => /WebSocket/.test(n)));
  assert.ok(r.notes.some((n) => /Resources that load later/.test(n)));
});

test('inline handlers and style attributes are reported honestly instead of being allowed silently', () => {
  const f = FACTS();
  f.inline.handlers = 3;
  f.inline.styleAttributes = 1;
  const r = C.build(f);
  assert.ok(r.notes.some((n) => /3 inline event handler attributes/.test(n)));
  assert.deepEqual(r.rows.find((x) => x.name === 'style-src-attr').values, ["'unsafe-inline'"]);
  assert.equal(r.rows.find((x) => x.name === 'script-src').values.includes("'unsafe-inline'"), false);
});

test('mixed content is called out', () => {
  const f = FACTS();
  f.loaded.img.push('http://old.example');
  assert.ok(C.build(f).notes.some((n) => /mixed content/.test(n)));
});

test('nothing from the page can add a directive or break out of the policy text', () => {
  const f = FACTS();
  f.loaded.script.push("https://x.example; script-src *", "https://a b.example", "javascript:alert(1)", "https://x.example'", "'unsafe-eval'", 'https://ok.example');
  f.inline.scripts.push("abc'; script-src *", 'not a hash', 5);
  f.forms.push('https://f.example, evil');
  const r = C.build(f);
  assert.ok(!/unsafe-eval|javascript:|script-src \*|a b\.example|evil/.test(r.policy), r.policy);
  assert.ok(r.policy.includes('https://ok.example'));
  assert.equal(r.policy.split('script-src').length, 2, 'one script-src only');
  assert.ok(!/[\r\n]/.test(r.header));
});

test('the policy never carries the text of inline code, only hashes', () => {
  const secret = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const f = FACTS();
  f.inline.scripts = [sha256('var key = "' + secret + '";')];
  assert.ok(!C.build(f).header.includes(secret));
});

test('originOf keeps only web origins', () => {
  assert.equal(C.originOf('https://a.example/x?y#z'), 'https://a.example');
  assert.equal(C.originOf('/p', 'https://b.example/'), 'https://b.example');
  assert.equal(C.originOf('wss://s.example/socket'), 'wss://s.example');
  assert.equal(C.originOf('javascript:alert(1)'), null);
  assert.equal(C.originOf('data:text/html,x'), null);
  assert.equal(C.originOf('::'), null);
});

/* ---------- Subresource Integrity ---------- */

test('integrityValue matches the SHA-384 that Node computes for the same bytes', () => {
  for (const s of ['', 'a', 'console.log(1);\n', 'x'.repeat(100000), '日本語']) {
    const bytes = Buffer.from(s);
    const digest = new Uint8Array(crypto.createHash('sha384').update(bytes).digest());
    assert.equal(C.integrityValue(digest), 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64'));
  }
});

test('compare: matches, differs, another algorithm, none, and several values', () => {
  const v = 'sha384-AAAA';
  assert.equal(C.compare('', v), 'none');
  assert.equal(C.compare(undefined, v), 'none');
  assert.equal(C.compare('sha384-AAAA', v), 'matches');
  assert.equal(C.compare('sha384-BBBB', v), 'differs');
  assert.equal(C.compare('sha512-ZZZZ', v), 'other-algorithm');
  assert.equal(C.compare('sha256-X sha384-AAAA', v), 'matches');
  assert.equal(C.compare('sha384-AAAA?ext', v), 'matches');
});

test('tag(): script and stylesheet tags carry integrity and crossorigin, and escape the address', () => {
  assert.equal(C.tag({ tag: 'script', url: 'https://cdn.example/a.js', attrs: { type: 'module', async: true, defer: false } }, 'sha384-AAA'), '<script src="https://cdn.example/a.js" integrity="sha384-AAA" crossorigin="anonymous" type="module" async></script>');
  assert.equal(C.tag({ tag: 'link', url: 'https://cdn.example/a.css?v=1&b=2', attrs: { media: 'print' } }, 'sha384-AAA'), '<link rel="stylesheet" href="https://cdn.example/a.css?v=1&amp;b=2" integrity="sha384-AAA" crossorigin="anonymous" media="print">');
  const evil = C.tag({ tag: 'script', url: 'https://x.example/"><script>alert(1)</script>', attrs: { type: '"><img src=x onerror=1>' } }, 'sha384-A"B');
  assert.ok(!/<script>alert|<img/.test(evil), evil);
  assert.equal(evil.split('<script').length, 2);
});
