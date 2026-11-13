const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/sarif.js');

const findings = [
  { id: 'csp-missing', theme: 'headers', severity: 'medium', title: 'No Content-Security-Policy header', owasp: 'A05', status: 'open', resource: 'https://shop.test/checkout?session=abc123#top' },
  { id: 'git-exposed', theme: 'exposure', severity: 'high', title: 'Source control folder is public', owasp: 'A05', status: 'confirmed', resource: 'https://shop.test/.git/HEAD', detail: 'Found token sk_live_EXAMPLE_NOT_A_REAL_KEY in the response' },
  { id: 'server-version', theme: 'disclosure', severity: 'info', title: 'Server version is announced', owasp: 'A05', status: 'info', resource: 'https://shop.test/' },
  { id: 'lib-old', theme: 'misc', severity: 'low', title: 'Old library', resource: 'javascript:alert(1)' },
];

test('a SARIF log has the schema, version, one run, one rule per finding kind and one result per finding', () => {
  const doc = D.toSarif(findings, { version: '4.4.0', endedAt: '2026-01-02T03:04:05.000Z' });
  assert.equal(doc.version, '2.1.0');
  assert.equal(doc.runs.length, 1);
  assert.equal(doc.runs[0].tool.driver.name, 'DevForge');
  assert.equal(doc.runs[0].tool.driver.version, '4.4.0');
  assert.equal(doc.runs[0].tool.driver.rules.length, 4);
  assert.equal(doc.runs[0].results.length, 4);
  assert.deepEqual(D.validateSarif(doc), []);
});

test('severity sets the level, and the security severity score follows it', () => {
  const doc = D.toSarif(findings);
  const level = Object.fromEntries(doc.runs[0].results.map((r) => [r.ruleId, r.level]));
  assert.deepEqual(level, { 'csp-missing': 'warning', 'git-exposed': 'error', 'server-version': 'note', 'lib-old': 'note' });
  const score = Object.fromEntries(doc.runs[0].tool.driver.rules.map((r) => [r.id, r.properties['security-severity']]));
  assert.equal(score['git-exposed'], '8.0');
  assert.equal(score['server-version'], '0.0');
});

test('addresses keep no query, fragment or user name, and only web addresses are written', () => {
  const doc = D.toSarif(findings);
  const uris = doc.runs[0].results.map((r) => (r.locations ? r.locations[0].physicalLocation.artifactLocation.uri : null));
  assert.equal(uris[0], 'https://shop.test/checkout');
  assert.equal(uris[3], null, 'javascript: is not written as a location');
  assert.equal(D.addressOf('https://user:pw@shop.test/a?b=c'), 'https://shop.test/a');
  assert.equal(D.addressOf('data:text/html,x'), null);
});

test('a secret in a finding detail never reaches the SARIF file', () => {
  const text = JSON.stringify(D.toSarif(findings));
  assert.doesNotMatch(text, /sk_live_EXAMPLE_NOT_A_REAL_KEY/);
  assert.doesNotMatch(text, /abc123/);
});

test('every finding is placed in its ASVS chapter, and themes with no chapter are counted apart', () => {
  assert.equal(D.THEME_TO_ASVS.headers, 'V14');
  const cov = D.asvsCoverage(findings);
  assert.equal(cov.version, '4.0.3');
  const byId = Object.fromEntries(cov.chapters.map((c) => [c.id, c]));
  assert.equal(byId.V14.findings, 3);
  assert.deepEqual(byId.V14.ids, ['csp-missing', 'git-exposed', 'server-version']);
  assert.equal(byId.V4.findings, 0);
  assert.equal(cov.notMapped, 1);
  assert.equal(byId.V14.name, 'Configuration');
});

test('the validator names what is wrong', () => {
  assert.ok(D.validateSarif({ version: '2.0.0', runs: [] }).some((x) => /version/.test(x)));
  assert.ok(D.validateSarif({ version: '2.1.0', runs: [] }).some((x) => /non-empty/.test(x)));
  const bad = { version: '2.1.0', runs: [{ tool: { driver: { name: 'X', rules: [{ id: 'a' }, { id: 'a' }] } }, results: [{ ruleId: 'missing', level: 'loud', message: {}, locations: [{ physicalLocation: { artifactLocation: { uri: 'https://x.test/?token=1' } } }] }] }] };
  const problems = D.validateSarif(bad).join(' | ');
  assert.match(problems, /appears twice/);
  assert.match(problems, /not listed/);
  assert.match(problems, /unknown level/);
  assert.match(problems, /no message\.text/);
  assert.match(problems, /keeps a query/);
});

test('an empty set of findings is still a valid log with no results', () => {
  const doc = D.toSarif([]);
  assert.deepEqual(doc.runs[0].results, []);
  assert.deepEqual(D.validateSarif(doc), []);
});
