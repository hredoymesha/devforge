const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/siteaccess.js');
const DFStored = require('../lib/stored.js');

test('default mode allows every site, and a missing setting counts as the default', () => {
  assert.equal(A.allowed({ allowAllSites: true, siteAllowlist: [] }, 'https://any.example/x'), true);
  assert.equal(A.allowed({}, 'https://any.example/x'), true);
  assert.equal(A.allowed(undefined, 'https://any.example/x'), true);
});

test('limited mode allows only the listed origins, and ignores their paths', () => {
  const s = { allowAllSites: false, siteAllowlist: ['https://shop.test'] };
  assert.equal(A.allowed(s, 'https://shop.test/cart?x=1'), true);
  assert.equal(A.allowed(s, 'https://other.test/'), false);
  assert.equal(A.allowed(s, 'http://shop.test/'), false, 'a different scheme is a different origin');
  assert.equal(A.allowed({ allowAllSites: false, siteAllowlist: [] }, 'https://shop.test/'), false);
});

test('an address that does not parse is never allowed in limited mode', () => {
  assert.equal(A.allowed({ allowAllSites: false, siteAllowlist: ['https://shop.test'] }, 'not a url'), false);
});

test('the list keeps web origins only, without paths or queries', () => {
  assert.equal(A.originOf('https://shop.test/a/b?token=secret#x'), 'https://shop.test');
  assert.equal(A.originOf('chrome://settings'), null);
  assert.equal(A.originOf('file:///C:/a.html'), null);
  assert.equal(A.originOf('nonsense'), null);
});

test('a site seen again moves to the top and counts up; the list has a cap', () => {
  let log = [];
  log = A.record(log, 'https://a.test', '2026-01-01T00:00:00.000Z');
  log = A.record(log, 'https://b.test', '2026-01-02T00:00:00.000Z');
  log = A.record(log, 'https://a.test', '2026-01-03T00:00:00.000Z');
  assert.deepEqual(log.map((e) => [e.origin, e.count]), [['https://a.test', 2], ['https://b.test', 1]]);
  assert.equal(log[0].last, '2026-01-03T00:00:00.000Z');
  let capped = [];
  for (let i = 0; i < 5; i++) capped = A.record(capped, 'https://s' + i + '.test', '2026-01-01T00:00:00.000Z', 3);
  assert.equal(capped.length, 3);
  assert.equal(capped[0].origin, 'https://s4.test');
});

test('a stored site log keeps valid web origins and drops anything else', () => {
  const raw = [
    { origin: 'https://ok.test', last: '2026-01-01T00:00:00.000Z', count: 3 },
    { origin: 'https://ok.test/path', last: '2026-01-01T00:00:00.000Z', count: 1 },
    { origin: 'javascript:alert(1)', last: '2026-01-01T00:00:00.000Z', count: 1 },
    { origin: 'https://bad-date.test', last: 'yesterday', count: 1 },
    { origin: 'https://bad-count.test', last: '2026-01-01T00:00:00.000Z', count: -4 },
    { origin: 'https://ok.test', last: '2026-01-05T00:00:00.000Z', count: 9 },
    'just a string',
    null,
  ];
  assert.deepEqual(DFStored.siteLog(raw), [{ origin: 'https://ok.test', last: '2026-01-01T00:00:00.000Z', count: 3 }]);
  assert.deepEqual(DFStored.siteLog('not a list'), []);
  assert.deepEqual(DFStored.siteLog(undefined), []);
});
