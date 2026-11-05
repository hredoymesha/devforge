const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/tamper.js');

test('no replaced built-in, no notice', () => {
  assert.equal(T.notice([]), null);
  assert.equal(T.notice(undefined), null);
});

test('a notice names each replaced built-in once and recommends capture from page start', () => {
  const n = T.notice(['fetch', 'fetch', 'JSON.parse']);
  assert.deepEqual(n.list, ['fetch', 'JSON.parse']);
  assert.match(n.text, /fetch, JSON\.parse/);
  assert.match(n.text, /From page start/);
  assert.match(n.title, /replaced built-in functions/);
});

test('names the page controls are not shown: only paths from the fixed list count', () => {
  const n = T.notice(['<img src=x onerror=1>', 'fetch']);
  assert.deepEqual(n.list, ['fetch']);
  assert.equal(T.notice(['made.up']), null);
});

test('the list covers the built-ins capture and its secret handling rely on', () => {
  for (const p of ['fetch', 'XMLHttpRequest.prototype.send', 'WebSocket', 'Function.prototype.call', 'JSON.stringify', 'String.prototype.charCodeAt']) assert.ok(T.PATHS.includes(p), p);
  assert.equal(new Set(T.PATHS).size, T.PATHS.length);
});
