const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../lib/har.js');

const post = { method: 'POST', url: 'https://x.test/a?b=1', reqHeaders: { 'content-type': 'application/json', host: 'x.test', 'content-length': '7', authorization: '[redacted]' }, reqBody: '{"a":1}' };

test('toPython uses requests, keeps real headers and drops hop-by-hop ones', () => {
  const s = H.toPython(post);
  assert.match(s, /^import requests/);
  assert.match(s, /requests\.post\("https:\/\/x\.test\/a\?b=1", headers=headers, data=data\)/);
  assert.match(s, /"authorization": "\[redacted\]"/);
  assert.doesNotMatch(s, /content-length|"host"/);
});
test('toPython for a bare GET has no headers or data', () => {
  const s = H.toPython({ method: 'GET', url: 'https://x.test/' });
  assert.match(s, /requests\.get\("https:\/\/x\.test\/"\)/);
  assert.doesNotMatch(s, /headers|data/);
});
test('toPython escapes quotes in values', () => {
  const s = H.toPython({ method: 'POST', url: 'https://x.test/', reqBody: 'say "hi"' });
  assert.match(s, /data = "say \\"hi\\""/);
});
test('toNode is global fetch without browser-only credentials', () => {
  const s = H.toNode(post);
  assert.match(s, /await fetch\("https:\/\/x\.test\/a\?b=1"/);
  assert.doesNotMatch(s, /credentials/);
});
