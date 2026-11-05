const test = require('node:test');
const assert = require('node:assert/strict');
const Site = require('../lib/site.js');
const Zip = require('../lib/zip.js');

const MAP = new Map([[Site.norm('https://a.example/img/a.png'), 'site/a.example/img/a.png']]);
const rewrite = (css) => Site.rewriteCss(css, 'https://a.example/s/x.css', 'site/a.example/s/x.css', MAP);

test('cssUrlTokens reads quoted, unquoted and spaced url() tokens and reports their span', () => {
  const css = 'a{background:url(a.png)} b{background:URL( "b.png" )} c{background:url(\'c.png\')}';
  const toks = Site.cssUrlTokens(css);
  assert.deepEqual(toks.map((t) => t.value), ['a.png', 'b.png', 'c.png']);
  for (const t of toks) assert.match(css.slice(t.start, t.end), /^url\(/i);
  assert.equal(css.slice(toks[1].start, toks[1].end), 'URL( "b.png" )');
});

test('cssUrlTokens skips tokens that never close, are empty, or are too long', () => {
  assert.deepEqual(Site.cssUrlTokens('url(').length, 0);
  assert.deepEqual(Site.cssUrlTokens('url("abc').length, 0);
  assert.deepEqual(Site.cssUrlTokens('url()').length, 0);
  assert.deepEqual(Site.cssUrlTokens('url(   )').length, 0);
  assert.deepEqual(Site.cssUrlTokens('url("a\nb")').length, 0, 'a quoted value cannot span a line');
  assert.deepEqual(Site.cssUrlTokens('url(' + 'a'.repeat(3000) + ')').length, 0);
  assert.equal(Site.cssUrlTokens('url(' + 'a'.repeat(2000) + ')').length, 1);
  // a token that never closes does not hide the one after it
  assert.deepEqual(Site.cssUrlTokens('url("x url(ok.png)').map((t) => t.value), ['ok.png']);
});

test('rewriteCss points saved files at their local copy, in any letter case and quote style', () => {
  for (const css of ['a{b:url(/img/a.png)}', 'a{b:URL("/img/a.png")}', "a{b:url( '/img/a.png' )}"]) {
    assert.match(rewrite(css), /\{b:url\("\.\.\/\.\.\/\.\.\/img\/a\.png"\)\}$|url\("[^"]*img\/a\.png"\)/, css);
  }
  assert.equal(rewrite('a{b:url(/img/other.png)}'), 'a{b:url(/img/other.png)}');
  assert.equal(rewrite('a{b:url(data:image/png;base64,AAAA)}'), 'a{b:url(data:image/png;base64,AAAA)}');
});

test('discoverCssUrls lists web addresses once, ignores data: and fragments', () => {
  const css = '@import "/more.css"; a{b:url(/i.png)} c{d:url("/i.png")} e{f:url(data:x)} g{h:url(#frag)} @import url("https://cdn.example/f.css");';
  assert.deepEqual(Site.discoverCssUrls(css, 'https://a.example/s/x.css').sort(), ['https://a.example/i.png', 'https://a.example/more.css', 'https://cdn.example/f.css']);
});

test('regression: a stylesheet of "url(" and spaces no longer freezes the rewrite', () => {
  const hostile = 'url(' + ' '.repeat(8000);
  const t = Date.now();
  Site.rewriteCss(hostile, 'https://a.example/x.css', 'x.css', MAP);
  Site.discoverCssUrls(hostile, 'https://a.example/x.css');
  // With the old regular expression this took more than eight seconds for 8 KB.
  assert.ok(Date.now() - t < 500, 'took ' + (Date.now() - t) + ' ms');
});

test('regression: file names cannot carry control or direction-changing characters', () => {
  const rlo = String.fromCharCode(0x202e);
  assert.ok(!Site.sanitizePath('photo' + rlo + 'gpj.exe').includes(rlo));
  assert.equal(Site.sanitizePath('a/b' + String.fromCharCode(0) + 'c'), 'a/b_c');
});

test('regression: ZIP entry names drop NUL and direction controls, trailing dots and colons', async () => {
  const names = async (paths) => {
    const buf = Buffer.from(await Zip.build(paths.map((p) => ({ path: p, data: 'x' }))).arrayBuffer());
    const out = [];
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let p = buf.readUInt32LE(end + 16);
    for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
      const n = buf.readUInt16LE(p + 28);
      out.push(buf.subarray(p + 46, p + 46 + n).toString('utf8'));
      p += 46 + n + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    return out;
  };
  assert.deepEqual(await names(['a/..\u0000b', 'a/.. /b', 'a/.../b', 'x\u202egpj.exe']), ['a/..b', 'a/b', 'a/b (2)', 'xgpj.exe']);
  assert.deepEqual(await names(['..\u0000/x', '.\u0000./y']), ['x', 'y']);
  assert.deepEqual(await names(['c:x.txt', 'C:\\win\\f.txt', '.\\/..\\c:C:<', 'a.txt:stream']), ['x.txt', 'win/f.txt', 'c_C_<', 'a.txt_stream']);
});
