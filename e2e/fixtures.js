/*
 * Local training sites for the browser tests. Nothing here is a real credential: provider-looking
 * strings are assembled at runtime so secret scanners do not flag this file.
 *
 *   vuln  an intentionally weak site (missing headers, exposed files, risky patterns)
 *   spa   a well-configured single-page app that answers EVERY path with its HTML shell and a 200,
 *         used to prove that a catch-all page is not mistaken for an exposed file
 *   sink  a "private" target that a redirect tries to reach; it must never be fetched
 *
 * Each server records every request (method, path, whether cookies or authorization were sent)
 * so tests can assert what the scanner really did on the wire.
 */
const http = require('node:http');

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
    if (p === '/.git/HEAD') return text(res, 'ref: refs/heads/main\n');
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

  vulnPort = vuln.port;

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
    FAKE,
    async close() {
      for (const s of [vuln, spa, sink]) await new Promise((r) => s.server.close(r));
    },
  };
}

module.exports = { startFixtures, FAKE };

if (require.main === module) {
  startFixtures().then((f) => {
    console.log(`vulnerable training site: http://127.0.0.1:${f.vuln.port}/\nclean SPA site:           http://127.0.0.1:${f.spa.port}/`);
  });
}
