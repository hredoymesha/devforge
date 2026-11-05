const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/exportguard.js');
const Probe = require('../lib/secprobe.js');

// Fake credentials are built at run time so no literal key sits in the repository.
const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
const stripe = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const github = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: '1234567890', name: 'Test User' }) + '.' + 'c2lnbmF0dXJlLXZhbHVlLWZvci10ZXN0';
const generic = 'Zq8dLm3Pw9TxV2nR7sYb4KcHe6';
const pem = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefakefake\nabcdefghijklmnop\n-----END RSA ' + 'PRIVATE KEY-----';
const secrets = [aws, stripe, github, jwt, generic, 'MIIEowIBAAKCAQEAfakefakefakefake'];

const file = (path, data) => ({ path, data });
const sample = [
  'const a = 1;',
  'const awsId = "' + aws + '";',
  "var s = '" + stripe + "';",
  'fetch(url, { headers: { x: "' + github + '" } });',
  'const t = "' + jwt + '";',
  '{"api_key": "' + generic + '"}',
  pem,
].join('\n');

test('finds each kind of credential with its file and line, and carries no value', () => {
  const r = G.scan([file('js/app.js', sample)]);
  const by = Object.fromEntries(r.findings.map((f) => [f.type, f]));
  assert.equal(by['aws-access-key'].line, 2);
  assert.equal(by['stripe-secret'].line, 3);
  assert.equal(by['github-token'].line, 4);
  assert.equal(by.jwt.line, 5);
  assert.equal(by['generic-secret'].line, 6);
  assert.equal(by['private-key-block'].line, 7);
  assert.equal(by['aws-access-key'].column, 16);
  assert.ok(r.findings.every((f) => f.file === 'js/app.js'));
  const dump = JSON.stringify(r) + G.reportMarkdown(r, 'mask');
  for (const s of secrets) assert.ok(!dump.includes(s), 'a value reached the report');
});

test('harmless text, placeholders and ordinary words are not flagged', () => {
  const text = [
    'The token ring was invented in the 1970s. Enter your password below.',
    'const apiKey = "YOUR_API_KEY_HERE_xxxxxxxx";',
    'password: "changeme-changeme-changeme"',
    'const token = process.env.API_TOKEN;',
    'secret: "aaaaaaaaaaaaaaaaaaaaaaaa"',
    '<input type="password" name="password" placeholder="Password">',
    'id="' + 'a'.repeat(40) + '"',
  ].join('\n');
  assert.deepEqual(G.scan([file('index.html', text)]).findings, []);
});

test('a single-page app shell that every path returns raises nothing', () => {
  const shell = '<!doctype html><html><head><script src="/app.4f2a.js"></script><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div></body></html>';
  const files = Array.from({ length: 60 }, (_, i) => file('site/host/path' + i + '/index.html', shell));
  assert.deepEqual(G.scan(files).findings, []);
});

test('mask replaces every value, keeps the rest of the text and the line numbers', () => {
  const out = G.apply([file('js/app.js', sample)], 'mask');
  const masked = out.files.find((f) => f.path === 'js/app.js').data;
  for (const s of secrets) assert.ok(!masked.includes(s), 'secret still present');
  assert.match(masked, /\[REDACTED:aws-access-key\]/);
  assert.match(masked, /^const a = 1;\nconst awsId = "\[REDACTED:aws-access-key\]";/);
  assert.equal(masked.split('\n').length - 1, sample.split('\n').length - 1 - 3); // the key body lines collapse into one marker
  assert.deepEqual(G.scan([file('x', masked)]).findings, [], 'masked output is clean');
  assert.equal(out.masked, 6);
});

test('a private key is masked from its first line to its last, not only the header', () => {
  const masked = G.maskText('before\n' + pem + '\nafter').text;
  assert.equal(masked, 'before\n[REDACTED:private-key-block]\nafter');
});

