const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const privacy = read('PRIVACY.md');
const manifest = JSON.parse(read('manifest.json'));
const code = ['panel', 'lib', 'agent'].flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => read(d + '/' + f))).join('\n') + read('background.js');

test('every permission in the manifest is listed in PRIVACY.md, and nothing else is claimed', () => {
  for (const p of [...manifest.permissions, ...(manifest.optional_permissions || [])]) assert.ok(privacy.includes('`' + p + '`'), p);
  assert.ok(manifest.host_permissions.includes('<all_urls>') && /Site access \(all sites\)/.test(privacy));
  assert.ok(/`debugger` permission is not requested/.test(privacy));
  assert.ok(!(manifest.permissions || []).concat(manifest.optional_permissions || []).includes('debugger'));
  const claimed = [...privacy.matchAll(/^\| `([a-zA-Z]+)`/gm)].map((m) => m[1]).filter((p) => !['settings', 'netRules', 'perfHistory'].includes(p));
  const real = new Set([...manifest.permissions, ...(manifest.optional_permissions || [])]);
  for (const p of claimed) assert.ok(real.has(p), p + ' is claimed but not in the manifest');
});

test('the storage keys named in PRIVACY.md exist in the code', () => {
  for (const key of ['settings', 'netRules', 'perfHistory', 'secFindingAcks', 'installSalt', 'pendingCommand', 'secAcknowledged']) {
    assert.ok(privacy.includes('`' + key + '`'), key + ' is not described');
    assert.ok(code.includes("'" + key + "'"), key + ' is not used in the code');
  }
  assert.ok(code.includes("indexedDB.open(DB") && /DB = 'devforge'/.test(read('lib/store.js')));
});

test('the AI sites named in PRIVACY.md are the ones in lib/ai.js, and the prefill limit is right', () => {
  const ai = read('lib/ai.js');
  for (const host of ['claude.ai', 'chatgpt.com', 'gemini.google.com', 'copilot.microsoft.com']) {
    assert.ok(privacy.includes(host) && ai.includes(host), host);
  }
  assert.ok(/max: 6000/.test(ai) && /6,000 characters/.test(privacy));
});

test('the code contains no fixed web address that data could be sent to, other than the AI sites', () => {
  const urls = new Set([...code.matchAll(/['"`](https?:\/\/[a-z0-9.-]+\.[a-z]{2,})[/'"`]/gi)].map((m) => new URL(m[1]).hostname));
  const allowed = /^(claude\.ai|chatgpt\.com|gemini\.google\.com|copilot\.microsoft\.com|developer\.mozilla\.org|cheatsheetseries\.owasp\.org|owasp\.org|www\.w3\.org|github\.com|nvd\.nist\.gov|cve\.mitre\.org|web\.dev|infosec\.exchange|cdn\.jsdelivr\.net|([a-z0-9.-]*\.)?example\.[a-z]+|placeholder\.invalid|www\.rfc-editor\.org|cdn\.tailwindcss\.com|www\.googletagmanager\.com|www\.google-analytics\.com|[a-z.]*polyfill\.io|code\.jquery\.com|ajax\.googleapis\.com|cdnjs\.cloudflare\.com|unpkg\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com)$/i;
  const odd = [...urls].filter((u) => !allowed.test(u));
  assert.deepEqual(odd, []);
});
