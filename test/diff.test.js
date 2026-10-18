const test = require('node:test');
const assert = require('node:assert/strict');
const DFDiff = require('../lib/diff.js');

const f = (id, severity = 'low') => ({ id, title: 'Finding ' + id, severity });
const rep = (ids, extra = {}) => ({ version: 2, id: 'r' + ids.join(''), target: 'https://example.org/', level: 'passive', scannedAt: '2026-10-01T10:00:00.000Z', findings: ids.map((i) => (Array.isArray(i) ? f(i[0], i[1]) : f(i))), ...extra });

test('compareReports: fewer findings and new findings are both reported', () => {
  const t = DFDiff.compareReports(rep(['a', 'b', 'c', 'd']), rep(['a', 'e']));
  assert.equal(t.net, -2);
  assert.deepEqual(t.added.map((x) => x.id), ['e']);
  assert.deepEqual(t.resolved.map((x) => x.id).sort(), ['b', 'c', 'd']);
  assert.match(t.message, /1 new finding since the last scan/);
  assert.match(t.message, /2 fewer findings than last time/);
});

test('compareReports: identical findings say so', () => {
  const t = DFDiff.compareReports(rep(['a', 'b']), rep(['a', 'b']));
  assert.equal(t.message, 'Same findings as the last scan.');
  assert.equal(t.unchanged, 2);
});

test('compareReports: severity moves are listed and a different level adds a caveat', () => {
  const t = DFDiff.compareReports(rep([['a', 'low']]), rep([['a', 'high']], { level: 'standard' }));
  assert.equal(t.worse.length, 1);
  assert.equal(t.better.length, 0);
  assert.ok(t.levelDiffers);
  assert.match(t.caveat, /another level/);
});

test('compareReports: bad input gives null, never throws', () => {
  assert.equal(DFDiff.compareReports(null, rep(['a'])), null);
  assert.equal(DFDiff.compareReports({}, {}), null);
});

test('latestPrevious: same origin only, newest first, skips the current report and sealed items', () => {
  const cur = rep(['a'], { scannedAt: '2026-10-05T00:00:00.000Z', id: 'current-0001' });
  const item = (payload, extra = {}) => ({ kind: 'security', payload, ...extra });
  const items = [
    item(rep(['x'], { id: 'old-00001', scannedAt: '2026-10-01T00:00:00.000Z' })),
    item(rep(['y'], { id: 'newer-001', scannedAt: '2026-10-03T00:00:00.000Z' })),
    item(rep(['z'], { id: 'other-001', scannedAt: '2026-10-04T00:00:00.000Z', target: 'https://other.example/' })),
    item(rep(['w'], { id: 'sealed-01', scannedAt: '2026-10-04T12:00:00.000Z' }), { locked: true }),
    item(cur.id ? { ...cur } : cur),
    { kind: 'element', payload: {} },
  ];
  const prev = DFDiff.latestPrevious(items, cur);
  assert.equal(prev.id, 'newer-001');
});

test('latestPrevious: first scan of a site has no previous report', () => {
  assert.equal(DFDiff.latestPrevious([], rep(['a'])), null);
});

const req = (method, url, status, extra = {}) => ({ method, url, status, ms: 100, size: 10, ...extra });

test('compareCaptures: added, removed, changed and unchanged', () => {
  const a = [req('GET', 'https://x.test/a', 200), req('GET', 'https://x.test/b', 200), req('GET', 'https://x.test/c', 200)];
  const b = [req('GET', 'https://x.test/a', 200), req('GET', 'https://x.test/b', 500), req('GET', 'https://x.test/d', 200)];
  const d = DFDiff.compareCaptures(a, b);
  assert.equal(d.same, 1);
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
  assert.equal(d.changed.length, 1);
  assert.deepEqual(d.changed[0].changes.status, [200, 500]);
});

test('compareCaptures: noisy headers are ignored, real header changes are shown', () => {
  const a = [req('GET', 'https://x.test/a', 200, { resHeaders: { date: 'Mon', 'cache-control': 'no-store' } })];
  const b = [req('GET', 'https://x.test/a', 200, { resHeaders: { date: 'Tue', 'cache-control': 'max-age=60' } })];
  const d = DFDiff.compareCaptures(a, b);
  assert.equal(d.changed.length, 1);
  assert.deepEqual(d.changed[0].changes.responseHeaders.changed['cache-control'], ['no-store', 'max-age=60']);
  assert.equal(d.changed[0].changes.responseHeaders.changed.date, undefined);
});

test('compareCaptures: repeated calls to the same address are matched in order', () => {
  const a = [req('GET', 'https://x.test/poll', 200), req('GET', 'https://x.test/poll', 200)];
  const b = [req('GET', 'https://x.test/poll', 200), req('GET', 'https://x.test/poll', 404)];
  const d = DFDiff.compareCaptures(a, b);
  assert.equal(d.changed.length, 1);
  assert.equal(d.same, 1);
});

test('compareCaptures: ignoreQuery matches /a?x=1 with /a?x=2', () => {
  const a = [req('GET', 'https://x.test/a?x=1', 200)];
  const b = [req('GET', 'https://x.test/a?x=2', 200)];
  assert.equal(DFDiff.compareCaptures(a, b).added.length, 1);
  assert.equal(DFDiff.compareCaptures(a, b, { ignoreQuery: true }).same, 1);
});

test('slimEntry truncates large bodies and drops internal fields', () => {
  const s = DFDiff.slimEntry({ id: 1, method: 'GET', url: 'u', resBody: 'x'.repeat(10000), _t0: 5, frames: [1] }, 100);
  assert.ok(s.resBody.length < 130);
  assert.equal(s._t0, undefined);
  assert.equal(s.frames, undefined);
});

test('capturesToMarkdown lists changed, added and removed requests', () => {
  const a = [req('GET', 'https://x.test/a', 200, { resHeaders: { 'cache-control': 'no-store' } }), req('GET', 'https://x.test/gone', 200)];
  const b = [req('GET', 'https://x.test/a', 500, { resHeaders: { 'cache-control': 'max-age=1' } }), req('GET', 'https://x.test/new', 201)];
  const md = DFDiff.capturesToMarkdown(DFDiff.compareCaptures(a, b), { a: 'Before', b: 'After' });
  assert.match(md, /A: Before \(2 requests\)/);
  assert.match(md, /status: 200 → 500/);
  assert.match(md, /cache-control`: no-store → max-age=1/);
  assert.match(md, /## Only in B[\s\S]*x\.test\/new/);
  assert.match(md, /## Only in A[\s\S]*x\.test\/gone/);
});

test('regression: the same check on two addresses is two findings', () => {
  const f = (resource) => ({ id: 'csp-missing', title: 'No CSP', severity: 'medium', resource });
  const prev = { findings: [f('https://a.test/')] };
  const cur = { findings: [f('https://a.test/'), f('https://a.test/login')] };
  const d = DFDiff.compareReports(prev, cur);
  assert.equal(d.added.length, 1);
  assert.equal(d.resolved.length, 0);
  assert.equal(DFDiff.compareReports(cur, prev).resolved.length, 1);
});
