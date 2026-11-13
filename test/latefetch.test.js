const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/latefetch.js');

test('the kind comes from the initiator, and from the address when the initiator is unknown', () => {
  assert.equal(L.kindOf('script', 'https://a.test/x'), 'script');
  assert.equal(L.kindOf('link', 'https://a.test/x'), 'stylesheet');
  assert.equal(L.kindOf('fetch', 'https://a.test/api'), 'data');
  assert.equal(L.kindOf('', 'https://a.test/app.js?v=2'), 'script');
  assert.equal(L.kindOf('', 'https://a.test/site.CSS'), 'stylesheet');
  assert.equal(L.kindOf('', 'https://a.test/pic.webp#x'), 'image');
  assert.equal(L.kindOf('mystery', 'https://a.test/thing'), 'other');
});

test('only http and https addresses are fetched', () => {
  assert.equal(L.fetchable('https://a.test/x.js'), true);
  assert.equal(L.fetchable('http://a.test/x.js'), true);
  assert.equal(L.fetchable('blob:https://a.test/1'), false);
  assert.equal(L.fetchable('data:text/css,a{}'), false);
  assert.equal(L.fetchable('chrome-extension://abc/x.js'), false);
});

test('late entries start after DOMContentLoaded, oldest first, without repeats', () => {
  const entries = [
    { name: 'https://a.test/early.js', initiatorType: 'script', startTime: 10 },
    { name: 'https://a.test/late.js', initiatorType: 'script', startTime: 3205.7, responseStatus: 200 },
    { name: 'https://a.test/late.css', initiatorType: 'link', startTime: 3100 },
    { name: 'https://a.test/late.css', initiatorType: 'link', startTime: 3100 },
    { name: 'https://a.test/bad', initiatorType: 'fetch', startTime: NaN },
    null,
  ];
  const out = L.lateEntries(entries, 500);
  assert.deepEqual(out.map((x) => [x.url, x.kind, x.startTime, x.status]), [
    ['https://a.test/late.css', 'stylesheet', 3100, null],
    ['https://a.test/late.js', 'script', 3206, 200],
  ]);
});

test('with no render time known, every entry counts as late', () => {
  assert.equal(L.lateEntries([{ name: 'https://a.test/x', initiatorType: 'img', startTime: 1 }], NaN).length, 1);
});

test('observed nodes are added, and a resource the timing already has keeps its timing', () => {
  const timed = [{ url: 'https://a.test/a.js', kind: 'script', startTime: 3000, status: 200 }];
  const observed = [
    { url: 'https://a.test/a.js', kind: 'script', at: 2900 },
    { url: 'https://a.test/b.css', kind: 'stylesheet', at: 3500 },
  ];
  const merged = L.merge(timed, observed);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].startTime, 3000);
  assert.equal(merged[1].via, 'added to the page');
  assert.equal(merged[1].startTime, 3500);
});

test('file names say where the file went, keep the order, and cannot leave their folder', () => {
  assert.equal(L.fileName('https://a.test/js/app.js?v=3', 0, 'script'), 'loaded-later/js/001-app.js');
  assert.equal(L.fileName('https://a.test/style%20one.css', 1, 'stylesheet'), 'loaded-later/css/002-style_one.css');
  const evil = L.fileName('https://a.test/..%2F..%2Fetc%2Fpasswd', 2, 'other');
  assert.ok(!evil.split('/').includes('..'));
  assert.ok(evil.startsWith('loaded-later/other/003-'));
  assert.equal(L.fileName('https://a.test/', 3, 'image'), 'loaded-later/images/004-a.test');
});
