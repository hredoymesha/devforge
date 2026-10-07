"""Two-origin fixture site (A = the page, B = a 'CDN') used by the site-download, network and security tests."""
import http.server, socketserver, threading, json, time, struct, zlib
def png(w=2, h=2, rgb=(200, 30, 30)):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    def ch(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b'')
PNG = png()
MAP = json.dumps({'version': 3, 'file': 'app.min.js', 'sources': ['../../evil.js', 'webpack:///./src/main.js', '%2e%2e%2fsecret', '/abs/path/util.js', 'src/nocontent.js'], 'sourcesContent': ['EVIL', 'export const main = () => "ORIGINAL_MAIN_SOURCE";', 'SECRET', 'UTIL', None]})
class Site:
    def __init__(self):
        self.hits = {}; self.A = None; self.B = None; self.lock = threading.Lock()
    def start(self):
        site = self
        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.0'
            def log_message(self, *a): pass
            def do_POST(self):
                n = int(self.headers.get('Content-Length') or 0)
                if n: self.rfile.read(n)
                return self.do_GET()
            def do_GET(self):
                with site.lock: site.hits[self.headers.get('Host', '') .split(':')[-1] + self.path.split('?')[0]] = site.hits.get(self.headers.get('Host', '').split(':')[-1] + self.path.split('?')[0], 0) + 1
                port = self.server.server_address[1]; path = self.path.split('?')[0]
                def send(code, body, ctype, extra=None):
                    if isinstance(body, str): body = body.encode()
                    self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
                    for k, v in (extra or {}).items(): self.send_header(k, v)
                    self.end_headers(); self.wfile.write(body)
                A, B = site.A, site.B
                if port == A:
                    if path in ('/site.html', '/'):
                        return send(200, f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture Site</title><meta name="generator" content="FixtureGen 1.0">
<link rel="stylesheet" href="css/main.css"><link rel="stylesheet" href="http://cdn.test:{B}/ext.css">
<script src="js/jquery-3.6.0.min.js"></script><script src="js/app.min.js" integrity="sha384-bogus" crossorigin="anonymous"></script><script src="http://cdn.test:{B}/lib.js"></script>
<script src="/missing.js"></script><script src="http://localhost:{B}/private-probe.js"></script></head>
<body><h1 id="t">Fixture</h1><img id="logo" src="img/logo.png" alt="logo"><img src="/img/logo.png?v=2" alt="v2"><div class="bg"></div><a href="/other.html">other</a>
<table id="tb"><tr><th>name</th><th>val</th></tr><tr><td>=HYPERLINK("http://evil.example","x")</td><td>-5</td></tr><tr><td>+cmd</td><td>@sum</td></tr></table>
<script>window.__inline = 1; fetch('/api/data.json?token=SECRET123&q=ok', {{method:'POST', body: JSON.stringify({{password:'hunter2', user:'bob'}})}}).catch(()=>{{}});</script></body></html>''', 'text/html')
                    if path == '/css/main.css': return send(200, '@import "extra.css";\n@font-face{font-family:F;src:url(../fonts/f.woff2) format("woff2")}\n.bg{width:20px;height:20px;background:url(../img/bg.png)}\nh1{color:rgb(1,2,3);font-family:F,sans-serif}\n', 'text/css')
                    if path == '/css/extra.css': return send(200, '#t{letter-spacing:1px}\n/*# sourceMappingURL=extra.css.map */', 'text/css')
                    if path == '/fonts/f.woff2': return send(200, b'wOF2' + b'\0' * 64, 'font/woff2')
                    if path in ('/img/logo.png', '/img/bg.png'): return send(200, PNG, 'image/png')
                    if path == '/js/jquery-3.6.0.min.js': return send(200, 'window.jQuery=function(){};', 'application/javascript')
                    if path == '/js/app.min.js': return send(200, 'window.__appLoaded=true;//# sourceMappingURL=app.min.js.map', 'application/javascript')
                    if path == '/js/app.min.js.map': return send(200, MAP, 'application/json')
                    if path == '/api/data.json': return send(200, json.dumps({'items': [1, 2], 'accessToken': 'LEAKME', 'user': 'bob'}), 'application/json')
                    if path == '/other.html': return send(200, '<html><body>other</body></html>', 'text/html')
                    if path.startswith('/slow/'): time.sleep(0.4); return send(200, 'x=1;', 'application/javascript', {'Cache-Control': 'no-store'})
                    if path == '/slowpage.html': return send(200, '<!doctype html><html lang="en"><head><title>slow</title>' + ''.join(f'<script src="/slow/{i}.js"></script>' for i in range(60)) + '</head><body>s</body></html>', 'text/html')
                    if path == '/beacon': return send(200, 'ok', 'text/plain')
                    if path == '/big.txt':  # streamed, no Content-Length
                        self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.end_headers()
                        try:
                            for _ in range(30): self.wfile.write(b'x' * (1024 * 1024))
                        except Exception: pass
                        return
                    if path == '/bigcl.txt': return send(200, b'y' * (30 * 1024 * 1024), 'text/plain')
                    if path == '/mid.txt': return send(200, b'z' * (1500 * 1024), 'text/plain')
                    if path == '/api.json': return send(200, '{"ok":true}', 'application/json')
                if port == B:
                    if path == '/lib.js': return send(200, 'window.__libLoaded=true;', 'application/javascript')
                    if path == '/ext.css': return send(200, '.bgb{background:url(pic.png)}', 'text/css')
                    if path == '/pic.png': return send(200, PNG, 'image/png')
                    if path == '/private-probe.js': return send(200, 'window.__probe=1', 'application/javascript')
                send(404, 'not found', 'text/plain')
        class S(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
        a, b = S(('127.0.0.1', 0), H), S(('127.0.0.1', 0), H)
        self.A, self.B = a.server_address[1], b.server_address[1]
        for s in (a, b): threading.Thread(target=s.serve_forever, daemon=True).start()
        return self
