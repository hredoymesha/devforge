const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/encexport.js');

const PASS = 'correct horse battery';
const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const secret = 'PLAINTEXT-MARKER-7f3a: the page said hello';

test('a file opens with the passphrase it was sealed with, and gives back the same bytes', async () => {
  const sealed = await E.encrypt(bytes(secret), PASS);
  assert.equal(text(await E.decrypt(sealed, PASS)), secret);
});

test('the sealed file does not show the plaintext, and two seals of the same bytes differ', async () => {
  const a = await E.encrypt(bytes(secret), PASS);
  const b = await E.encrypt(bytes(secret), PASS);
  assert.ok(!a.includes('PLAINTEXT-MARKER'));
  assert.notEqual(a, b, 'a new salt and IV each time');
  const h = JSON.parse(a);
  assert.equal(h.format, E.FORMAT);
  assert.equal(h.kdf.iterations, E.ITERATIONS);
});

test('a wrong passphrase gives one clear message and no output', async () => {
  const sealed = await E.encrypt(bytes(secret), PASS);
  await assert.rejects(E.decrypt(sealed, 'a different passphrase'), (e) => {
    assert.equal(e.message, E.WRONG);
    return true;
  });
});

test('editing the header or the data makes the file fail to open', async () => {
  const sealed = await E.encrypt(bytes(secret), PASS);
  const h = JSON.parse(sealed);
  const edited = { ...h, created: '2030-01-01T00:00:00.000Z' };
  await assert.rejects(E.decrypt(JSON.stringify(edited), PASS), new RegExp(E.WRONG.slice(0, 20)));
  const bytesOf = Buffer.from(h.data, 'base64');
  bytesOf[0] ^= 1;
  await assert.rejects(E.decrypt(JSON.stringify({ ...h, data: bytesOf.toString('base64') }), PASS), new RegExp(E.WRONG.slice(0, 20)));
});

test('a passphrase shorter than the minimum is refused before anything is sealed', async () => {
  await assert.rejects(E.encrypt(bytes(secret), 'short'), new RegExp('at least ' + E.MIN_PASSPHRASE));
});

test('a file that is not an export is refused, with a plain message', async () => {
  await assert.rejects(E.decrypt('{"hello":1}', PASS), /not a DevForge encrypted export/);
  await assert.rejects(E.decrypt('not json', PASS), /not a DevForge encrypted export/);
  const sealed = JSON.parse(await E.encrypt(bytes(secret), PASS));
  await assert.rejects(E.decrypt(JSON.stringify({ ...sealed, version: 9 }), PASS), /version 9/);
});

test('a file that asks for an unusual number of key rounds is not opened', async () => {
  const sealed = JSON.parse(await E.encrypt(bytes(secret), PASS));
  sealed.kdf.iterations = 5e9;
  await assert.rejects(E.decrypt(JSON.stringify(sealed), PASS), /unusual number/);
});

test('damaged base64 and wrong lengths are reported as damage', async () => {
  const sealed = JSON.parse(await E.encrypt(bytes(secret), PASS));
  await assert.rejects(E.decrypt(JSON.stringify({ ...sealed, data: 'not base64!' }), PASS), /damaged/);
  await assert.rejects(E.decrypt(JSON.stringify({ ...sealed, cipher: { ...sealed.cipher, iv: 'AAAA' } }), PASS), /damaged/);
});

test('the decrypted copy is named without the encrypted extension', () => {
  assert.equal(E.plainName('part-promo.zip.devforge-enc'), 'part-promo.zip');
  assert.equal(E.plainName('x.json.devforge-enc'), 'x.json');
  assert.equal(E.plainName(''), 'export');
});
