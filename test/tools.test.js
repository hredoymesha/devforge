const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the decrypt page makes no network request and runs no dynamic code', () => {
  for (const f of ['tools/decrypt.html', 'tools/decrypt.js', 'lib/encexport.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/, f);
    assert.doesNotMatch(src, /\beval\s*\(|new Function|setTimeout\s*\(\s*['"]/, f);
    assert.doesNotMatch(src, /https?:\/\//, f + ' has a web address');
  }
});

test('the decrypt page loads only its own script and the encryption library, from this folder', () => {
  const html = read('tools/decrypt.html');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['../lib/encexport.js', 'decrypt.js']);
  assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/, 'no inline script');
  assert.doesNotMatch(html, /<link[^>]+href="(?!#)[^"]*\/\//, 'no external stylesheet');
  assert.match(html, /works without a network connection/);
});

test('the decrypt page is not in the extension package, so it runs as a plain local file', () => {
  const pkg = read('scripts/package.js');
  const list = pkg.match(/const EXTENSION = \[([^\]]*)\]/)[1];
  assert.doesNotMatch(list, /tools/);
});
