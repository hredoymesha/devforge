const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../lib/owner.js');

const PASS = 'correct horse battery staple';

test('passphrase policy rejects short, repetitive and trivially guessable passphrases', () => {
  assert.equal(O.checkPassphrase('short').ok, false);
  assert.match(O.checkPassphrase('short').reason, /at least 12/);
  assert.equal(O.checkPassphrase('aaaaaaaaaaaaaaaa').ok, false);
  assert.equal(O.checkPassphrase('password1234').ok, false);
  assert.equal(O.checkPassphrase(undefined).ok, false);
  assert.equal(O.checkPassphrase(PASS).ok, true);
});

test('creating a vault stores a salt and a verifier, never the passphrase or the key', async () => {
  const { vault, key } = await O.createVault(PASS);
  const json = JSON.stringify(vault);
  assert.ok(!json.includes(PASS));
  assert.equal(vault.iterations, O.KDF.iterations);
  assert.ok(vault.salt && vault.verifier && vault.created);
  assert.equal(key.extractable, false, 'the unlocked key cannot be exported');
  assert.deepEqual(Object.keys(vault).sort(), ['created', 'iterations', 'kdf', 'salt', 'v', 'verifier']);
  await assert.rejects(O.createVault('short'), O.OwnerAuthError);
});

test('two vaults for the same passphrase differ (random salt)', async () => {
  const a = await O.createVault(PASS);
  const b = await O.createVault(PASS);
  assert.notEqual(a.vault.salt, b.vault.salt);
  assert.notEqual(a.vault.verifier, b.vault.verifier);
});

test('the right passphrase unlocks, a wrong one is rejected without revealing why', async () => {
  const { vault } = await O.createVault(PASS);
  const key = await O.unlock(PASS, vault);
  assert.ok(key);
  for (const wrong of ['correct horse battery stapl', 'Correct horse battery staple', '', 'x'.repeat(40)])
    await assert.rejects(O.unlock(wrong, vault), (e) => e instanceof O.OwnerAuthError && /not correct/.test(e.message));
});

test('a stored record cannot weaken the key derivation or use an unknown format', async () => {
  const { vault } = await O.createVault(PASS);
  await assert.rejects(O.unlock(PASS, { ...vault, iterations: 1 }), /weaker/);
  await assert.rejects(O.unlock(PASS, { ...vault, iterations: '600000' }), /weaker/);
  await assert.rejects(O.unlock(PASS, { ...vault, kdf: 'MD5' }), /format/);
  await assert.rejects(O.unlock(PASS, null), /format/);
});

test('sealed data round-trips with the key and is unreadable without it', async () => {
  const { vault } = await O.createVault(PASS);
  const key = await O.unlock(PASS, vault);
  const secret = { headers: { server: 'nginx/1.18.0' }, note: 'technical evidence' };
  const blob = await O.seal(key, secret);
  assert.deepEqual(await O.open(key, blob), secret);
  assert.ok(!JSON.stringify(blob).includes('nginx'), 'ciphertext does not contain the plaintext');
  const again = await O.seal(key, secret);
  assert.notEqual(blob.iv, again.iv);
  assert.notEqual(blob.ct, again.ct);
});

test('locked means locked: sealing and opening without a key throw OwnerLockedError', async () => {
  const { key } = await O.createVault(PASS);
  const blob = await O.seal(key, { a: 1 });
  for (const locked of [null, undefined]) {
    await assert.rejects(O.seal(locked, { a: 1 }), O.OwnerLockedError);
    await assert.rejects(O.open(locked, blob), O.OwnerLockedError);
  }
});

test('a different passphrase cannot open sealed data and altered data is detected', async () => {
  const mine = await O.createVault(PASS);
  const other = await O.createVault('another long passphrase here');
  const blob = await O.seal(mine.key, { secret: 'detail' });
  await assert.rejects(O.open(other.key, blob), /different passphrase or has been altered/);
  const flipped = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
  await assert.rejects(O.open(mine.key, flipped), /altered/);
  await assert.rejects(O.open(mine.key, { v: 1, iv: blob.iv }), /known format/);
  await assert.rejects(O.open(mine.key, { v: 2, iv: blob.iv, ct: blob.ct }), /known format/);
  const wrongIv = { ...blob, iv: Buffer.from(new Uint8Array(12)).toString('base64') };
  await assert.rejects(O.open(mine.key, wrongIv), /altered/);
});

test('guessing is rate limited: four free mistakes, then the wait doubles up to 15 minutes', () => {
  let s = O.freshAttempts();
  const t0 = 1_000_000;
  for (let i = 1; i <= 4; i++) {
    s = O.registerFailure(s, t0);
    assert.equal(O.waitMs(s, t0), 0, 'attempt ' + i + ' is free');
  }
  s = O.registerFailure(s, t0);
  assert.equal(O.waitMs(s, t0), 30000);
  s = O.registerFailure(s, t0);
  assert.equal(O.waitMs(s, t0), 60000);
  s = O.registerFailure(s, t0);
  assert.equal(O.waitMs(s, t0), 120000);
  for (let i = 0; i < 20; i++) s = O.registerFailure(s, t0);
  assert.equal(O.waitMs(s, t0), 15 * 60 * 1000);
  assert.equal(O.waitMs(s, t0 + 15 * 60 * 1000 + 1), 0);
  assert.equal(O.waitMs(null), 0);
});

test('technical data is exported with everything redacted unless an option adds it back', () => {
  const tech = {
    target: 'https://shop.example.com/admin?token=abc',
    responseHeaders: { server: 'nginx/1.18.0', 'set-cookie': 'sid=abc123', authorization: 'Bearer zzz', 'content-security-policy': "default-src 'self'", missing: null },
    requests: [{ method: 'GET', path: '/.env', status: 404, purpose: 'probe' }],
    probes: [{ id: 'env-file', path: '/.env', status: 404 }],
    scripts: [{ path: '/static/app.js', bytes: 100 }],
    cookies: [{ name: 'PHPSESSID', httpOnly: false }],
    traffic: { samples: [{ url: 'https://shop.example.com/api/user/42', status: 200 }] },
    scriptAddresses: ['https://cdn.example.net/lib/jquery-1.8.js'],
  };
  const strict = O.redactTechnical(tech);
  const text = JSON.stringify(strict);
  assert.doesNotMatch(text, /shop\.example\.com|nginx|abc123|zzz|PHPSESSID|\/\.env|\/static\/app\.js|api\/user|cdn\.example\.net|jquery/);
  assert.match(text, /\[host\]/);
  assert.deepEqual(strict.requests, { omitted: 1 });
  assert.deepEqual(strict.cookies, { count: 1 });
  assert.equal(strict.redaction.applied, true);

  const detailed = O.redactTechnical(tech, { hostnames: true, paths: true, headerValues: true, requestLog: true, cookieNames: true });
  const dt = JSON.stringify(detailed);
  assert.match(dt, /shop\.example\.com/);
  assert.match(dt, /nginx\/1\.18\.0/);
  assert.match(dt, /PHPSESSID/);
  assert.match(dt, /\/\.env/);
  assert.doesNotMatch(dt, /abc123|zzz|token=abc/, 'credential-bearing header values and query strings are never exported, whatever the options');
  assert.equal(detailed.responseHeaders['set-cookie'], '[value omitted]');
  assert.equal(tech.target.includes('shop'), true, 'the original object is not modified');
});
