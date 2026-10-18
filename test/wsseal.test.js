const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../lib/owner.js');
const W = require('../lib/wsseal.js');

const item = () => ({ id: 'a1', project: 'p1', kind: 'security', created: 1700000000000, title: 'Report for shop.example', url: 'https://shop.example/', payload: { findings: ['csp-missing'], note: 'secret-ish detail' } });

test('a sealed item hides title, url and payload but keeps the four listing fields', async () => {
  const { key } = await O.createVault('correct horse battery staple');
  const rec = await W.sealItem(key, item());
  assert.deepEqual(Object.keys(rec).sort(), ['created', 'id', 'kind', 'project', 'sealed']);
  const text = JSON.stringify(rec);
  assert.doesNotMatch(text, /shop\.example|csp-missing|secret-ish/);
  assert.deepEqual(await W.revealItem(key, rec), item());
});

test('unsealed records pass through unchanged (existing data stays readable)', async () => {
  const { key } = await O.createVault('correct horse battery staple');
  assert.deepEqual(await W.revealItem(key, item()), item());
  assert.equal(W.isSealed(item()), false);
});

test('a wrong key, a missing key and a tampered record all fail to open', async () => {
  const a = await O.createVault('correct horse battery staple');
  const b = await O.createVault('another long passphrase here');
  const rec = await W.sealItem(a.key, item());
  await assert.rejects(() => W.revealItem(b.key, rec), /different passphrase or has been altered/);
  await assert.rejects(() => W.revealItem(null, rec), O.OwnerLockedError);
  const flipped = JSON.parse(JSON.stringify(rec));
  flipped.sealed.ct = flipped.sealed.ct.slice(0, -4) + (flipped.sealed.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  await assert.rejects(() => W.revealItem(a.key, flipped), O.OwnerAuthError);
});

test('the plaintext listing fields are authenticated: moving or relabelling a record breaks it', async () => {
  const { key } = await O.createVault('correct horse battery staple');
  const rec = await W.sealItem(key, item());
  for (const change of [{ id: 'a2' }, { project: 'p2' }, { kind: 'screenshot' }, { created: 1 }])
    await assert.rejects(() => W.revealItem(key, { ...rec, ...change }), O.OwnerAuthError, JSON.stringify(change));
  // a technical-diagnostics record (no context) cannot be passed off as a workspace item either
  const other = await O.seal(key, { title: 'x' });
  await assert.rejects(() => W.revealItem(key, { id: 'a1', project: 'p1', kind: 'security', created: 1700000000000, sealed: other }), O.OwnerAuthError);
});

test('the locked view shows no content', () => {
  const v = W.lockedView({ ...item(), sealed: {} });
  assert.equal(v.locked, true);
  assert.equal(v.payload, null);
  assert.doesNotMatch(JSON.stringify(v), /shop\.example/);
});

test('contexts do not change how existing sealed technical records open', async () => {
  const { key } = await O.createVault('correct horse battery staple');
  const blob = await O.seal(key, { a: 1 });
  assert.deepEqual(await O.open(key, blob), { a: 1 });
  await assert.rejects(() => O.open(key, blob, 'ws:x'), O.OwnerAuthError);
});

test('canonical() compares records regardless of key order (the migration check depends on it)', async () => {
  const { key } = await O.createVault('correct horse battery staple');
  const original = { title: 'T', id: 'a1', payload: { b: 1, a: [{ y: 1, x: 2 }] }, created: 5, project: 'p', kind: 'k', url: '' };
  const back = await W.revealItem(key, await W.sealItem(key, original));
  assert.notEqual(JSON.stringify(back), JSON.stringify(original), 'plain stringify differs by key order');
  assert.equal(W.canonical(back), W.canonical(original));
  assert.notEqual(W.canonical(back), W.canonical({ ...original, title: 'changed' }));
});
