const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/safe.js');

test('csv cells that start like formulas are neutralised', () => {
  assert.equal(S.csvEsc('=1+1'), "'=1+1");
  assert.equal(S.csvEsc('-5'), '-5');
  assert.equal(S.csvEsc('a,b'), '"a,b"');
});

test('sensitive keys are redacted', () => {
  for (const key of [
    'password',
    'Password',
    'user_password',
    'accessToken',
    'access_token',
    'X-Api-Key',
    'apiKey',
    'authorization',
    'sessionId',
    'csrf-token',
    'client_secret',
    'jwt',
    'otp',
    'pin',
    'cardNumber',
  ]) {
    assert.equal(S.isSensitiveKey(key), true, key);
  }
});

test('ordinary keys that merely contain a sensitive fragment are kept', () => {
  for (const key of ['author', 'design', 'designer', 'shipping', 'mapping', 'cardigan', 'passport', 'spinner', 'pass']) {
    if (key === 'pass') continue; // "pass" on its own is treated as a password field
    assert.equal(S.isSensitiveKey(key), false, key);
  }
  assert.equal(S.isSensitiveKey('pass'), true);
});

test('redactValue keeps unrelated fields', () => {
  assert.deepEqual(S.redactValue({ author: 'bob', password: 'x', nested: { design: 1, token: 't' } }), {
    author: 'bob',
    password: '[redacted]',
    nested: { design: 1, token: '[redacted]' },
  });
});

test('redactUrl hides sensitive query values and credentials only', () => {
  assert.equal(S.redactUrl('https://a.com/?token=abc&q=1'), 'https://a.com/?token=[redacted]&q=1');
  assert.equal(S.redactUrl('https://u:p@a.com/x'), 'https://a.com/x');
  assert.equal(S.redactUrl('https://a.com/?author=bob'), 'https://a.com/?author=bob');
});

test('redactBody handles JSON, form bodies and truncated JSON', () => {
  assert.match(S.redactBody('{"a":{"password":"x"},"n":1}'), /"password": "\[redacted\]"/);
  assert.equal(S.redactBody('user=a&password=b'), 'user=a&password=[redacted]');
  assert.equal(S.redactBody('{"password":"abc","author":"bob","x":"yy'), '{"password":"[redacted]","author":"bob","x":"yy');
});

test('isPrivateHost / blocksPrivate', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '[::1]', 'fd00::1']) {
    assert.equal(S.isPrivateHost(host), true, host);
  }
  for (const host of ['example.com', '172.32.0.1', '8.8.8.8', 'fe80.example.com']) {
    assert.equal(S.isPrivateHost(host), false, host);
  }
  // regression: a trailing dot named the same host but slipped past the name checks
  for (const host of ['localhost.', 'app.localhost.', 'printer.local.', 'db.internal.', 'LOCALHOST']) assert.equal(S.isPrivateHost(host), true, host);
  assert.equal(S.blocksPrivate('http://localhost./admin', 'https://example.com/'), true);
  assert.equal(S.blocksPrivate('http://2130706433/', 'https://example.com/'), true, 'decimal IPv4 is normalised by URL');
  assert.equal(S.blocksPrivate('http://[::ffff:127.0.0.1]/', 'https://example.com/'), true);
  assert.equal(S.blocksPrivate('http://192.168.1.5/a', 'https://example.com/'), true);
  assert.equal(S.blocksPrivate('http://192.168.1.5/a', 'http://192.168.1.5/'), false);
  assert.equal(S.blocksPrivate('not a url', 'https://example.com/'), true);
});

test('regression: workflow steps cannot navigate to javascript: or data: addresses', () => {
  assert.equal(S.webUrl('javascript:alert(1)', 'https://a.example/'), null);
  assert.equal(S.webUrl('data:text/html,<script>1</script>', 'https://a.example/'), null);
  assert.equal(S.webUrl('/next', 'https://a.example/x'), 'https://a.example/next');
  assert.deepEqual(S.workflowProblems([{ action: 'click', selector: '#a' }, { action: 'navigate', url: 'https://a.example/' }]), []);
  assert.match(S.workflowProblems([{ action: 'navigate', url: 'javascript:alert(1)' }])[0], /http and https/);
  assert.match(S.workflowProblems([{ action: 'eval' }])[0], /unknown action/);
  assert.match(S.workflowProblems({})[0], /list of steps/);
});

