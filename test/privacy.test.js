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

test('the AI sites named in PRIVACY.md are the ones in lib/ai.js, and no prompt is put in an address', () => {
  const ai = read('lib/ai.js');
  for (const host of ['claude.ai', 'chatgpt.com', 'gemini.google.com', 'copilot.microsoft.com']) {
    assert.ok(privacy.includes(host) && ai.includes(host), host);
  }
  const DFAI = require('../lib/ai.js');
  for (const k of Object.keys(DFAI.PROVIDERS)) assert.equal(DFAI.launchPlan(k).url, DFAI.PROVIDERS[k].url, k);
  assert.ok(!/[?&]q=|encodeURIComponent/.test(ai) && /Nothing is put in that page's address/.test(privacy));
});

test('the code contains no fixed web address that data could be sent to, other than the AI sites', () => {
  const urls = new Set([...code.matchAll(/['"`](https?:\/\/[a-z0-9.-]+\.[a-z]{2,})[/'"`]/gi)].map((m) => new URL(m[1]).hostname));
  const allowed = /^(claude\.ai|chatgpt\.com|gemini\.google\.com|copilot\.microsoft\.com|developer\.mozilla\.org|cheatsheetseries\.owasp\.org|owasp\.org|www\.w3\.org|github\.com|nvd\.nist\.gov|cve\.mitre\.org|web\.dev|infosec\.exchange|cdn\.jsdelivr\.net|([a-z0-9.-]*\.)?example\.[a-z]+|placeholder\.invalid|www\.rfc-editor\.org|cdn\.tailwindcss\.com|www\.googletagmanager\.com|www\.google-analytics\.com|[a-z.]*polyfill\.io|code\.jquery\.com|ajax\.googleapis\.com|cdnjs\.cloudflare\.com|unpkg\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com)$/i;
  const odd = [...urls].filter((u) => !allowed.test(u));
  assert.deepEqual(odd, []);
});

test('Settings, README and PRIVACY.md give the same reason for each permission, and cover the manifest', () => {
  const unq = (s) => s.replace(/`/g, '').trim();
  const mdRows = (text) => {
    const part = text.slice(text.search(/^## Permissions/m));
    return Object.fromEntries([...part.matchAll(/^\| (`[a-zA-Z]+`(?: \(optional\))?|Site access \(all sites\)) \| (.+) \|$/gm)].map((m) => [unq(m[1]), m[2]]));
  };
  const settings = read('panel/settings.js');
  const block = settings.slice(settings.indexOf("['Permission', 'Why'],") + 24, settings.indexOf("['debugger (not requested)'"));
  const fromPanel = Object.fromEntries([...block.matchAll(/\['([^']+)', '((?:[^'\\]|\\.)*)'\]/g)].map((m) => [m[1], m[2].replace(/\\'/g, "'")]));
  const fromReadme = mdRows(read('README.md'));
  const fromPrivacy = mdRows(privacy);
  const want = [...manifest.permissions, ...(manifest.optional_permissions || []).map((p) => p + ' (optional)'), 'Site access (all sites)'].sort();
  assert.deepEqual(Object.keys(fromPanel).sort(), want);
  assert.deepEqual(fromReadme, fromPanel);
  assert.deepEqual(fromPrivacy, fromPanel);
});

test('the one address DevForge never loads is explained where it is written and in the docs', () => {
  const gen = read('lib/gen.js');
  const at = gen.indexOf('https://cdn.tailwindcss.com');
  assert.ok(at > 0 && /never loads or calls it/.test(gen.slice(at - 600, at)));
  assert.ok(/`cdn\.tailwindcss\.com` in `lib\/gen\.js`/.test(privacy) && /`cdn\.tailwindcss\.com` in `lib\/gen\.js`/.test(read('README.md')));
});
