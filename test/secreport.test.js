const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/secreport.js');
const Scan = require('../lib/secscan.js');

const facts = (over = {}) => ({
  protocol: 'https:',
  origin: 'https://example.com',
  forms: [],
  scripts: [],
  iframes: [],
  mixed: [],
  inlineHandlers: 0,
  javascriptUrls: 0,
  sinks: [],
  cookies: [],
  localKeys: [],
  sessionKeys: [],
  links: [],
  reflected: [],
  suspiciousComments: [],
  ...over,
});
const hdr = (headers = {}) => ({ ok: true, status: 200, method: 'GET', headers });
const build = (over = {}) =>
  R.buildReport({
    url: 'https://example.com/shop?id=5',
    startedAt: '2026-10-10T12:00:00.000Z',
    finishedAt: '2026-10-10T12:00:05.000Z',
    level: 'standard',
    facts: facts(),
    headers: hdr(),
    securityTxt: { found: false, status: 404 },
    ...over,
  });
const ids = (r) => r.findings.map((f) => f.id);

test('report structure: counts, statuses, legend, coverage and limitations', () => {
  const r = build();
  assert.equal(r.version, 2);
  assert.equal(r.target, 'https://example.com/shop', 'query strings are dropped from the target');
  assert.equal(r.durationMs, 5000);
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.findings.length);
  assert.equal(Object.values(r.countsByStatus).reduce((a, b) => a + b, 0), r.findings.length);
  assert.ok(r.legend.confirmed && r.legend.potential && r.legend.manual);
  assert.ok(r.limitations.length >= 5);
  assert.ok(r.coverage.notTestable.length >= 8);
  assert.ok(!('score' in r) && !('grade' in r), 'no misleading score');
});

test('findings are sorted by severity, then status, then confidence, and de-duplicated', () => {
  const r = build({ facts: facts({ protocol: 'http:' }) });
  const sev = r.findings.map((f) => Scan.SEVERITIES.indexOf(f.severity));
  assert.deepEqual(sev, [...sev].sort((a, b) => a - b));
  assert.equal(new Set(r.findings.map((f) => f.id + '|' + f.resource)).size, r.findings.length);
  const dup = R.buildReport({
    url: 'https://example.com/',
    level: 'standard',
    facts: facts(),
    headers: hdr(),
    probes: [
      { probe: 'git-head', path: '/.git/HEAD', res: { status: 200, text: 'ref: refs/heads/main' } },
      { probe: 'git-head', path: '/.git/HEAD', res: { status: 200, text: 'ref: refs/heads/main' } },
    ],
  });
  assert.equal(dup.findings.filter((f) => f.id === 'exposed-git-head').length, 1);
});

test('attack path: injection hint + weak CSP + readable session is linked, labelled potential', () => {
  const r = build({
    facts: facts({ sinks: ['innerHTML'], cookies: [{ name: 'sessionid', secure: true }] }),
  });
  const path = r.attackPaths.find((p) => p.id === 'xss-session-takeover');
  assert.ok(path, ids(r).join());
  assert.equal(path.status, 'potential');
  assert.equal(path.confidence, 'low');
  assert.ok(path.conditions.length >= 2 && path.steps.length >= 3 && path.breaks.length >= 2);
  assert.ok(path.findingIds.includes('dom-sinks') && path.findingIds.includes('csp-missing') && path.findingIds.includes('cookie-script-readable'));
  assert.match(path.note, /potential/i);
  const sink = r.findings.find((f) => f.id === 'dom-sinks');
  assert.ok(sink.related.includes('csp-missing'));
  // the weaker variant is suppressed when the stronger one applies
  assert.ok(!r.attackPaths.some((p) => p.id === 'xss-unrestricted'));
});

