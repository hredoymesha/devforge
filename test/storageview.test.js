const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/storageview.js');

test('keys round-trip through their tagged form, and a number and a string stay different', () => {
  for (const k of ['a', 'a"b', 7, -1.5, new Date(Date.UTC(2026, 0, 2)), ['x', 3, ['y']]]) {
    const back = V.decodeKey(JSON.parse(JSON.stringify(V.encodeKey(k))));
    assert.deepEqual(back instanceof Date ? back.getTime() : back, k instanceof Date ? k.getTime() : k);
  }
  assert.notDeepEqual(V.encodeKey(7), V.encodeKey('7'));
});

test('keys that cannot be found again are refused, so the wrong record is never touched', () => {
  assert.throws(() => V.decodeKey({ t: 'x', v: 'binary' }), /cannot be used/);
  assert.throws(() => V.decodeKey({ t: 'n', v: 'NaN' }), /cannot be used/);
  assert.throws(() => V.decodeKey({ t: 'd', v: 'not a date' }), /cannot be used/);
  assert.throws(() => V.decodeKey(null), /cannot be used/);
});

test('key text is readable', () => {
  assert.equal(V.keyText(V.encodeKey(['a', 2])), '["a", 2]');
});

test('values that JSON cannot hold are written as marked objects', () => {
  const out = V.portable({ d: new Date(0), n: NaN, u: undefined, m: new Map([['k', 1]]), s: new Set([2]), big: 10n, nested: { a: [1, { x: 2 }] } });
  assert.deepEqual(out, {
    d: { $date: '1970-01-01T00:00:00.000Z' },
    n: { $number: 'NaN' },
    u: { $undefined: true },
    m: { $map: [['k', 1]] },
    s: { $set: [2] },
    big: { $bigint: '10' },
    nested: { a: [1, { x: 2 }] },
  });
});

test('a cycle and a very deep value stop instead of recursing forever', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.deepEqual(V.portable(a).self, { $circular: true });
  let deep = { end: true };
  for (let i = 0; i < 40; i++) deep = { next: deep };
  let node = V.portable(deep);
  let hops = 0;
  while (node && node.next !== undefined) {
    node = node.next;
    hops++;
  }
  assert.ok(hops <= 21);
});

test('binary data is described by its length and type, not written out', () => {
  assert.deepEqual(V.portable(new Uint8Array(5)), { $bytes: 5, $type: 'Uint8Array' });
  assert.deepEqual(V.portable(new ArrayBuffer(3)), { $bytes: 3 });
});

test('a value text longer than the limit is cut and says so', () => {
  const big = { text: 'x'.repeat(V.LIMITS.valueChars + 100) };
  const r = V.valueText(big);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, V.LIMITS.valueChars);
  assert.equal(V.valueText({ a: 1 }).truncated, false);
});

test('a date written in the editor comes back as a date, and invalid JSON is refused in plain words', () => {
  const v = V.revive('{"when":{"$date":"2026-01-02T03:04:05.000Z"},"n":[1,{"ok":true}]}');
  assert.ok(v.when instanceof Date);
  assert.equal(v.when.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.deepEqual(v.n, [1, { ok: true }]);
  assert.throws(() => V.revive('{"a":'), /not valid JSON/);
});

test('cache file names stay inside their folder and are unique by index', () => {
  assert.equal(V.cacheFileName('https://a.test/x/y.css?v=2', 0), 'cache/0001-a.test/x/y.css');
  assert.equal(V.cacheFileName('https://a.test/', 1), 'cache/0002-a.test/index');
  const evil = V.cacheFileName('https://a.test/../../etc/passwd', 2);
  assert.ok(!evil.split('/').includes('..'));
  assert.ok(evil.startsWith('cache/0003-'));
  assert.notEqual(V.cacheFileName('https://a.test/a', 0), V.cacheFileName('https://a.test/a', 1));
  assert.ok(V.cacheFileName('https://a.test/' + 'x'.repeat(500), 0).length <= 'cache/0001-'.length + 200);
  assert.match(V.cacheFileName('not a url', 3), /^cache\/0004-local\//);
});

test('the limits are the numbers the tab shows', () => {
  assert.equal(V.LIMITS.recordsPerPage, 200);
  assert.equal(V.LIMITS.exportRecords, 10000);
  assert.equal(V.LIMITS.cacheTotalBytes, 50e6);
});
