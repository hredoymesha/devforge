const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/secprobe.js');

const probe = (id) => P.PROBES.find((p) => p.id === id);
const res = (text, over = {}) => ({ status: 200, type: 'text/plain', text, ...over });
const SPA = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';

test('catalog is well formed: unique ids, safe paths, complete wording', () => {
  const ids = new Set();
  for (const p of P.PROBES) {
    assert.ok(!ids.has(p.id), 'duplicate id ' + p.id);
    ids.add(p.id);
    assert.ok(P.isSafeProbePath(p.path), p.path);
    for (const k of ['title', 'why', 'impact', 'fix', 'verify', 'severity', 'category', 'theme']) assert.ok(p[k], p.id + ' missing ' + k);
    assert.ok(['standard', 'advanced'].includes(p.tier), p.id);
    assert.equal(typeof p.test, 'function');
  }
  assert.ok(P.probesFor('standard').length >= 15);
  assert.ok(P.probesFor('advanced').length > P.probesFor('standard').length);
  assert.ok(P.probesFor('standard').every((p) => p.tier === 'standard'));
});

test('probe paths: only plain absolute paths on the origin', () => {
  for (const bad of ['/a/../b', '//evil.example/x', 'http://evil.example/', '/a?x=1', '/a#b', 'a', '/' + 'a'.repeat(300), '/a b', '/a\n']) {
    assert.equal(P.isSafeProbePath(bad), false, JSON.stringify(bad));
  }
  for (const good of ['/.git/HEAD', '/.env', '/wp-login.php', '/storage/logs/laravel.log', '/a~']) assert.equal(P.isSafeProbePath(good), true, good);
});

test('signature probes fire on real content', () => {
  assert.match(P.runProbe(probe('git-head'), res('ref: refs/heads/main\n')), /Git HEAD/);
  assert.match(P.runProbe(probe('git-config'), res('[core]\n\trepositoryformatversion = 0\n')), /\[core\]/);
  assert.match(P.runProbe(probe('phpinfo'), res('<title>phpinfo()</title>')), /PHP/);
  assert.match(P.runProbe(probe('server-status'), res('<h1>Apache Server Status for x</h1>')), /server status/);
  assert.match(P.runProbe(probe('actuator-env'), res('{"propertySources":[]}')), /propertySources/);
  assert.match(P.runProbe(probe('dir-uploads'), res('<html><title>Index of /uploads</title>')), /listing/);
  assert.match(P.runProbe(probe('zip-backup'), res('PK\u0003\u0004rest')), /ZIP/);
  assert.match(P.runProbe(probe('sql-dump'), res('-- dump\nCREATE TABLE users (id int);')), /SQL/);
  assert.match(P.runProbe(probe('wp-login'), res('<input id="user_login">')), /WordPress/);
});

test('regression: a single-page app that answers every path with its HTML shell triggers nothing', () => {
  const shell = res(SPA, { type: 'text/html' });
  for (const p of P.PROBES) assert.equal(P.runProbe(p, shell, { baseline: P.baselineOf(shell) }), null, p.id);
});

test('non-200 answers and redirects never count', () => {
  assert.equal(P.runProbe(probe('git-head'), res('ref: refs/heads/main', { status: 403 })), null);
  assert.equal(P.runProbe(probe('git-head'), res('ref: refs/heads/main', { redirected: true })), null);
  assert.equal(P.runProbe(probe('git-head'), null), null);
});

test('.env evidence lists variable names but never values', () => {
  const secret = 'sUp3rS3cretValue123';
  const out = P.runProbe(probe('env-file'), res(`APP_NAME=demo\nDB_PASSWORD=${secret}\nAPI_KEY=abcdef0123456789\n`));
  assert.match(out, /3 variable name/);
  assert.match(out, /DB_PASSWORD/);
  assert.doesNotMatch(out, new RegExp(secret));
  assert.doesNotMatch(out, /abcdef0123456789/);
  assert.equal(P.runProbe(probe('env-file'), res(SPA)), null);
});

test('a generic admin login page is ignored when it matches the catch-all baseline', () => {
  const page = res('<form><input type="password"></form>', { type: 'text/html' });
  assert.ok(P.runProbe(probe('admin-login'), page, { baseline: { status: 404, sig: null } }));
  assert.equal(P.runProbe(probe('admin-login'), page, { baseline: P.baselineOf(page) }), null);
});

test('fingerprint ignores digits and whitespace', () => {
  assert.equal(P.fingerprint('<p>Visitors: 12345</p>\n'), P.fingerprint('<p> Visitors:   99 </p>'));
  assert.notEqual(P.fingerprint('<p>a</p>'), P.fingerprint('<p>b</p>'));
});

test('secrets are found by type and returned masked', () => {
  const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const stripe = 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
  const text = `var a="${aws}"; var s='${stripe}'; -----BEGIN RSA PRIVATE KEY-----`;
  const hits = P.scanSecrets(text, '/app.js');
  assert.deepEqual(hits.map((h) => h.type).sort(), ['aws-access-key', 'private-key-block', 'stripe-secret']);
  const json = JSON.stringify(hits);
  assert.doesNotMatch(json, new RegExp(aws));
  assert.doesNotMatch(json, new RegExp(stripe));
  assert.ok(hits.every((h) => h.where === '/app.js' && /…\(\d+ chars\)/.test(h.masked)));
});

