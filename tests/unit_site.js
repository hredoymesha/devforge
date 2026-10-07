const S = require('../lib/site.js');
let f = 0;
const t = (n, c, d) => {
  console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + JSON.stringify(d)));
  if (!c) f++;
};
const bads = [
  '../../etc/passwd',
  '/etc/passwd',
  '..\\..\\windows\\system32',
  'C:\\Users\\x\\a.js',
  'webpack:///./src/../../../evil.js',
  'file:///etc/shadow',
  'a/./b/../c.js',
  'con.js',
  '....//....//x',
  '%2e%2e%2fsecret',
  '%2e%2e%5csecret',
  '..%2f..%2fetc%2fpasswd',
  'a\u0000b.js',
  '%00',
  '%2F%2Fevil',
  '~/x',
  '\u202e/evil',
];
for (const bad of bads) {
  const p = S.sanitizePath(bad);
  t(
    'sanitizePath neutral: ' + JSON.stringify(bad) + ' -> ' + p,
    !p.startsWith('/') &&
      !p.split('/').includes('..') &&
      !/^[a-z]:/i.test(p) &&
      !/[\u0000:\\]/.test(p) &&
      p.length > 0 &&
      !p.split('/').some((x) => /^\.+$/.test(x)),
    p
  );
}
t('webpack path', S.sanitizePath('webpack:///./src/app/a.js') === 'src/app/a.js');
const used = new Map();
const a = S.urlToPath('https://x.com/a/b.js', used),
  b = S.urlToPath('https://x.com/a/b.js?v=2', used),
  c = S.urlToPath('https://x.com/A/B.JS', used);
S.urlToPath('https://x.com/a', used);
S.urlToPath('https://x.com/a/', used);
const g = S.urlToPath('https://x.com:8080/', used);
t(
  'distinct paths for query & case variants',
  new Set([a, b, c].map((x) => x.toLowerCase())).size === 3,
  [a, b, c]
);
t(
  'no path is a prefix-directory of another file',
  ![...used.keys()].some((k) => [...used.keys()].some((o) => o !== k && o.startsWith(k + '/'))),
  [...used.keys()]
);
t('port sanitized', g.startsWith('site/x.com_8080/'), g);
t('idempotent for same url', S.urlToPath('https://x.com/a/b.js', used) === a);
for (const u of [
  'https://x.com/%2e%2e/%2e%2e/etc/passwd',
  'https://x.com/a/..%2f..%2fb',
  'https://x.com/a%00b',
  'https://x.com/CON',
  'https://x.com/' + 'a'.repeat(400) + '.js',
]) {
  const p = S.urlToPath(u, used);
  t(
    'urlToPath safe: ' + u.slice(0, 50),
    p.startsWith('site/') &&
      !p.split('/').includes('..') &&
      !/[\u0000\\:]/.test(p) &&
      p.split('/').every((s) => s.length <= 110),
    p
  );
}
t(
  'relPath',
  S.relPath('site/h/css/a.css', 'site/h/img/b.png') === '../img/b.png' &&
    S.relPath('index.html', 'site/h/a.js') === 'site/h/a.js' &&
    S.relPath('site/h/a.css', 'site/h/b.png') === 'b.png'
);
const map = new Map([
  ['https://x.com/img/p.png', 'site/x.com/img/p.png'],
  ['https://x.com/f/o.woff2', 'site/x.com/f/o.woff2'],
]);
const css = S.rewriteCss(
  'a{background:url(../img/p.png)} @font-face{src:url("/f/o.woff2?x") } b{background:url(data:image/png;base64,AAA)} c{background:url(https://other.com/z.png)}',
  'https://x.com/css/a.css',
  'site/x.com/css/a.css',
  map
);
t(
  'css rewrite maps known, keeps unknown/data/query-variants',
  css.includes('url("../img/p.png")') &&
    css.includes('data:image/png') &&
    css.includes('https://other.com/z.png') &&
    css.includes('/f/o.woff2?x'),
  css
);
const want = ['https://x.com/css/b.css', 'https://x.com/css/i.png', 'https://cdn.y.com/f.woff2']
    .sort()
    .join(),
  got = S.discoverCssUrls(
    '@import "b.css"; a{background:url(i.png)} @font-face{src:url("//cdn.y.com/f.woff2")}',
    'https://x.com/css/a.css'
  )
    .sort()
    .join();