test('regression: the panel only accepts well-formed messages from the expected sender', () => {
  const own = 'abcdefghijklmnop';
  const tab = { id: 7 };
  const ok = (m, sender, active = 7) => S.checkPanelMessage(m, sender, own, active);
  // content script in the active tab
  assert.deepEqual(ok({ type: 'df:selected', handle: 'h12' }, { id: own, tab }), { type: 'df:selected', handle: 'h12' });
  assert.deepEqual(ok({ type: 'df:pick-cancelled' }, { id: own, tab }), { type: 'df:pick-cancelled' });
  // service worker (no tab) for commands
  assert.deepEqual(ok({ type: 'df:command', command: 'pick' }, { id: own }), { type: 'df:command', command: 'pick' });
  // wrong sender id, missing sender, wrong tab, tab where none is allowed
  assert.equal(ok({ type: 'df:selected', handle: 'h1' }, { id: 'other', tab }), null);
  assert.equal(ok({ type: 'df:selected', handle: 'h1' }, undefined), null);
  assert.equal(ok({ type: 'df:selected', handle: 'h1' }, { id: own, tab: { id: 8 } }), null);
  assert.equal(ok({ type: 'df:selected', handle: 'h1' }, { id: own }), null, 'a selection must come from a tab');
  assert.equal(ok({ type: 'df:command', command: 'pick' }, { id: own, tab }), null, 'a content script cannot issue panel commands');
  // malformed payloads
  for (const bad of [null, undefined, 'x', 5, {}, { type: 5 }, { type: 'df:unknown' }, { type: 'df:selected' }, { type: 'df:selected', handle: '<img onerror=1>' }, { type: 'df:selected', handle: 'h' }, { type: 'df:selected', handle: 'h1234567890123' }, { type: 'df:selected', handle: { toString: () => 'h1' } }, { type: 'df:command', command: 'delete-everything' }, { type: 'df:command' }])
    assert.equal(ok(bad, { id: own, tab }), null, JSON.stringify(bad));
  assert.equal(ok({ type: 'df:command', command: '__proto__' }, { id: own }), null);
  // extra fields are dropped from the normalised message
  assert.deepEqual(ok({ type: 'df:selected', handle: 'h3', evil: 1 }, { id: own, tab }), { type: 'df:selected', handle: 'h3' });
});

test('adversarial host matrix: parsing, not text matching, decides what is private', () => {
  const PRIVATE = ['localhost', 'localhost.', 'LOCALHOST', 'a.localhost', 'x.local', 'x.internal', 'router.home.arpa', '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.1.1',
    '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.0.1', '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '[::1]', '[::]', '[fd00::1]', '[fe80::1]', '[fec0::1]', '[ff02::1]', '[2001:db8::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', '[::127.0.0.1]',
    '[64:ff9b::7f00:1]', '[2002:c0a8:101::1]', '[0:0:0:0:0:0:0:1]', '[0000:0000:0000:0000:0000:0000:0000:0001]'];
  const PUBLIC = ['example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', '198.17.0.1', '198.20.0.1', '[2606:4700::1111]', '[::ffff:8.8.8.8]',
    '[::ffff:808:808]', '[64:ff9b::808:808]', '[2002:808:808::1]', 'fe80.example.com', 'localhost.example.com', 'notlocal.com', 'xlocalhost'];
  for (const h of PRIVATE) assert.equal(S.isPrivateHost(h), true, h);
  for (const h of PUBLIC) assert.equal(S.isPrivateHost(h), false, h);
  // the URL parser canonicalises numeric spellings before the check sees them
  for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0/', 'http://user:pw@127.0.0.1/', 'http://example.com@127.0.0.1/'])
    assert.equal(S.blocksPrivate(u, 'https://example.com/'), true, u);
  for (const u of ['http://127.0.0.1@example.com/', 'http://example.com/?u=http://127.0.0.1/', 'http://example.com/%2f127.0.0.1', 'http://example.com#@127.0.0.1'])
    assert.equal(S.blocksPrivate(u, 'https://other.test/'), false, u);
  assert.equal(S.isPrivateHost('[1:2:3:4:5:6:7:8:9]'), true, 'a malformed IPv6 literal is refused, not waved through');
  assert.equal(S.isPrivateHost(''), true);
});

test('port policy: the page may reach its own host on dev ports but not on well-known local admin ports', () => {
  const page = 'http://localhost:3000/';
  assert.equal(S.blocksPrivate('http://localhost:3000/a.css', page), false);
  assert.equal(S.blocksPrivate('http://localhost:5173/app.js', page), false, 'ordinary dev port on the same host');
  assert.equal(S.blocksPrivate('http://localhost:9200/_cat/indices', page), true, 'Elasticsearch');
  assert.equal(S.blocksPrivate('http://localhost:2375/containers/json', page), true, 'Docker API');
  assert.equal(S.blocksPrivate('http://localhost:8500/v1/kv/', page), true, 'Consul');
  assert.equal(S.blocksPrivate('http://127.0.0.1:3000/', page), true, 'a different spelling is a different host');
  assert.equal(S.blocksPrivate('http://localhost:2375/', 'http://localhost:2375/'), false, 'a page that is itself on that port may fetch from it');
  assert.equal(S.blocksPrivate('http://localhost:9200/', 'https://example.com/'), true);
});
