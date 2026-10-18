const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/secscan.js');

const ids = (list) => list.map((f) => f.id);
const emptyFacts = (over = {}) => ({
  protocol: 'https:',
  origin: 'https://example.com',
  forms: [],
  scripts: [],
  iframes: [],
  mixed: [],
  inlineHandlers: 0,
  javascriptUrls: 0,
  sinks: [],
  cspMeta: false,
  cookies: [],
  localKeys: [],
  sessionKeys: [],
  links: [],
  reflected: [],
  suspiciousComments: [],
  ...over,
});

test('classifyTarget separates local, public and unsupported pages', () => {
  assert.equal(S.classifyTarget('http://localhost:3000/').kind, 'local');
  assert.equal(S.classifyTarget('http://192.168.1.20/app').kind, 'local');
  assert.equal(S.classifyTarget('https://shop.test/').kind, 'local');
  assert.equal(S.classifyTarget('https://example.com/').kind, 'public');
  assert.equal(S.classifyTarget('https://8.8.8.8/').kind, 'public');
  assert.equal(S.classifyTarget('chrome://extensions').kind, 'unsupported');
  assert.equal(S.classifyTarget('file:///tmp/a.html').kind, 'unsupported');
  assert.equal(S.classifyTarget('nonsense').kind, 'unsupported');
  assert.equal(S.classifyTarget('https://example.com/a?b=1').origin, 'https://example.com');
});

test('every finding has the full evidence-based shape', () => {
  const all = [
    ...S.analyzeHeaders({}, { https: true }),
    ...S.analyzeFacts(
      emptyFacts({
        protocol: 'http:',
        forms: [{ hasPassword: true, method: 'get', action: 'http://a/x', insecureAction: true, crossOrigin: true, hasFile: true }],
        sinks: ['innerHTML'],
        scripts: [{ src: 'https://c/a.js', host: 'c', thirdParty: true, integrity: false }],
        links: [{ path: '/u/42', idPath: true, params: [{ n: 'token', k: 'text' }, { n: 'next', k: 'url' }] }],
        reflected: [{ name: 'q', context: 'attribute' }],
      })
    ),
    ...S.analyzeCookies([{ name: 'sid', secure: false, httpOnly: false, sameSite: 'no_restriction', session: false, days: 90, hostOnly: false }], { https: true, exact: true }),
    ...S.analyzeSecurityTxt({ found: false, status: 404 }),
  ];
  assert.ok(all.length > 15);
  for (const f of all) {
    for (const k of ['id', 'title', 'evidence', 'why', 'impact', 'verify', 'fix', 'owasp', 'category', 'theme']) assert.ok(f[k], f.id + ' missing ' + k);
    assert.ok(S.SEVERITIES.includes(f.severity), f.id);
    assert.ok(S.STATUSES.includes(f.status), f.id);
    assert.ok(['high', 'medium', 'low'].includes(f.confidence), f.id);
    assert.match(f.category, /^A\d\d:2021/, f.id);
    if (f.status === 'info') assert.equal(f.severity, 'info', f.id);
  }
});

test('a well-configured response produces no header findings', () => {
  const found = S.analyzeHeaders(
    {
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=()',
    },
    { https: true }
  );
  assert.deepEqual(ids(found), []);
});

test('missing headers are confirmed observations, with severity, evidence and a fix', () => {
  const found = S.analyzeHeaders({}, { https: true, resource: 'https://example.com/' });
  assert.deepEqual(
    new Set(ids(found)),
    new Set(['csp-missing', 'hsts-missing', 'nosniff-missing', 'clickjacking', 'referrer-missing', 'permissions-policy-missing'])
  );
  assert.equal(found.find((f) => f.id === 'csp-missing').status, 'confirmed');
  assert.equal(found.find((f) => f.id === 'referrer-missing').status, 'info');
  assert.equal(found.find((f) => f.id === 'csp-missing').resource, 'https://example.com/');
});

test('HSTS is not expected on plain HTTP and frame-ancestors counts as clickjacking protection', () => {
  const found = ids(S.analyzeHeaders({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }, { https: false }));
  assert.ok(!found.includes('hsts-missing'));
  assert.ok(!found.includes('clickjacking'));
});

