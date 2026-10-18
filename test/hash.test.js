const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sha256 } = require('../lib/hash.js');

test('matches the standard test vectors', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('agrees with Node crypto for many lengths, including the padding boundaries and non-ASCII', () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000]) {
    const s = 'é'.repeat(Math.floor(n / 2)) + 'x'.repeat(n % 2);
    assert.equal(sha256(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), 'length ' + n);
  }
});