test('generic secret rule skips placeholders and low-entropy values', () => {
  assert.equal(P.scanSecrets('var apiKey = "xxxxxxxxxxxxxxxxxxxx";', 'a').length, 0);
  assert.equal(P.scanSecrets('var apiKey = "YOUR_API_KEY_GOES_HERE_1234";', 'a').length, 0);
  assert.equal(P.scanSecrets('token = "aaaaaaaaaaaaaaaaaaaaaaaa"', 'a').length, 0);
  const real = P.scanSecrets('const clientSecret = "Zk3pQ8vLx2NwR7sT9uYb";', 'a');
  assert.equal(real.length, 1);
  assert.equal(real[0].type, 'generic-secret');
  assert.equal(real[0].confidence, 'low');
  assert.equal(real[0].name, 'clientSecret');
});

test('JWTs: claims decide the severity and values are never returned', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const make = (claims) => `${b64({ alg: 'HS256' })}.${b64(claims)}.c2lnbmF0dXJlMTIzNDU2`;
  const anon = P.scanSecrets('x="' + make({ role: 'anon' }) + '"', 'a')[0];
  assert.equal(anon.severity, 'medium');
  const admin = P.scanSecrets('x="' + make({ role: 'service_role' }) + '"', 'a')[0];
  assert.equal(admin.severity, 'high');
  const expired = P.scanSecrets('x="' + make({ exp: 1000 }) + '"', 'a')[0];
  assert.equal(expired.severity, 'low');
  assert.doesNotMatch(JSON.stringify(admin), /service_role"\s*:/);
});

test('libraries: versions from file names are matched against offline advisories', () => {
  const libs = P.detectLibraries([
    'https://code.jquery.com/jquery-1.12.4.min.js?x=1',
    'https://cdn.example/bootstrap@3.3.7/dist/js/bootstrap.min.js',
    'https://cdn.example/jquery-3.7.1.min.js',
    'https://cdn.example/lodash@4.17.21/lodash.min.js',
    'https://cdn.example/angular.js/1.8.2/angular.min.js',
  ]);
  const names = libs.map((l) => l.name + ' ' + l.version).sort();
  assert.deepEqual(names, ['AngularJS 1.8.2', 'Bootstrap 3.3.7', 'jQuery 1.12.4']);
  assert.ok(libs.find((l) => l.name === 'jQuery').advisories.some((a) => /CVE-2020-11022/.test(a)));
  assert.ok(!JSON.stringify(libs).includes('x=1'));
});

test('risky hosts: polyfill.io only', () => {
  const hits = P.riskyHosts(['https://cdn.polyfill.io/v3/polyfill.min.js', 'https://cdnjs.cloudflare.com/polyfill/v3/polyfill.min.js', 'not a url']);
  assert.deepEqual(hits.map((h) => h.host), ['cdn.polyfill.io']);
});

test('error leak detectors', () => {
  assert.deepEqual(P.findErrorLeaks('Traceback (most recent call last):\n File "x"').map((e) => e.id), ['python-traceback']);
  assert.ok(P.findErrorLeaks('Warning: foo() in /var/www/a.php on line 12').some((e) => e.id === 'php-error'));
  assert.ok(P.findErrorLeaks('You have an error in your SQL syntax near').some((e) => e.id === 'sql-error'));
  assert.deepEqual(P.findErrorLeaks('<h1>Not found</h1><p>Sorry.</p>'), []);
});

test('robots.txt parsing flags only interesting paths', () => {
  const r = P.parseRobots('User-agent: *\nDisallow: /admin/\nDisallow: /search\nDisallow: /backup-2020/\nSitemap: https://a.example/s.xml');
  assert.deepEqual(r.interesting, ['/admin/', '/backup-2020/']);
  assert.equal(r.disallow.length, 3);
  assert.deepEqual(r.sitemaps, ['https://a.example/s.xml']);
});

test('source map reference and directory listing helpers', () => {
  assert.equal(P.sourceMapRef('var a=1;\n//# sourceMappingURL=app.js.map'), 'app.js.map');
  assert.equal(P.sourceMapRef('var a=1;'), null);
  assert.equal(P.directoryListing('<title>Index of /x</title>'), true);
  assert.equal(P.directoryListing('<title>Home</title>'), false);
});

test('regression: hostile repetitive scripts cannot make secret scanning slow (was quadratic)', () => {
  const MB = 1536 * 1024; // the per-script cap used by the scanner
  const cases = {
    token: 'token'.repeat(MB / 5),
    secret_: 'secret_'.repeat(MB / 7),
    'a.token-': 'a.token-'.repeat(MB / 8),
    'api_key = ': 'api_key = '.repeat(MB / 10),
    'long value': 'secret="' + 'A1b2'.repeat(MB / 4),
    'one long word': 'a'.repeat(MB),
  };
  for (const [label, text] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    P.scanSecrets(text, 'x');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${label.trim()}: ${Math.round(ms)} ms for ${text.length} chars`);
  }
});

test('regression: error-output detectors are linear on hostile text (the Node stack pattern was quadratic)', () => {
  const text = '\n   at a.b (/'.repeat(Math.ceil((200 * 1024) / 12));
  const t0 = process.hrtime.bigint();
  P.findErrorLeaks(text);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 500);
  assert.ok(P.findErrorLeaks('Error: x\n    at Object.run (/srv/app/index.js:10:5)\n').some((e) => e.id === 'node-stack'), 'real stack traces are still detected');
});

test('the bounded generic rule still finds ordinary assignments', () => {
  const hits = P.scanSecrets('const clientSecret = "Zk3pQ8vLx2NwR7sT9uYb"; var api_key: "Qw8Er7Ty6Ui5Op4As3Df"', 'a');
  assert.deepEqual(hits.map((h) => h.name).sort(), ['api_key', 'clientSecret']);
});
