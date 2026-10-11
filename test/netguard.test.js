const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/netguard.js');

// The same text Chrome receives as `regexFilter` is run against canonical URLs (what the browser
// hands the rule), so this matrix tests the rule itself, not a re-implementation.
const MUST_BLOCK = [
  'http://127.0.0.1/', 'http://127.1.2.3:8080/x', 'http://localhost/', 'http://localhost./', 'http://LOCALHOST:3000/',
  'http://a.localhost/', 'http://printer.local/', 'http://printer.local./', 'http://db.internal/', 'http://10.0.0.5/',
  'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://172.16.0.1/', 'http://172.31.255.255/',
  'http://100.64.0.1/', 'http://100.127.255.255/', 'http://[::1]/', 'http://[::1]:8080/', 'http://[fd00::1]/', 'http://[fe80::1]/',
  'http://[::ffff:127.0.0.1]/', 'http://[2001:db8::1]/', 'http://user:pw@127.0.0.1/', 'http://x@localhost/', 'http://example.com@127.0.0.1/',
  'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://0.0.0.0/', 'http://[::]/', 'https://localhost?x=1',
  'http://127.0.0.1#frag',
];
const MUST_ALLOW = [
  'http://example.com/', 'http://172.32.0.1/', 'http://172.15.0.1/', 'http://100.63.0.1/', 'http://100.128.0.1/', 'http://11.0.0.1/',
  'https://localhost.example.com/', 'http://example.com/?u=http://127.0.0.1/', 'http://example.com/127.0.0.1', 'http://evil.com/@127.0.0.1',
  'http://example.com@evil.com/', 'http://127.0.0.1@example.com/', 'http://fe80.example.com/', 'http://notlocalhost/',
  'http://my.localhostx.com/', 'ftp://127.0.0.1/', 'http://127.example.com/', 'http://10.evil.com/', 'http://192.168.evil.com/', 'http://127.0.0.1.evil.com/', 'http://169.254.evil.net/', 'http://172.16.evil.org/',
];

test('the block rule matches private, loopback, link-local and internal destinations in every spelling', () => {
  for (const u of MUST_BLOCK) assert.equal(G.wouldBlock(u), true, 'should block ' + u + ' -> ' + new URL(u).href);
});

test('the block rule leaves public addresses and look-alike hosts alone', () => {
  for (const u of MUST_ALLOW) assert.equal(G.wouldBlock(u), false, 'should allow ' + u);
});

test('rule objects are well formed and scoped to this extension', () => {
  const rules = G.blockRules('abcdefghijklmnop');
  assert.equal(rules.length, 7);
  assert.equal(new Set(rules.map((r) => r.id)).size, 7);
  for (const r of rules) {
    assert.equal(r.action.type, 'block');
    assert.deepEqual(r.condition.initiatorDomains, ['abcdefghijklmnop']);
    assert.ok(r.condition.regexFilter.length < 700, 'each rule stays small: Chrome compiles regexFilter under a 2 KB memory limit');
  }
  const b = rules[0];
  const a = G.allowRule('http://localhost:3000/app', 'abcdefghijklmnop');
  assert.equal(a.action.type, 'allow');
  assert.ok(a.priority > b.priority, 'the page-host exception must outrank the block');
  const re = new RegExp(a.condition.regexFilter, 'i');
  assert.ok(re.test('http://localhost:9999/other'), 'same host, any port (matches the host-name check)');
  assert.ok(!re.test('http://127.0.0.1:3000/'), 'a different spelling of the address is not the page host');
  assert.ok(!re.test('http://localhost.evil.com/'));
  assert.ok(!re.test('http://x.com/localhost'));
});

test('install() fails closed when the API is missing, and sets both rules when present', async () => {
  await assert.rejects(() => G.install({}, 'id', 'http://a.test/'), /unavailable/);
  const calls = [];
  const api = { declarativeNetRequest: { updateSessionRules: async (o) => calls.push(o) } };
  assert.equal(await G.install(api, 'id', 'http://localhost:3000/'), 8);
  assert.deepEqual(calls[0].removeRuleIds, [...G.BLOCK_RULE_IDS, G.ALLOW_RULE_ID]);
  assert.equal(calls[0].addRules.length, 8);
  assert.equal(await G.install(api, 'id', 'not a url'), 7, 'no exception for an unparseable page address');
});

// The network rule and the host-name check are two implementations of one policy. Every address
// the parser calls private must also be blocked at the network layer (the rule may block more).
const S = require('../lib/safe.js');
test('consistency: every private IP literal the host-name check refuses is also blocked by the network rule', () => {
  const literals = [
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.1.1', '192.168.0.1', '169.254.169.254', '100.64.0.1',
    '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.19.9.9', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '[::1]', '[::]', '[fd00::1]', '[fc00::1]', '[fe80::1]', '[febf::1]', '[fec0::1]', '[ff02::1]', '[2001:db8::1]', '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', '[::127.0.0.1]', '[64:ff9b::7f00:1]', '[64:ff9b::a00:1]', '[2002:7f00:1::]', '[2002:c0a8:101::1]',
    '[0:0:0:0:0:0:0:1]', 'localhost', 'localhost.', 'a.localhost', 'x.local', 'x.internal', 'router.home.arpa',
  ];
  for (const h of literals) {
    assert.equal(S.isPrivateHost(h), true, 'host check should call ' + h + ' private');
    assert.equal(G.wouldBlock('http://' + h + '/'), true, 'network rule should block ' + h);
  }
  for (const h of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '192.169.0.1', '198.17.0.1', '198.20.0.1', '[2606:4700::1111]', '[2001:4860:4860::8888]', 'example.com']) {
    assert.equal(S.isPrivateHost(h), false, h);
    assert.equal(G.wouldBlock('http://' + h + '/'), false, 'network rule should allow ' + h);
  }
});