test('a private key with no end line is masked for a bounded stretch only', () => {
  const text = '-----BEGIN ' + 'PRIVATE KEY-----\n' + 'A'.repeat(50000);
  const masked = G.maskText(text).text;
  assert.ok(masked.length > 40000, 'the rest of the file is kept');
  assert.ok(masked.startsWith('[REDACTED:private-key-block]'));
});

test('keep leaves the files alone and adds a report; omit drops only the files with findings', () => {
  const files = [file('a.js', 'var k = "' + stripe + '";'), file('b.js', 'var x = 1;')];
  const keep = G.apply(files, 'keep');
  assert.equal(keep.files[0].data, files[0].data);
  assert.ok(keep.files.some((f) => f.path === G.REPORT_PATH));
  const omit = G.apply(files, 'omit');
  assert.deepEqual(omit.files.map((f) => f.path), ['b.js', G.REPORT_PATH]);
  assert.deepEqual(omit.omitted, ['a.js']);
  for (const o of [keep, omit]) assert.ok(!o.files.find((f) => f.path === G.REPORT_PATH).data.includes(stripe));
});

test('nothing found: files come back untouched and no report is added', () => {
  const files = [file('a.js', 'var x = 1;')];
  const out = G.apply(files, 'mask');
  assert.equal(out.files, files);
  assert.equal(out.findings.length, 0);
});

test('binary files are skipped; text bytes are masked and stay bytes', () => {
  const enc = new TextEncoder();
  const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]);
  const text = enc.encode('k = "' + stripe + '"');
  const png = file('img/logo.png', enc.encode('k = "' + stripe + '"'));
  const withNul = file('data.bin', new Uint8Array([...enc.encode('k = "' + stripe + '"'), 0]));
  const r = G.scan([file('a.bin', bin), png, withNul, file('t.js', text)]);
  assert.equal(r.scanned, 1);
  assert.equal(r.skipped, 3);
  assert.deepEqual(r.findings.map((f) => f.file), ['t.js']);
  const out = G.apply([file('t.js', text)], 'mask').files[0];
  assert.ok(out.data instanceof Uint8Array);
  assert.ok(!new TextDecoder().decode(out.data).includes(stripe));
});

test('a value on a window edge of a very large file is found once', () => {
  const pad = 'x'.repeat(1000000 - 4096 - 10);
  const text = pad + '"' + aws + '"' + 'y'.repeat(300000);
  const r = G.scan([file('big.js', text)]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].type, 'aws-access-key');
  assert.ok(!G.maskText(text).text.includes(aws));
});

test('hostile text does not make the scan slow', () => {
  const evil = ['token=', 'api_key: ', "password = '", 'secret"'].join('').repeat(20000) + 'a'.repeat(300000);
  const t = Date.now();
  G.scan([file('evil.js', evil)]);
  assert.ok(Date.now() - t < 5000, 'took ' + (Date.now() - t) + ' ms');
});

test('span offsets point at exactly the value that scanSecrets reports', () => {
  const text = 'a ' + stripe + ' b ' + github;
  for (const s of Probe.scanSecretSpans(text)) {
    const masked = Probe.scanSecrets(text.slice(s.start, s.end), 'x');
    assert.ok(masked.length >= 1, s.type + ' span is a real match');
  }
});

test('line and column are right across Windows line breaks and long lines', () => {
  const text = 'one\r\ntwo\r\n' + 'z'.repeat(5000) + ' "' + aws + '"';
  const f = G.scan([file('w.js', text)]).findings[0];
  assert.equal(f.line, 3);
  assert.equal(f.column, 5003);
});

test('checkText works on a prompt and masks it', () => {
  const prompt = 'Why does this fail?\nconst k = "' + stripe + '";';
  assert.equal(G.checkText(prompt, 'prompt').findings.length, 1);
  assert.ok(!G.maskText(prompt).text.includes(stripe));
});