t('css url discovery', got === want, got);
t(
  'sourcemap url',
  S.sourceMapUrlOf('var a=1;\n//# sourceMappingURL=app.js.map') === 'app.js.map' &&
    S.sourceMapUrlOf('var a') === null
);
const ms = S.mapSources(
  JSON.stringify({
    version: 3,
    sources: ['../../evil.js', 'webpack:///./src/a.js', '/abs/b.js', 'nocontent.js', 'src/a.js'],
    sourcesContent: ['E', 'A', 'B', null, 'A2'],
  }),
  'https://x.com/a.map'
);
t(
  'map sources sanitized + deduped + skips missing content',
  ms.files.length === 4 &&
    ms.skippedNoContent === 1 &&
    ms.files.every((f) => !f.path.includes('..') && !f.path.startsWith('/')) &&
    new Set(ms.files.map((f) => f.path.toLowerCase())).size === 4,
  ms
);
t('invalid map handled', S.mapSources('not json', 'u').error === 'invalid source map JSON');
t(
  'map file caps honored',
  S.mapSources(JSON.stringify({ sources: ['a', 'b', 'c'], sourcesContent: ['1', '2', '3'] }), 'u', {
    maxFiles: 2,
  }).files.length === 2
);
const Safe = require('../lib/safe.js');
const E = (v) => Safe.csvEsc(v);
for (const [i, exp] of [
  ['=1+1', "'=1+1"],
  ['+SUM(A1)', "'+SUM(A1)"],
  ['-2+3', "'-2+3"],
  ['@cmd', "'@cmd"],
  ['  =HYPERLINK("x")', '"\'  =HYPERLINK(""x"")"'],
  ['\t=1', "'\t=1"],
  ['|calc', "'|calc"],
  ['-5', '-5'],
  ['+3.2', '+3.2'],
  ['hello', 'hello'],
  ['a,b', '"a,b"'],
  ['x=1', 'x=1'],
  ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
])
  t('csv ' + JSON.stringify(i), E(i) === exp, E(i));
const R = (e) => new Function('S', 'with(S){return ' + e + '}')(Safe);
t(
  'redactUrl',
  R("redactUrl('https://a.com/x?token=abc&q=1&api_key=Z')").includes('token=[redacted]') &&
    R("redactUrl('https://a.com/x?token=abc&q=1')").includes('q=1') &&
    R("redactUrl('https://u:p@a.com/')") === 'https://a.com/' &&
    R("redactUrl('https://a.com/x?q=1')") === 'https://a.com/x?q=1'
);
t(
  'redactBody json nested',
  R('redactBody(\'{"user":"bob","password":"p","n":{"accessToken":"t","ok":1}}\')').includes(
    'bob'
  ) && !R('redactBody(\'{"password":"p","n":{"accessToken":"tt"}}\')').match(/\"p\"|tt/)
);
t(
  'redactBody form',
  R("redactBody('user=bob&password=hunter2&x=1')") === 'user=bob&password=[redacted]&x=1'
);
t(
  'redactBody truncated json',
  !R('redactBody(\'{"a":1,"password":"hunter2","b":"trunc\')').includes('hunter2')
);
t('redactBody plain text untouched', R("redactBody('hello world')") === 'hello world');
for (const h of [
  'localhost',
  '127.0.0.1',
  '10.1.2.3',
  '192.168.0.5',
  '172.16.0.1',
  '172.31.9.9',
  '169.254.169.254',
  '100.64.0.1',
  '::1',
  '[::1]',
  'fd00::1',
  'fe80::1',
  'foo.local',
  'a.internal',
  '::ffff:127.0.0.1',
])
  t('private host ' + h, R('isPrivateHost(' + JSON.stringify(h) + ')') === true);
for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '1.1.1.1', 'cdn.x.org'])
  t('public host ' + h, R('isPrivateHost(' + JSON.stringify(h) + ')') === false);
t(
  'blocksPrivate: public page -> private target blocked',
  R("blocksPrivate('http://192.168.1.1/x','https://example.com/')") === true
);
t(
  'blocksPrivate: same private host allowed',
  R("blocksPrivate('http://127.0.0.1:99/x','http://127.0.0.1:5/')") === false
);
t(
  'blocksPrivate: public -> public fine',
  R("blocksPrivate('https://cdn.com/x','https://example.com/')") === false
);
process.exit(f);
