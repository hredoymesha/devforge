/*
 * Local training sites for the browser tests. Nothing here is a real credential: provider-looking
 * strings are assembled at runtime so secret scanners do not flag this file.
 *
 *   vuln  an intentionally weak site (missing headers, exposed files, risky patterns)
 *   spa   a well-configured single-page app that answers EVERY path with its HTML shell and a 200,
 *         used to prove that a catch-all page is not mistaken for an exposed file
 *   sink  a "private" target that a redirect tries to reach; it must never be fetched
 *   demo  an ordinary, well-built page used to test exports: a card component with inline SVG,
 *         handlers, media queries, keyframes, a web font, a manifest, JSON-LD, a lazy-loaded script
 *         and a source map
 *
 * Each server records every request (method, path, whether cookies or authorization were sent)
 * so tests can assert what the scanner really did on the wire.
 */
const http = require('node:http');

// Files served for the /demo/hardening page. The hash of known.js is what its tag already declares.
const VENDOR = {
  lib: 'window.__lib = 1;\n',
  css: '.lib { margin: 0; }\n',
  known: 'window.__known = true;\n',
  stale: 'window.__stale = 2;\n',
  inlineStyle: '.inline { color: red }',
  inlineScript: "var inlineKey = '" + 'sk_live_' + "a1B2c3D4e5F6g7H8i9J0k1L2'; fetch('TP/vendor/data.json').catch(function () {});",
};
VENDOR.knownIntegrity = 'sha384-' + require('node:crypto').createHash('sha384').update(VENDOR.known).digest('base64');

// Control names that shadow properties of the form that holds them (see the /demo/clobber page).
const CLOBBER_NAMES = ['tagName', 'attributes', 'getAttribute', 'hasAttribute', 'setAttribute', 'removeAttribute', 'children', 'childNodes', 'firstChild', 'lastChild', 'nextSibling', 'previousSibling', 'parentElement', 'parentNode', 'querySelector', 'querySelectorAll', 'matches', 'closest', 'contains', 'getRootNode', 'remove', 'cloneNode', 'getBoundingClientRect', 'textContent', 'classList', 'localName', 'nodeName', 'shadowRoot', 'id', 'className', 'style', 'nodeType', 'innerHTML', 'outerHTML', 'action', 'method', 'elements', 'length', 'name', 'autocomplete', 'target', 'enctype', 'title', 'lang', 'dir', 'hidden'];
const FAKE = {
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  stripe: 'sk_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
  dbPassword: 'fixture-not-a-real-secret',
};

function listen(handler) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ method: req.method, url: req.url, cookie: !!req.headers.cookie, auth: !!req.headers.authorization, t: Date.now() });
    handler(req, res, new URL(req.url, 'http://x'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, log })));
}

const html = (res, body, headers = {}, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
};
const text = (res, body, type = 'text/plain', status = 200) => {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
};

