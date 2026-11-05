const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../lib/trusted.js');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function fakeTT() {
  const made = [];
  return {
    made,
    createPolicy(name, rules) {
      made.push(name);
      return {
        createHTML: (s) => ({ trusted: 'html', value: rules.createHTML(s) }),
        createScriptURL: (s) => ({ trusted: 'url', value: rules.createScriptURL(s) }),
      };
    },
  };
}

test('html() and scriptUrl() return plain strings when Trusted Types is not available', () => {
  T.reset();
  assert.equal(T.html('<p>x</p>', null), '<p>x</p>');
  assert.equal(T.html(5, {}), '5');
  assert.equal(T.scriptUrl('a.js', null), 'a.js');
});

test('each policy is created once, with an allowed name', () => {
  T.reset();
  const tt = fakeTT();
  const a = T.html('<b>1</b>', tt);
  const b = T.html('<b>2</b>', tt);
  const c = T.scriptUrl('site/app.js', tt);
  T.scriptUrl('site/two.js', tt);
  assert.deepEqual(tt.made, ['devforge-html', 'devforge-url']);
  assert.equal(a.trusted, 'html');
  assert.equal(b.value, '<b>2</b>');
  assert.equal(c.trusted, 'url');
});

test('html() falls back to the string when the policy cannot be created', () => {
  T.reset();
  const tt = { createPolicy() { throw new TypeError('Policy with name devforge-html already exists'); } };
  assert.equal(T.html('<i>x</i>', tt), '<i>x</i>');
  assert.equal(T.html('<i>y</i>', tt), '<i>y</i>');
});

test('scriptUrl() accepts a saved relative path and refuses anything that leaves the folder', () => {
  const ok = ['site/host/app.js', '../site/h/a%20b.js', 'inline/script-001.js', 'app.js?v=1#x'];
  const bad = ['https://evil.example/x.js', '//evil.example/x.js', 'javascript:alert(1)', 'data:text/javascript,1', 'blob:abc', '\\\\host\\x.js', 'a b.js', '', ' x.js', 'x.js\n', 'a\0.js'];
  for (const s of ok) assert.ok(T.isLocalPath(s), s);
  for (const s of bad) assert.ok(!T.isLocalPath(s), JSON.stringify(s));
  T.reset();
  const tt = fakeTT();
  assert.throws(() => T.scriptUrl('https://evil.example/x.js', tt), TypeError);
  assert.equal(T.scriptUrl('site/app.js', tt).value, 'site/app.js');
});

test('the manifest enforces Trusted Types and allows only these policy names', () => {
  const csp = JSON.parse(read('manifest.json')).content_security_policy.extension_pages;
  assert.match(csp, /require-trusted-types-for 'script'/);
  const names = (csp.match(/trusted-types ([^;]+)/) || [])[1].trim().split(/\s+/);
  assert.deepEqual(names.sort(), [...T.NAMES].sort());
});

// A new HTML sink would be refused by the browser at run time. This catches it before that, in
// every file that runs in an extension page. Build DOM with h(); if a string must be parsed,
// pass it through DFTrusted.html() and say why next to it.
test('no extension-page file writes to an HTML sink', () => {
  // sandbox.js is left out: the Playground page has its own sandbox policy.
  const files = ['background.js']
    .concat(fs.readdirSync(path.join(root, 'panel')).map((f) => 'panel/' + f))
    .concat(fs.readdirSync(path.join(root, 'lib')).filter((f) => !/^(acorn|beautifier)/.test(f)).map((f) => 'lib/' + f));
  const sinks = [
    /\.(innerHTML|outerHTML)\s*(\+|\|\||\?\?)?=(?!=)/,
    /\binsertAdjacentHTML\s*\(/,
    /\bdocument\.write(ln)?\s*\(/,
    /\bcreateContextualFragment\s*\(/,
    /\.srcdoc\s*=(?!=)/,
    /\.setAttribute\(\s*['"]srcdoc['"]/,
    /\bsrcdoc\s*:\s*(?!\s|DFTrusted\.html\()/,
    /\bnew\s+DOMParser\(\)\.parseFromString\(\s*(?!\s|trusted\b)/,
  ];
  const hits = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      if (sinks.some((re) => re.test(line))) hits.push(f + ':' + (i + 1) + ': ' + line.trim().slice(0, 80));
    });
  }
  assert.deepEqual(hits, []);
});

test('the sink check really finds a sink', () => {
  const srcdoc = /\bsrcdoc\s*:\s*(?!\s|DFTrusted\.html\()/;
  assert.ok(srcdoc.test("h('iframe', { srcdoc: b.doc })"));
  assert.ok(!srcdoc.test("h('iframe', { srcdoc: DFTrusted.html(b.doc) })"));
  const re = /\.(innerHTML|outerHTML)\s*(\+|\|\||\?\?)?=(?!=)/;
  assert.ok(re.test('el.innerHTML = x;'));
  assert.ok(re.test('el.innerHTML += x;'));
  assert.ok(!re.test('if (el.innerHTML === x) {}'));
});