test('attack paths need every part of their evidence', () => {
  assert.equal(build().attackPaths.length, 0);
  const onlySink = build({ facts: facts({ sinks: ['eval('] }), headers: hdr({ 'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'", 'x-content-type-options': 'nosniff' }) });
  assert.equal(onlySink.attackPaths.length, 0, 'a sink alone with a good CSP is not a path');
});

test('attack paths: transport, source-to-credentials, supply chain, clickjacking', () => {
  const r = R.buildReport({
    url: 'http://example.com/',
    level: 'standard',
    facts: facts({
      protocol: 'http:',
      forms: [{ method: 'post', hasPassword: true, action: 'http://example.com/login', insecureAction: false, hasCsrfToken: false }],
      scripts: [{ src: 'https://cdn.example.net/a.js', host: 'cdn.example.net', thirdParty: true, integrity: false }],
      cookies: [{ name: 'a', secure: false }],
    }),
    headers: hdr(),
    probes: [{ probe: 'git-head', path: '/.git/HEAD', res: { status: 200, text: 'ref: refs/heads/main' } }],
    scripts: { urls: [], items: [{ url: 'https://example.com/app.js', text: 'var k="AKIA' + 'IOSFODNN7EXAMPLE";' }], inline: [] },
  });
  const pathIds = r.attackPaths.map((p) => p.id);
  for (const id of ['source-to-credentials', 'supply-chain-takeover', 'clickjacking-action']) assert.ok(pathIds.includes(id), id + ' in ' + pathIds);
  assert.ok(r.attackPaths.every((p) => p.status === 'potential'));
});

test('severity of an attack path is its impact if conditions hold, never above its parts', () => {
  const r = build({ facts: facts({ sinks: ['innerHTML'], cookies: [{ name: 'token', secure: true }] }) });
  const path = r.attackPaths[0];
  const parts = r.findings.filter((f) => path.findingIds.includes(f.id));
  const order = ['info', 'low', 'medium', 'high'];
  assert.ok(order.indexOf(path.severity) <= Math.max(...parts.map((f) => order.indexOf(f.severity))) + 1);
});

test('remediation plan: priorities, grouping by theme, quick wins', () => {
  const r = build({ facts: facts({ protocol: 'http:', forms: [{ hasPassword: true, method: 'post', action: 'http://x/', insecureAction: true, hasCsrfToken: true }] }) });
  assert.deepEqual([...new Set(r.plan.items.map((i) => i.priority))], [...new Set(r.plan.items.map((i) => i.priority))].sort());
  assert.equal(r.plan.items[0].priority, 1, 'high severity comes first');
  const headers = r.plan.items.find((i) => i.theme === 'headers' && i.priority === 2);
  assert.ok(headers && headers.actions.length >= 1 && headers.examples.length >= 1);
  assert.ok(r.plan.quickWins.includes('nosniff-missing'));
  assert.ok(!r.plan.quickWins.some((id) => id === 'referrer-missing'), 'informational items are not quick wins');
  assert.ok(r.plan.items.every((i) => i.findingIds.length && ['quick', 'moderate', 'involved'].includes(i.effort)));
});

test('coverage: levels, skipped reasons and explicit results', () => {
  const passive = build({ level: 'passive' });
  const row = (r, id) => r.coverage.checks.find((c) => c.id === id);
  assert.equal(row(passive, 'probes').state, 'skipped');
  assert.match(row(passive, 'probes').reason, /passive level/);
  assert.equal(row(passive, 'cookie-flags').state, 'skipped');
  const done = build({ checks: { probes: { state: 'done', requests: 22 }, scripts: { state: 'failed', reason: 'timed out' }, traffic: { state: 'skipped', reason: 'Capture was off.' } } });
  assert.equal(row(done, 'probes').state, 'done');
  assert.equal(row(done, 'probes').requests, 22);
  assert.equal(row(done, 'scripts').state, 'failed');
  assert.equal(row(done, 'scripts').reason, 'timed out');
  assert.equal(row(done, 'traffic').reason, 'Capture was off.');
});

test('last-line redaction removes credential-shaped values anywhere in the report', () => {
  const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
  // Built from pieces so that no complete token-shaped literal sits in the repository.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoiYW5vbiJ9', 'c2lnbmF0dXJlMTIzNDU2'].join('.');
  const r = build({ requestLog: [{ method: 'GET', path: '/x', status: 200, purpose: 'a ' + aws }], facts: facts({ generator: 'WordPress 5.0 ' + jwt }) });
  const json = JSON.stringify(r);
  assert.ok(!json.includes(aws));
  assert.ok(!json.includes(jwt));
  assert.equal(R.scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'), 'Authorization: Bearer [redacted]');
  assert.equal(R.scrub('masked AKIA…(20 chars)'), 'masked AKIA…(20 chars)');
});

test('markdown report is complete and honest about what ran', () => {
  const r = build({
    facts: facts({ sinks: ['innerHTML'], cookies: [{ name: 'sessionid', secure: true }] }),
    requestLog: [{ method: 'GET', path: '/.well-known/security.txt', status: 404, purpose: 'security.txt' }],
    checks: { probes: { state: 'skipped', reason: 'Skipped by the user.' } },
  });
  const md = R.toMarkdown(r);
  for (const part of [
    '# Website security check',
    '## How to read the status',
    '## Remediation plan',
    '## Potential attack paths',
    '## Findings',
    '## Scan coverage',
    'Not testable from a browser extension',
    '## Requests made',
    '## Limitations',
    '**Severity:**',
    '**How to verify safely:**',
    'no overall score',
  ])
    assert.ok(md.includes(part), part);
  assert.match(md, /Skipped by the user\./);
  assert.match(md, /Potential, impact if the conditions hold/);
  assert.doesNotMatch(md, /is a confirmed vulnerability/i);
});

test('an empty scan does not claim the site is secure', () => {
  const r = R.buildReport({
    url: 'https://example.com/',
    level: 'passive',
    facts: facts(),
    headers: hdr({
      'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=()',
    }),
    securityTxt: { found: true, text: `Contact: mailto:s@example.com\nExpires: ${new Date(Date.now() + 86400e3 * 100).toISOString()}` },
  });
  assert.equal(r.findings.length, 0);
  const md = R.toMarkdown(r);
  assert.match(md, /does not prove the site is secure/);
});

test('disclosure template is editable text with facts only and sane defaults', () => {
  const r = build({ facts: facts({ sinks: ['innerHTML'] }), requestLog: [{ method: 'GET', path: '/a', status: 200 }] });
  const msg = R.disclosureTemplate(r, { recipient: 'Sam', sender: 'Alex', contact: 'alex@example.org', days: 60 });
  assert.match(msg, /^Subject: Security observations for example\.com/);
  assert.match(msg, /Hello Sam,/);
  assert.match(msg, /GET\/HEAD requests/);
  assert.match(msg, /did not try to sign in/);
  assert.match(msg, /not as confirmed vulnerabilities/);
  assert.match(msg, /60 days/);
  assert.match(msg, /alex@example\.org/);
  assert.ok(!/Referrer-Policy/.test(msg), 'informational findings are left out by default');
  const only = R.disclosureTemplate(r, { include: ['csp-missing'] });
  assert.ok(only.includes('No Content-Security-Policy header') && !only.includes('Strict-Transport'));
  assert.match(R.disclosureTemplate(r), /\[your name\]/);
});

test('header failure and unusual status are reported as notes, not hidden', () => {
  const failed = build({ headers: { ok: false, error: 'the request timed out' } });
  assert.match(failed.notes[0], /could not be read \(the request timed out\)/);
  assert.ok(!ids(failed).includes('csp-missing'));
  const err = build({ headers: { ok: true, status: 403, headers: {} } });
  assert.ok(err.notes.some((n) => /HTTP 403/.test(n)));
});

test('a saved report round-trips through validateReport unchanged in substance', () => {
  const r = build({ facts: facts({ sinks: ['innerHTML'], cookies: [{ name: 'sessionid', secure: true }] }), requestLog: [{ method: 'GET', path: '/a', status: 200, purpose: 'x' }] });
  const v = R.validateReport(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(v.findings.map((f) => [f.id, f.severity, f.status, f.confidence]), r.findings.map((f) => [f.id, f.severity, f.status, f.confidence]));
  assert.deepEqual(v.counts, r.counts);
  assert.deepEqual(v.attackPaths.map((p) => p.id), r.attackPaths.map((p) => p.id));
  assert.deepEqual(v.plan.items.map((i) => i.title), r.plan.items.map((i) => i.title));
  assert.equal(v.requestsMade, 1);
});

test('regression: a tampered saved report cannot smuggle links, scripts, severities or fake limits', () => {
  const r = JSON.parse(JSON.stringify(build({ facts: facts({ sinks: ['innerHTML'] }) })));
  r.findings[0].refs = ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'http://plain.example/', 'https://ok.example/doc'];
  r.findings[0].severity = 'catastrophic';
  r.findings[0].status = 'verified-exploit';
  r.findings[0].category = '<img src=x onerror=alert(1)>';
  r.findings[0].related = ['nope', r.findings[1].id];
  r.limitations = ['This site is perfectly secure'];
  r.coverage.notTestable = [];
  r.attackPaths = [{ id: 'p', title: 't', status: 'confirmed', severity: 'high', steps: 'not an array', findingIds: ['nope'] }];
  r.requestLog = [{ method: 'DELETE', path: '/x', status: 200 }];
  r.target = 'https://example.com/a?token=SECRET#frag';
  const v = R.validateReport(r);
  const f0 = v.findings[0];
  assert.deepEqual(f0.refs, ['https://ok.example/doc']);
  assert.equal(f0.severity, 'info');
  assert.equal(f0.status, 'info');
  assert.doesNotMatch(f0.category, /img/);
  assert.deepEqual(f0.related, [r.findings[1].id]);
  assert.ok(v.limitations.every((l) => !/perfectly secure/.test(l)) && v.coverage.notTestable.length >= 8, 'fixed texts come from the code, not the saved data');
  assert.equal(v.attackPaths[0].status, 'potential');
  assert.deepEqual(v.attackPaths[0].steps, []);
  assert.equal(v.requestLog[0].method, 'GET');
  assert.equal(v.target, 'https://example.com/a');
});

test('validateReport refuses things that are not a version 2 report', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { version: 1, findings: [], target: 'https://a/' }, { version: 2, findings: 'x', target: 'https://a/' }, { version: 2, findings: [], target: 'not a url' }]) assert.equal(R.validateReport(bad), null);
});

test('technical diagnostics hold how the scan ran, never secrets, bodies or query strings', () => {
  const aws = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const report = R.buildReport({
    url: 'https://example.com/shop?id=5&token=SECRETTOKEN',
    level: 'standard',
    facts: facts({ cookies: [{ name: 'sessionid', secure: true }] }),
    headers: { ok: true, status: 200, method: 'HEAD', headers: { server: 'nginx/1.18.0', 'content-security-policy': "default-src 'self'", 'x-powered-by': null } },
    securityTxt: { found: false, status: 404 },
    scripts: { urls: ['https://example.com/app.js?v=SECRETQUERY'], items: [{ url: 'https://example.com/app.js?v=SECRETQUERY', text: `var k="${aws}";`, map: { status: 200, exposed: true } }], inline: [] },
    requestLog: [{ method: 'GET', path: '/app.js', status: 200, purpose: 'page script' }],
  });
  const tech = R.buildTechnical({
    report,
    facts: facts({ cookies: [{ name: 'sessionid', secure: true }] }),
    headers: { ok: true, status: 200, method: 'HEAD', headers: { server: 'nginx/1.18.0', 'content-security-policy': "default-src 'self'" } },
    baseline: { path: '/__x', res: { status: 404, type: 'text/html', text: '<h1>Not found</h1> body text that must not be kept' } },
    probeLog: [{ id: 'env-file', path: '/.env', status: 404, type: 'text/html', bytes: 20 }],
    scripts: { urls: ['https://example.com/app.js?v=SECRETQUERY'], items: [{ url: 'https://example.com/app.js?v=SECRETQUERY', text: `var k="${aws}";`, map: { status: 200, exposed: true } }] },
    traffic: { entries: [{ method: 'GET', url: 'https://api.example.com/u?token=SECRETTOKEN', status: 200 }] },
    timings: { headers: 40 },
    environment: { extensionVersion: '4.1.0' },
  });
  const json = JSON.stringify(tech);
  for (const secret of [aws, 'SECRETTOKEN', 'SECRETQUERY', 'body text that must not be kept'] ) assert.ok(!json.includes(secret), secret);
  assert.equal(tech.responseHeaders.server, 'nginx/1.18.0');
  assert.deepEqual(tech.contentSecurityPolicy, ["default-src 'self'"]);
  assert.equal(tech.baseline.status, 404);
  assert.ok(tech.baseline.fingerprint);
  assert.equal(tech.scripts[0].path, '/app.js');
  assert.equal(tech.scripts[0].sourceMap.exposed, true);
  assert.equal(tech.checks.find((c) => c.id === 'headers').ms, 40);
  assert.equal(tech.reportId, report.id);
  assert.match(tech.limits.note, /does not change these limits/);
  assert.ok(tech.cookies[0].name === 'sessionid' && !('value' in tech.cookies[0]));
  // the report itself never carries the technical section
  assert.ok(!('technical' in report) && !JSON.stringify(report).includes('fingerprint'));
});
