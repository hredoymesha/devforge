const test = require('node:test');
const assert = require('node:assert/strict');
const { splitReports } = require('../e2e/violations.js');

test('inline-handler reports from parsing page markup are set apart', () => {
  const r = splitReports(['script-src-attr  [chrome-extension:239:33 blocked=inline]']);
  assert.equal(r.parse.length, 1);
  assert.equal(r.other.length, 0);
});

test('every other refusal still counts as a failure', () => {
  const list = [
    'require-trusted-types-for Element setAttribute [chrome-extension:1:1 blocked=trusted-types-sink]',
    'script-src-elem  [chrome-extension:5:5 blocked=inline]',
    'script-src-attr  [chrome-extension:9:9 blocked=https://evil.example/x.js]',
    'trusted-types  [chrome-extension:2:2 blocked=trusted-types-policy]',
  ];
  const r = splitReports(list);
  assert.equal(r.parse.length, 0);
  assert.deepEqual(r.other, list);
});

test('a mixed list is split in order and an empty or missing list is fine', () => {
  const a = 'script-src-attr  [x:1:1 blocked=inline]';
  const b = 'require-trusted-types-for Element innerHTML [x:2:2 blocked=trusted-types-sink]';
  const r = splitReports([a, b, a]);
  assert.deepEqual(r.parse, [a, a]);
  assert.deepEqual(r.other, [b]);
  assert.deepEqual(splitReports([]), { parse: [], other: [] });
  assert.deepEqual(splitReports(undefined), { parse: [], other: [] });
});
