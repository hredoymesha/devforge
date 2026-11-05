const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/recheck.js');
const Scan = require('../lib/secscan.js');
const Probe = require('../lib/secprobe.js');

test('an exposed-path finding is re-checked with the same probe, two requests', () => {
  const f = { id: 'exposed-git-head', resource: '/.git/HEAD', theme: 'exposure' };
  assert.deepEqual(R.plan(f), { kind: 'probe', probe: 'git-head', path: '/.git/HEAD', requests: 2 });
});

test('every probe finding the scanner can produce has a plan, with a path the gate accepts', () => {
  for (const p of Probe.PROBES) {
    const plan = R.plan({ id: 'exposed-' + p.id, resource: p.path });
    assert.ok(plan && plan.kind === 'probe', p.id);
    assert.ok(Probe.isSafeProbePath(plan.path), p.id);
  }
});

test('an unknown probe, an unsafe path or a non-probe finding is not re-checked on its own', () => {
  assert.equal(R.plan({ id: 'exposed-nope', resource: '/x' }), null);
  assert.equal(R.plan({ id: 'exposed-git-head', resource: '/a/../b' }), null);
  assert.equal(R.plan({ id: 'exposed-git-head', resource: 'http://evil.example/x' }), null);
  assert.equal(R.plan({ id: 'cookie-no-secure', theme: 'cookies' }), null);
  assert.equal(R.plan(null), null);
  assert.equal(R.plan({}), null);
});

test('every header finding the scanner can produce has a headers plan', () => {
  const bad = { server: 'nginx/1.2.3', 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true', 'strict-transport-security': 'max-age=60', 'referrer-policy': 'unsafe-url', 'cache-control': 'public', 'x-powered-by': 'PHP/5.6' };
  const sets = [{}, bad, { 'content-security-policy': "default-src *; script-src 'unsafe-inline' 'unsafe-eval'" }, { 'content-security-policy-report-only': "default-src 'self'" }];
  let seen = 0;
  for (const headers of sets) {
    for (const f of Scan.analyzeHeaders(headers, { https: true, hasPasswordForm: true, resource: 'https://a.example/login' })) {
      seen++;
      assert.equal(R.plan(f).kind, 'headers', f.id);
    }
  }
  assert.ok(seen > 8, 'enough header findings were exercised: ' + seen);
});

test('decide: gone from the fresh analysis is fixed, same id and resource is still present', () => {
  const f = { id: 'exposed-git-head', resource: '/.git/HEAD' };
  assert.equal(R.decide(f, []), 'fixed');
  assert.equal(R.decide(f, undefined), 'fixed');
  assert.equal(R.decide(f, [{ id: 'exposed-git-head', resource: '/.git/HEAD' }]), 'still-present');
  assert.equal(R.decide(f, [{ id: 'exposed-git-head', resource: '/other' }, { id: 'exposed-env-file', resource: '/.git/HEAD' }]), 'fixed');
});

test('end to end with the real analyzers: a probe that now answers 404 is fixed, one that still answers is not', () => {
  const baseline = Probe.baselineOf({ status: 404, type: 'text/plain', text: 'not found' });
  const fresh = (res) => Scan.analyzeProbes([{ probe: 'git-head', path: '/.git/HEAD', res }], baseline);
  const f = { id: 'exposed-git-head', resource: '/.git/HEAD' };
  assert.equal(R.decide(f, fresh({ status: 200, type: 'text/plain', text: 'ref: refs/heads/main\n' })), 'still-present');
  assert.equal(R.decide(f, fresh({ status: 404, type: 'text/plain', text: 'not found' })), 'fixed');
  // A single-page app that answers every path with its HTML shell is not an exposure.
  const shell = '<!doctype html><html><body><div id="root"></div></body></html>';
  const spaBase = Probe.baselineOf({ status: 200, type: 'text/html', text: shell });
  assert.equal(R.decide(f, Scan.analyzeProbes([{ probe: 'git-head', path: '/.git/HEAD', res: { status: 200, type: 'text/html', text: shell } }], spaBase)), 'fixed');
});

test('header outcome: a header that was added is fixed, a missing one is still present', () => {
  const f = Scan.analyzeHeaders({}, { https: true, resource: 'https://a.example/' }).find((x) => x.id === 'nosniff-missing');
  assert.ok(f);
  assert.equal(R.decide(f, Scan.analyzeHeaders({}, { https: true, resource: 'https://a.example/' })), 'still-present');
  assert.equal(R.decide(f, Scan.analyzeHeaders({ 'x-content-type-options': 'nosniff' }, { https: true, resource: 'https://a.example/' })), 'fixed');
});