test('weak CSP settings are flagged and a nonce neutralises unsafe-inline', () => {
  const found = ids(S.analyzeCsp("script-src 'self' 'unsafe-inline' 'unsafe-eval' https:"));
  for (const id of ['csp-unsafe-inline', 'csp-unsafe-eval', 'csp-broad-source']) assert.ok(found.includes(id), id);
  assert.ok(!ids(S.analyzeCsp("script-src 'nonce-abc' 'unsafe-inline'; object-src 'none'; base-uri 'none'")).includes('csp-unsafe-inline'));
  assert.ok(ids(S.analyzeCsp("img-src 'self'")).includes('csp-no-script-src'));
});

test('report-only policy, short HSTS, version disclosure and CORS', () => {
  assert.ok(ids(S.analyzeHeaders({ 'content-security-policy-report-only': "default-src 'self'" }, { https: true })).includes('csp-report-only'));
  const found = ids(S.analyzeHeaders({ 'strict-transport-security': 'max-age=300', server: 'nginx/1.18.0' }, { https: true }));
  assert.ok(found.includes('hsts-short') && found.includes('version-disclosure-server'));
  assert.ok(!ids(S.analyzeHeaders({ server: 'nginx' }, { https: true })).includes('version-disclosure-server'));
  const cors = S.analyzeHeaders({ 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' }, { https: true }).find((f) => f.id === 'cors-wildcard-credentials');
  assert.equal(cors.status, 'potential');
  assert.match(cors.verify, /cannot set the Origin header/);
});

test('page facts: HTTP is high with a password form, info on localhost', () => {
  const form = { hasPassword: true, method: 'post', action: 'http://a/login', insecureAction: false, crossOrigin: false };
  assert.equal(S.analyzeFacts(emptyFacts({ protocol: 'http:', forms: [form] })).find((f) => f.id === 'no-https').severity, 'high');
  const local = S.analyzeFacts({ ...emptyFacts({ protocol: 'http:' }), isLocal: true }).find((f) => f.id === 'no-https');
  assert.equal(local.severity, 'info');
  assert.equal(local.status, 'info');
});

test('mixed content is split into active and passive and needs HTTPS', () => {
  const found = S.analyzeFacts(emptyFacts({ mixed: [{ type: 'script', url: 'http://cdn.example/a.js' }, { type: 'img', url: 'http://cdn.example/a.png' }] }));
  assert.equal(found.find((f) => f.id === 'mixed-active').severity, 'high');
  assert.equal(found.find((f) => f.id === 'mixed-passive').severity, 'low');
  assert.ok(!ids(S.analyzeFacts(emptyFacts({ protocol: 'http:', mixed: [] }))).includes('mixed-active'));
});

test('indicator findings are potential or manual and never claim confirmation', () => {
  const found = S.analyzeFacts(
    emptyFacts({
      sinks: ['innerHTML'],
      reflected: [{ name: 'q', context: 'script' }],
      links: [{ path: '/go', idPath: false, params: [{ n: 'next', k: 'url' }] }, { path: '/doc/77', idPath: true, params: [] }],
      forms: [{ method: 'post', action: '/save', hasCsrfToken: false, hasPassword: false }],
      suspiciousComments: ['password'],
    })
  );
  const byId = Object.fromEntries(found.map((f) => [f.id, f]));
  assert.equal(byId['dom-sinks'].status, 'potential');
  assert.equal(byId['param-reflection-q'].status, 'potential');
  assert.equal(byId['param-reflection-q'].severity, 'medium');
  assert.equal(byId['open-redirect-indicator'].status, 'manual');
  assert.equal(byId['idor-surface'].status, 'manual');
  assert.equal(byId['csrf-token-missing'].status, 'manual');
  assert.match(byId['idor-surface'].verify, /two accounts/);
  assert.match(byId['param-reflection-q'].evidence, /Values are not shown/);
  for (const f of ['dom-sinks', 'param-reflection-q', 'open-redirect-indicator', 'idor-surface', 'csrf-token-missing', 'html-comments'])
    assert.notEqual(byId[f].confidence, 'high', f);
});

test('URL values never appear in evidence', () => {
  const found = S.analyzeFacts(emptyFacts({ links: [{ path: '/cb', params: [{ n: 'access_token', k: 'text' }] }] }));
  const f = found.find((x) => x.id === 'sensitive-url-params');
  assert.ok(f);
  assert.match(f.evidence, /access_token/);
  assert.equal(f.status, 'confirmed');
});

test('cookies: script-readable heuristic vs exact flags, names only', () => {
  const list = [
    { name: 'PHPSESSID', secure: false, httpOnly: false, sameSite: 'no_restriction', session: false, days: 90, hostOnly: false },
    { name: 'theme', secure: null, httpOnly: false, sameSite: 'lax', session: true, hostOnly: true },
  ];
  const inexact = S.analyzeCookies(list, { https: true, exact: false });
  const readable = inexact.find((f) => f.id === 'cookie-script-readable');
  assert.equal(readable.status, 'potential');
  assert.match(readable.evidence, /PHPSESSID/);
  assert.doesNotMatch(readable.evidence, /theme/);
  assert.equal(inexact.find((f) => f.id === 'cookie-no-secure').severity, 'medium');

  const exact = S.analyzeCookies(list, { https: true, exact: true });
  assert.equal(exact.find((f) => f.id === 'cookie-httponly-missing').status, 'confirmed');
  assert.ok(!ids(exact).includes('cookie-script-readable'));
  for (const id of ['cookie-samesite-none', 'cookie-long-lived', 'cookie-broad-domain']) assert.ok(ids(exact).includes(id), id);
  assert.ok(exact.every((f) => !/\btheme\b/.test(f.evidence)));
});

test('cookie flags that are unknown are not guessed', () => {
  assert.deepEqual(ids(S.analyzeCookies([{ name: 'a', secure: null }], { https: true })), []);
});

test('storage keys: names only', () => {
  const f = S.analyzeStorage(emptyFacts({ localKeys: ['auth_token', 'theme'], sessionKeys: ['csrfToken'] }));
  assert.equal(f.length, 1);
  assert.match(f[0].evidence, /localStorage\.auth_token/);
  assert.doesNotMatch(f[0].evidence, /theme/);
  assert.deepEqual(S.analyzeStorage(emptyFacts({ localKeys: ['theme'] })), []);
});

test('third-party scripts and iframes', () => {
  const found = S.analyzeFacts(
    emptyFacts({
      scripts: [
        { src: 'https://cdn.example/a.js', host: 'cdn.example', thirdParty: true, integrity: false },
        { src: 'https://cdn.example/b.js', host: 'cdn.example', thirdParty: true, integrity: true },
        { src: 'https://site/own.js', host: 'site', thirdParty: false, integrity: false },
      ],
      iframes: [{ src: 'https://ads.example/x', thirdParty: true, sandbox: false }],
    })
  );
  assert.match(found.find((f) => f.id === 'sri-missing').evidence, /1 script/);
  assert.ok(ids(found).includes('iframe-sandbox'));
});

test('page and 404 error output is detected without quoting it', () => {
  const html = 'Traceback (most recent call last):\n  File "/srv/app.py", line 4';
  const page = S.analyzeFacts(emptyFacts({ html })).find((f) => f.id === 'error-output-page');
  assert.ok(page);
  assert.doesNotMatch(page.evidence, /srv\/app/);
  const base = S.analyzeBaseline({ status: 500, text: html }, '/nope');
  assert.deepEqual(ids(base), ['error-output-404']);
  assert.deepEqual(S.analyzeBaseline({ status: 404, text: '<h1>Not found</h1>' }, '/nope'), []);
});

test('traffic analysis: insecure requests, credentials, URL secrets, CORS, 5xx', () => {
  const entries = [
    { kind: 'fetch', method: 'POST', url: 'http://api.example.net/login?token=abc123', status: 200, reqHeaders: { authorization: 'Bearer xxxxxxxxxxxxxxxxxxxxxxxx' }, resHeaders: {} },
    { kind: 'fetch', method: 'GET', url: 'https://api.example.net/data.json', status: 500, resHeaders: { 'access-control-allow-origin': '*' } },
    { kind: 'fetch', method: 'GET', url: 'https://u:p@api.example.net/x', status: 200, resHeaders: {} },
    { kind: 'xhr', method: 'GET', url: 'https://cdn.example/other', status: 200, resHeaders: { 'access-control-allow-origin': 'https://example.com', 'access-control-allow-credentials': 'true' } },
  ];
  const found = S.analyzeTraffic(entries, { pageUrl: 'https://example.com/' });
  for (const id of ['traffic-insecure-requests', 'traffic-credentials-over-http', 'traffic-sensitive-url', 'traffic-cors-open', 'traffic-cors-credentials', 'traffic-server-errors', 'traffic-url-credentials'])
    assert.ok(ids(found).includes(id), id);
  const json = JSON.stringify(found);
  for (const secret of ['abc123', 'xxxxxxxxxxxxxxxxxxxxxxxx', 'u:p@']) assert.ok(!json.includes(secret), secret);
  assert.equal(found.find((f) => f.id === 'traffic-cors-credentials').status, 'manual');
  // Requests to private hosts or from an HTTP page are not "insecure requests from an HTTPS page".
  assert.deepEqual(ids(S.analyzeTraffic([{ method: 'GET', url: 'http://localhost:3000/a', status: 200 }], { pageUrl: 'https://example.com/' })), []);
  assert.deepEqual(ids(S.analyzeTraffic([{ method: 'GET', url: 'http://a.example/a', status: 200 }], { pageUrl: 'http://example.com/' })), []);
});

test('probe findings: confirmed exposure, fixed evidence, no content', () => {
  const secret = 'ZmFrZXNlY3JldHZhbHVl';
  const found = S.analyzeProbes(
    [
      { probe: 'env-file', path: '/.env', res: { status: 200, type: 'text/plain', text: `APP_KEY=${secret}\nDB_PASSWORD=hunter2hunter2\n` } },
      { probe: 'git-head', path: '/.git/HEAD', res: { status: 404, type: 'text/html', text: 'nope' } },
      { probe: 'dir-uploads', path: '/uploads/', res: { status: 200, type: 'text/html', text: '<title>Index of /uploads</title>' } },
      { probe: 'unknown', path: '/x', res: { status: 200, text: 'x' } },
    ],
    null
  );
  assert.deepEqual(ids(found).sort(), ['exposed-dir-uploads', 'exposed-env-file']);
  const env = found.find((f) => f.id === 'exposed-env-file');
  assert.equal(env.status, 'confirmed');
  assert.equal(env.severity, 'high');
  assert.equal(env.resource, '/.env');
  assert.ok(!JSON.stringify(found).includes(secret));
  assert.ok(!JSON.stringify(found).includes('hunter2'));
});

test('script analysis: masked secrets, source maps, libraries, risky hosts', () => {
  const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const found = S.analyzeScripts({
    urls: ['https://cdn.polyfill.io/v3/polyfill.min.js', 'https://code.jquery.com/jquery-1.12.4.min.js', 'https://site/app.js'],
    items: [{ url: 'https://site/app.js?v=1', text: `var k="${aws}";`, map: { url: 'https://site/app.js.map', status: 200, exposed: true } }],
    inline: [],
  });
  const byId = Object.fromEntries(found.map((f) => [f.id, f]));
  assert.equal(byId['secret-aws-access-key'].status, 'potential');
  assert.equal(byId['secret-aws-access-key'].severity, 'high');
  assert.ok(!JSON.stringify(found).includes(aws));
  assert.equal(byId['sourcemap-exposed'].status, 'confirmed');
  assert.ok(ids(found).some((i) => i.startsWith('vulnerable-library-jquery-')));
  assert.ok(ids(found).includes('risky-host-cdn-polyfill-io'));
  assert.ok(!JSON.stringify(found).includes('v=1'));
});

test('security.txt: missing, valid, incomplete and expired', () => {
  assert.deepEqual(ids(S.analyzeSecurityTxt({ found: false, status: 404 })), ['security-txt-missing']);
  assert.deepEqual(ids(S.analyzeSecurityTxt({ status: 'skipped' })), []);
  const future = new Date(Date.now() + 86400e3 * 200).toISOString();
  assert.deepEqual(ids(S.analyzeSecurityTxt({ found: true, text: `Contact: mailto:a@b.c\nExpires: ${future}\n` })), []);
  assert.deepEqual(ids(S.analyzeSecurityTxt({ found: true, text: `Expires: ${future}` })), ['security-txt-no-contact']);
  assert.deepEqual(ids(S.analyzeSecurityTxt({ found: true, text: 'Contact: mailto:a@b.c' })), ['security-txt-no-expires']);
  assert.deepEqual(ids(S.analyzeSecurityTxt({ found: true, text: 'Contact: mailto:a@b.c\nExpires: 2020-01-01T00:00:00Z' })), ['security-txt-expired']);
});

test('robots.txt: only interesting disallow lines are reported', () => {
  assert.deepEqual(S.analyzeRobots({ found: true, text: 'Disallow: /search' }), []);
  assert.deepEqual(ids(S.analyzeRobots({ found: true, text: 'Disallow: /admin/' })), ['robots-interesting']);
  assert.deepEqual(S.analyzeRobots({ found: false }), []);
});

test('scan budget clamps user options to the level and the hard limits', () => {
  assert.deepEqual(S.scanBudget('passive', { maxRequests: 500, delayMs: 0 }), { level: 'passive', maxRequests: 3, delayMs: 0 });
  assert.equal(S.scanBudget('standard', { maxRequests: 9999 }).maxRequests, S.HARD_MAX_REQUESTS);
  assert.equal(S.scanBudget('standard', { delayMs: 5 }).delayMs, S.HARD_MIN_DELAY_MS);
  assert.equal(S.scanBudget('advanced', {}).maxRequests, 150);
  assert.equal(S.scanBudget('bogus', {}).level, 'passive');
  assert.ok(S.scanBudget('standard', { maxRequests: 1 }).maxRequests >= 3);
});

test('reflection severity depends on where the value lands, and plain text is not reported', () => {
  const sev = (context) => S.analyzeFacts(emptyFacts({ reflected: [{ name: 'q', context }] })).find((f) => f.id === 'param-reflection-q').severity;
  assert.equal(sev('script'), 'medium');
  assert.equal(sev('attribute-active'), 'medium');
  assert.equal(sev('attribute'), 'low');
  assert.match(S.analyzeFacts(emptyFacts({ reflected: [{ name: 'q', context: 'attribute-active' }] }))[0].evidence, /event-handler or URL attribute/);
});

test('planScan lists what a scan would send, within the same budget the runner enforces', () => {
  const passive = S.planScan('passive');
  assert.equal(passive.maxTotal, 3);
  assert.ok(passive.steps.every((s) => ['page response headers', 'security.txt'].includes(s.purpose)));
  assert.deepEqual(passive.probes.paths, []);
  const std = S.planScan('standard', {}, { scripts: 4 });
  assert.ok(std.maxTotal <= 60 && std.minTotal >= 8);
  assert.equal(std.probes.total, 22, 'the standard probe list');
  assert.equal(std.probes.planned, std.probes.paths.length);
  assert.ok(std.probes.paths.every((p) => p.startsWith('/')));
  assert.equal(std.methods, 'GET and HEAD only');
  const adv = S.planScan('advanced', {}, { scripts: 40 });
  assert.ok(adv.maxTotal <= 150);
  assert.ok(adv.probes.total > std.probes.total);
  // a small budget cuts the probe list and says how many were left out
  const tiny = S.planScan('standard', { maxRequests: 12 }, { scripts: 4 });
  assert.ok(tiny.maxTotal <= 12 && tiny.probes.skippedForBudget > 0 && tiny.probes.planned + tiny.probes.skippedForBudget === tiny.probes.total);
  // the plan can never exceed what scanBudget allows
  assert.ok(S.planScan('advanced', { maxRequests: 99999 }, { scripts: 100 }).maxTotal <= S.HARD_MAX_REQUESTS);
});