async function startFixtures() {
  let vulnPort = 0;
  const vulnFixed = { git: false }; // a test can switch an exposure off to see the re-check say "fixed"
  let versionedBody = 'one';
  const sink = await listen((req, res) => text(res, 'SECRET-FROM-PRIVATE-HOST'));

  const vuln = await listen((req, res, u) => {
    const p = u.pathname;
    if (p === '/') {
      const q = u.searchParams.get('q') || '';
      return html(
        res,
        `<!doctype html><html><head><title>Training shop</title><meta name="generator" content="WordPress 5.0">
<script src="http://example.com:${vulnPort}/static/third-party.js"></script><script src="/static/jquery-1.12.4.min.js"></script><script src="/app.js?v=3"></script></head><body>
<!-- TODO: remove admin password before launch -->
<form action="/login" method="get"><input name="user"><input type="password" name="pw"><button>Sign in</button></form>
<form action="/save" method="post"><input name="title"><button>Save</button></form>
<a href="/go?next=https://evil.example/landing">leave</a> <a href="/user/42">profile</a> <a href="/cb?access_token=zzz">cb</a>
<input value="${q}"><script>var echo="${q}"; document.getElementById('x') && (document.getElementById('x').innerHTML = location.hash);</script>
<button onclick="void 0">inline</button></body></html>`,
        {
          server: 'nginx/1.18.0',
          'x-powered-by': 'PHP/7.4.3',
          'set-cookie': ['PHPSESSID=abc123; Path=/', 'theme=dark; Path=/'],
        }
      );
    }
    if (p === '/app.js') return text(res, `var apiKey="${FAKE.aws}";var s="${FAKE.stripe}";console.log("app");\n//# sourceMappingURL=app.js.map`, 'application/javascript');
    if (p === '/app.js.map') return text(res, '{"version":3,"sources":["src/app.js"],"names":[],"mappings":"AAAA"}', 'application/json');
    if (p === '/static/third-party.js') return text(res, 'void 0', 'application/javascript');
    if (p === '/static/jquery-1.12.4.min.js') return text(res, '/*! jQuery v1.12.4 */window.jQuery=function(){};', 'application/javascript');
    if (p === '/.git/HEAD' && !vulnFixed.git) return text(res, 'ref: refs/heads/main\n');
    if (p === '/.env') return text(res, `APP_NAME=demo\nDB_PASSWORD=${FAKE.dbPassword}\nAPI_TOKEN=abcdef0123456789\n`);
    if (p === '/uploads/') return html(res, '<html><head><title>Index of /uploads</title></head><body><h1>Index of /uploads</h1></body></html>');
    if (p === '/phpinfo.php') return html(res, '<html><head><title>phpinfo()</title></head><body>PHP Version 7.4.3</body></html>');
    if (p === '/admin/') return html(res, '<html><body><form><input type="password" name="p"></form></body></html>');
    if (p === '/robots.txt') return text(res, 'User-agent: *\nDisallow: /admin-backup/\nDisallow: /search\n');
    if (p === '/redir') {
      res.writeHead(302, { location: `http://127.0.0.1:${sink.port}/secret` });
      return res.end();
    }
    if (p === '/slow') return text(res, 'slow ok');
    if (p === '/hostile')
      // A page that tries to catch a key handshake from its very first script, then spoofs later.
      return html(
        res,
        `<!doctype html><html><head><script>
window.__stolen = [];
for (const ev of ['devforge:net-key', 'devforge:bridge-ready', 'devforge:netcap-ready'])
  document.addEventListener(ev, (e) => window.__stolen.push([ev, e.detail || null]), true);
</script></head><body><h1>hostile</h1></body></html>`
      );
    if (p === '/versioned-set') {
      versionedBody = u.searchParams.get('v') || 'one';
      return text(res, 'set ' + versionedBody);
    }
    if (p === '/versioned') {
      // cacheable for an hour with a validator: a cache that is trusted blindly keeps serving the old body
      const etag = '"' + versionedBody + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'max-age=3600' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain', etag, 'cache-control': 'max-age=3600' });
      return res.end('body-' + versionedBody);
    }
    if (p === '/agent-hostile') {
      const bigStyle = 'background:' + 'url('.repeat(20000);
      return html(
        res,
        `<!doctype html><title>agent hostile</title>
<style>@import url("data:text/css,a{color:red}"); #p{color:blue} @font-face{font-family:x;src:url("http://[")}</style>
<p id="p" title='a\\"] , *[x="'>text</p>
<div id="big" style="${bigStyle}">x</div>
<script src="http://["></script>
<a id="js" href="java&#9;script:alert(1)" onclick="x()">js</a>
<iframe id="fr" srcdoc="<script>1</script>"></iframe>
<button id="bt" formaction="jav&#10;ascript:1">b</button>
<meta http-equiv="refresh" content="999;url=http://x/">
<div id="host"></div>
<script>var n=document.createElement('noscript');n.appendChild(document.createTextNode('</noscript><img src=x onerror=alert(1)>'));document.getElementById('host').appendChild(n)</script>`
      );
    }
    if (p === '/links')
      return html(
        res,
        `<!doctype html><title>links</title>
<a id="plain" href="https://other.example/a" target="_blank">implicit noopener</a>
<a id="explicit" href="https://other.example/b" target="_blank" rel="noopener">explicit</a>
<a id="opener" href="https://other.example/c" target="_blank" rel="opener">opener on</a>
<a id="named" href="https://other.example/d" target="popup">named</a>
<a id="named-safe" href="https://other.example/e" target="popup" rel="noreferrer">named safe</a>
<a id="same" href="/x" target="popup" rel="opener">same origin</a>`
      );
    if (p === '/hostile-proto')
      // Runs first thing (after document_start scripts) and poisons the built-ins an entry point might
      // use on its secret, recording any 64-hex-digit string that passes through them.
      return html(
        res,
        `<!doctype html><html><head><script>
window.__seen = [];
const strVal = String.prototype.valueOf, objStr = Object.prototype.toString;
const text = (v) => (typeof v === 'string' ? v : v instanceof String ? strVal.call(v) : '');
const re = /[0-9a-f]{64}/, rApply = Reflect.apply, reTest = RegExp.prototype.test, some = Array.prototype.some, push = Array.prototype.push;
let busy = false; // the hooks use the very built-ins they hook; call everything through the saved Reflect.apply
const looks = (v) => rApply(reTest, re, [text(v)]);
const hook = (obj, name) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function (...a) {
    if (!busy) {
      busy = true;
      try {
        if (looks(this) || rApply(some, a, [looks])) rApply(push, window.__seen, [name]);
      } finally {
        busy = false;
      }
    }
    return rApply(orig, this, a);
  };
};
for (const n of ['charCodeAt', 'charAt', 'codePointAt', 'slice', 'substring', 'substr', 'indexOf', 'split', 'startsWith', 'endsWith', 'includes', 'at', 'normalize', 'toString', 'valueOf', 'localeCompare', 'concat', 'padStart', 'padEnd', 'repeat', 'replace', 'match', 'trim', 'toLowerCase', 'toUpperCase'])
  hook(String.prototype, n);
for (const n of ['join', 'map', 'push', 'slice', 'concat', 'indexOf', 'includes', 'forEach', 'every', 'some', 'filter', 'reduce', 'from']) hook(Array.prototype, n);
hook(JSON, 'stringify'); hook(JSON, 'parse');
hook(Function.prototype, 'call'); hook(Function.prototype, 'apply'); hook(Function.prototype, 'bind');
hook(Object, 'keys'); hook(Object, 'entries'); hook(Object, 'assign');
hook(Object.prototype, 'hasOwnProperty'); hook(Object.prototype, 'toString');
hook(Map.prototype, 'get'); hook(Map.prototype, 'set'); hook(Set.prototype, 'has'); hook(Set.prototype, 'add');
hook(Array, 'from');
const so = Object.getOwnPropertyDescriptor(Symbol.prototype, 'toString');
</script></head><body><h1>hostile prototypes</h1></body></html>`
      );
    if (p === '/hostile-slow') {
      // Streams the head at once and a second script 1.2 s later, so DevForge can be injected while
      // the document is still loading. The late script tries to complete the handshake itself.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<!doctype html><html><head><title>slow</title></head><body><h1>slow hostile</h1>');
      return setTimeout(() => {
        res.end(`<script>
window.__late = [];
document.addEventListener('devforge:net-key', (e) => window.__late.push(String(e.detail)), true);
document.dispatchEvent(new CustomEvent('devforge:bridge-ready'));
document.dispatchEvent(new CustomEvent('devforge:netcap-ready'));
</script></body></html>`);
      }, 1200);
    }
    if (p === '/.well-known/security.txt') return text(res, 'not found', 'text/plain', 404);
    return text(res, '<h1>Not Found</h1>', 'text/html', 404);
  });


  // Bytes that look like a font and an image, so downloads have real binary content to carry.
  const FONT_BYTES = Buffer.from('774f4632000100000000000000000000', 'hex');
  const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  const demo = await listen((req, res, u) => {
    const p = u.pathname;
    const bin = (body, type) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (p === '/demo' || p === '/demo/')
      return html(
        res,
        `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Harbor Coffee</title>
<meta name="description" content="Small-batch coffee, roasted weekly.">
<link rel="icon" href="/demo/favicon.png">
<link rel="manifest" href="/demo/app.webmanifest">
<link rel="stylesheet" href="/demo/site.css">
<style>:root{--brand:#7a3e12;--radius:10px}.promo{border-radius:var(--radius)}@media (max-width:600px){.promo{padding:8px}}</style>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"CafeOrCoffeeShop","name":"Harbor Coffee"}</script>
<script src="/demo/app.js"></script>
</head><body>
<header class="top"><nav aria-label="Main"><a href="/demo/">Home</a> <a href="/demo/menu">Menu</a></nav></header>
<main>
<section id="promo" class="promo" data-track="promo">
  <h2 class="promo-title">Autumn blend</h2>
  <p class="promo-text">Roasted this week.</p>
  <img class="promo-img" src="/demo/bean.png" alt="Coffee bean" width="48" height="48">
  <svg class="icon" viewBox="0 0 24 24" width="24" height="24" role="img" aria-label="Arrow"><path d="M3 12h18"/></svg>
  <form class="promo-form" action="/demo/subscribe" method="post"><label>Email <input name="email" type="email" required></label><button class="buy" type="submit" onclick="buy('autumn')" data-sku="A-1">Buy now</button></form>
</section>
<section class="other"><h2>About</h2><p>We roast in small batches.</p></section>
</main>
<script>function buy(sku){ window.__bought = sku; }</script>
<script>document.querySelector('.promo-title').addEventListener('click', function () { this.classList.toggle('open'); });</script>
<script>const s=document.createElement('script');s.src='/demo/lazy.js';document.body.append(s);navigator.serviceWorker&&navigator.serviceWorker.register('/demo/sw.js',{scope:'/demo/'}).catch(()=>{});</script>
</body></html>`
      );
    if (p === '/demo/site.css')
      return text(
        res,
        `@font-face{font-family:"Brand";src:url(/demo/brand.woff2) format("woff2")}
body{font-family:"Brand",Georgia,serif;margin:0;color:#222}
.top{background:#f4ece4;padding:8px 16px}
.promo{background:#fff8f0 url(/demo/hero.png) no-repeat right top;padding:16px;animation:pulse 3s infinite}
.promo .buy{background:var(--brand);color:#fff;border:0;padding:6px 12px}
.promo .buy:hover{filter:brightness(1.1)}
.other{padding:16px}
@keyframes pulse{from{opacity:.9}to{opacity:1}}
/*# sourceMappingURL=site.css.map */`,
        'text/css'
      );
    if (p === '/demo/site.css.map') return text(res, '{"version":3,"sources":["src/site.scss"],"sourcesContent":["$brand: #7a3e12;\\n.promo { color: $brand; }"],"names":[],"mappings":"AAAA"}', 'application/json');
    if (p === '/demo/app.js')
      return text(
        res,
        `function trackPageview(){ return fetch('/demo/analytics', { method: 'POST' }); }
function unrelatedHelper(a, b){ return a + b; }
const promo = document.querySelector('#promo');
promo.dataset.ready = '1';
function highlightBuy(){ document.querySelectorAll('.buy').forEach(function (b) { b.style.outline = '1px solid'; }); }
function formatPrice(n){ return '$' + n.toFixed(2); }
//# sourceMappingURL=app.js.map`,
        'application/javascript'
      );
    if (p === '/demo/app.js.map') return text(res, '{"version":3,"sources":["src/app.js"],"sourcesContent":["export const promo = document.querySelector(\'#promo\');"],"names":[],"mappings":"AAAA"}', 'application/json');
    if (p === '/demo/lazy.js') return text(res, 'window.__lazy = "loaded";', 'application/javascript');
    if (p === '/demo/sw.js') return text(res, "self.addEventListener('fetch', function () {});", 'application/javascript');
    if (p === '/demo/app.webmanifest') return text(res, '{"name":"Harbor Coffee","short_name":"Harbor","start_url":"/demo/","display":"standalone"}', 'application/manifest+json');
    if (p === '/demo/brand.woff2') return bin(FONT_BYTES, 'font/woff2');
    if (p === '/demo/bean.png' || p === '/demo/hero.png' || p === '/demo/favicon.png') return bin(PNG_BYTES, 'image/png');
    if (/^\/demo\/img\/[\w-]+\.png$/.test(p)) return bin(PNG_BYTES, 'image/png');
    if (p === '/demo/rich')
      return html(
        res,
        `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Rich parts</title>
<link rel="stylesheet" href="/demo/rich.css">
<script>
class FancyCard extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.inner{color:#a00;padding:6px;background:url(/demo/img/shadow-bg.png)}button{font-weight:700}</style><div class="inner"><slot></slot><button class="go">Go</button></div>';
  }
}
customElements.define('fancy-card', FancyCard);
</script></head><body>
<main>
<section id="rich" class="rich">
  <picture><source srcset="/demo/img/bean-2x.png 2x, /demo/img/bean-1x.png 1x" media="(min-width:1px)"><img id="pic" src="/demo/img/bean-1x.png" srcset="/demo/img/bean-1x.png 1x, /demo/img/bean-2x.png 2x" alt="Bean" width="40" height="40"></picture>
  <video id="clip" poster="/demo/img/poster.png" width="80" height="45" muted><source src="/demo/img/clip.mp4" type="video/mp4"></video>
  <div class="badge" style="background-image:url(/demo/img/badge.png)">New</div>
  <p class="note">Fresh</p>
  <fancy-card id="card"><span class="slotted">Hello</span></fancy-card>
  <div class="vue-like" data-v-7ba5bd90 _ngcontent-abc-c12>Scoped</div>
</section>
</main></body></html>`
      );
    if (p === '/demo/rich.css')
      return text(
        res,
        `.rich{font-family:Georgia,serif;color:#333;line-height:1.4}
.rich .badge{background-size:cover;padding:4px;mask-image:url(/demo/img/mask.png)}
.rich .note::before{content:url(/demo/img/icon-before.png)}
.rich .vue-like[data-v-7ba5bd90]{color:#06c}
.unrelated-sheet-rule{color:red}`,
        'text/css'
      );
    // A page with fake credentials in an inline script and in a script file, for the Secrets check.
    if (p === '/demo/leaky')
      return html(
        res,
        '<!doctype html><html><head><title>Leaky</title></head><body><div id="cfg" class="cfg">Settings</div>' +
          "<script>function initCfg(){ var el = document.querySelector('#cfg'); el.setAttribute('data-k', '" + FAKE.stripe + "'); }</script>" +
          '<script src="/demo/leaky.js"></script></body></html>'
      );
    if (p === '/demo/leaky.js') return text(res, 'window.cfg = { awsKeyId: "' + FAKE.aws + '" };', 'application/javascript');
    // Elements named after built-in properties (DOM clobbering), and an inline script that uses the
    // id DevForge once used for its own bridge script.
    if (p === '/demo/clobber')
      return html(
        res,
        '<!doctype html><html><head><title>Clobber</title></head><body>' +
          '<form id="f1" action="/submit" method="post" autocomplete="off">' +
          CLOBBER_NAMES.map((n) => '<input name="' + n + '" value="v">')
            .join('') +
          '<input type="password" name="pw"><input type="file" name="up"></form>' +
          '<form name="querySelectorAll"></form><img name="forms"><img name="getElementById"><embed name="body"><form name="documentElement"></form>' +
          '<img name="cookie"><img name="createElement"><img name="head"><img name="querySelector">' +
          '<script id="__df_bridge">window.__hiddenByName = "inline code that must be listed";</script>' +
          '</body></html>'
      );
    // Third-party files for the Hardening helpers: the page is on 127.0.0.1 and loads them from
    // example.com (mapped to 127.0.0.1 by the browser flag), so they count as another origin.
    if (p === '/demo/hardening') {
      const tp = 'http://example.com:' + String(req.headers.host).split(':')[1];
      const lo = 'http://localhost:' + String(req.headers.host).split(':')[1];
      return html(
        res,
        '<!doctype html><html><head><title>Hardening</title>' +
          '<link rel="stylesheet" href="' + tp + '/vendor/lib.css">' +
          '<script src="' + tp + '/vendor/lib.js"></script>' +
          '<script src="' + tp + '/vendor/known.js" integrity="' + VENDOR.knownIntegrity + '" crossorigin="anonymous"></script>' +
          '<script src="' + tp + '/vendor/stale.js" integrity="sha384-' + 'A'.repeat(64) + '" crossorigin="anonymous"></script>' +
          '<script src="' + tp + '/vendor/changing.js" async></script>' +
          '<script src="' + lo + '/vendor/lib.js"></script>' +
          '<style>' + VENDOR.inlineStyle + '</style></head><body><h1>Hardening</h1>' +
          '<img src="' + tp + '/vendor/pic.png" alt="">' +
          '<div id="styled" style="color:blue">x</div>' +
          '<script>' + VENDOR.inlineScript.replace('TP', tp) + '</script></body></html>'
      );
    }
    if (p === '/vendor/lib.js') return text(res, VENDOR.lib, 'application/javascript');
    if (p === '/vendor/lib.css') return text(res, VENDOR.css, 'text/css');
    if (p === '/vendor/known.js') return text(res, VENDOR.known, 'application/javascript');
    if (p === '/vendor/stale.js') return text(res, VENDOR.stale, 'application/javascript');
    if (p === '/vendor/changing.js') return text(res, 'window.__c = ' + Math.random() + ';', 'application/javascript');
    if (p === '/vendor/data.json') return text(res, '{"ok":true}', 'application/json');
    if (p === '/vendor/pic.png') return bin(PNG_BYTES, 'image/png');
    if (p === '/demo/menu') return html(res, '<!doctype html><title>Menu</title><h1>Menu</h1>');
    return text(res, 'not found', 'text/plain', 404);
  });

  vulnPort = vuln.port;
  vuln.fix = (what) => (vulnFixed[what] = true);

  const SHELL = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
  const spa = await listen((req, res, u) => {
    const secure = {
      'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=()',
    };
    if (u.pathname === '/.well-known/security.txt')
      return text(res, `Contact: mailto:security@example.com\nExpires: ${new Date(Date.now() + 86400e3 * 200).toISOString()}\n`);
    if (u.pathname === '/assets/app.js') return text(res, 'console.log("spa")', 'application/javascript');
    // Every other path, including /.env and /.git/HEAD, gets the same 200 shell.
    return html(res, SHELL, secure);
  });

  return {
    vuln,
    spa,
    sink,
    demo,
    FAKE,
    async close() {
      for (const s of [vuln, spa, sink, demo]) await new Promise((r) => s.server.close(r));
    },
  };
}

module.exports = { startFixtures, FAKE, CLOBBER_NAMES, VENDOR };

if (require.main === module) {
  startFixtures().then((f) => {
    console.log(`vulnerable training site: http://127.0.0.1:${f.vuln.port}/\nclean SPA site:           http://127.0.0.1:${f.spa.port}/`);
  });
}
