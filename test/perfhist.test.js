const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/perfhist.js');

const v = (lcp, cls = 0.01) => ({ lcp: { value: lcp }, cls: { value: cls }, fcp: { value: 900 }, ttfb: { value: 200 }, inp: null });

test('keyFor ignores query and fragment', () => {
  assert.equal(P.keyFor('https://a.test/x/y?q=1#top'), 'https://a.test/x/y');
});
test('pointFrom reads values and leaves missing metrics null', () => {
  const p = P.pointFrom(v(1200), 5);
  assert.equal(p.lcp, 1200);
  assert.equal(p.inp, null);
  assert.equal(p.t, 5);
});
test('add keeps order, de-duplicates close or identical readings and caps the list', () => {
  let s = {};
  s = P.add(s, 'k', P.pointFrom(v(1000), 1000), 3);
  s = P.add(s, 'k', P.pointFrom(v(1000), 9000), 3); // identical
  s = P.add(s, 'k', P.pointFrom(v(1500), 9500), 3); // within 3 s of the last kept? last is 1000 -> kept (8.5 s later)
  s = P.add(s, 'k', P.pointFrom(v(1600), 20000), 3);
  s = P.add(s, 'k', P.pointFrom(v(1700), 30000), 3);
  assert.deepEqual(s.k.map((p) => p.lcp), [1500, 1600, 1700]);
});
test('a reading without any metric is ignored', () => {
  assert.deepEqual(P.add({}, 'k', P.pointFrom({}, 1)), {});
});
test('summary reports latest, change, best and worst', () => {
  const pts = [{ t: 1, lcp: 3000 }, { t: 2, lcp: 2000 }, { t: 3, lcp: 2600 }];
  const s = P.summary(pts, 'lcp');
  assert.equal(s.latest, 2600);
  assert.equal(s.delta, 600);
  assert.equal(s.best, 2000);
  assert.equal(s.worst, 3000);
  assert.equal(s.rating, 'ni');
  assert.equal(P.summary(pts, 'inp'), null);
});
