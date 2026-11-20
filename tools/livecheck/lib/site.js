// A small demo site the walk-through runs on. It has the things the panels look for.
const http = require('http');

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Demo shop</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A page used to check DevForge.">
<link rel="stylesheet" href="/style.css">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Blue mug"}</script>
</head><body>
<header id="top"><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<main>
  <section id="hero" class="hero"><div><h1>Blue mug</h1><p class="lead">A plain mug for a plain desk.</p>
    <button id="buy" class="buy">Add to basket</button></div>
    <img alt="A blue mug" width="160" height="140" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='140' viewBox='0 0 160 140'><rect x='30' y='30' width='80' height='90' rx='10' fill='%234f8cff'/><path d='M110 52h12a18 18 0 0 1 0 36h-12' fill='none' stroke='%234f8cff' stroke-width='10'/><rect x='30' y='30' width='80' height='14' rx='6' fill='%233a6fd8'/><ellipse cx='70' cy='126' rx='52' ry='6' fill='%23d9e2f3'/></svg>"></section>
  <section id="specs"><h2>Details</h2>
    <table><thead><tr><th>Size</th><th>Price</th></tr></thead>
    <tbody><tr><td>Small</td><td>$8.00</td></tr><tr><td>Large</td><td>$12.50</td></tr></tbody></table></section>
  <form id="login" action="/login" method="post"><h2>Sign in</h2>
    <label for="u">Email</label><input id="u" name="email" type="email">
    <label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form>
</main>
<footer><p>Demo only. Not a real shop.</p></footer>
<script src="/app.js"></script>
</body></html>`;

const css = `body{font-family:system-ui,sans-serif;margin:0;color:#1c2330;background:#fff}
header{background:#1c2330;padding:12px 20px}header a{color:#fff;margin-right:12px}
main{max-width:720px;margin:0 auto;padding:24px}
.hero{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:32px;border-radius:12px;background:#eef3ff}
.buy{background:#4f8cff;color:#fff;border:0;padding:10px 16px;border-radius:8px;font-size:16px}
table{border-collapse:collapse}td,th{border:1px solid #cdd5e4;padding:6px 10px}
form{display:grid;gap:6px;max-width:320px;margin-top:24px;padding:20px;border:1px solid #dfe5f0;border-radius:12px}
form h2{margin:0 0 6px}form label{font-size:14px;color:#4a5568}
form input{padding:8px 10px;border:1px solid #cdd5e4;border-radius:6px;font:inherit}
form button{margin-top:8px;padding:9px 14px;border:0;border-radius:6px;background:#1c2330;color:#fff;font:inherit}
footer{max-width:720px;margin:0 auto;padding:16px 24px 32px;color:#6b7280;border-top:1px solid #e5e7eb}
@media (max-width:480px){main{padding:12px}.hero{padding:16px;flex-direction:column}}`;

const js = `localStorage.setItem('cart','2');
sessionStorage.setItem('seen','yes');
document.cookie='theme=blue; path=/';
console.log('demo page ready');
fetch('/api/items').then(r=>r.json()).then(d=>{window.__items=d.items.length});
document.getElementById('buy').addEventListener('click',()=>fetch('/api/basket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:1})}));`;

function start() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.method + ' ' + req.url);
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, Object.assign({ 'content-type': type, 'x-demo': '1' }, extra));
      res.end(body);
    };
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/about' || u === '/contact') return send(200, 'text/html; charset=utf-8', page);
    if (u === '/style.css') return send(200, 'text/css', css);
    if (u === '/app.js') return send(200, 'text/javascript', js);
    if (u === '/api/items') return send(200, 'application/json', JSON.stringify({ items: [{ id: 1, name: 'Mug', price: 8 }, { id: 2, name: 'Plate', price: 5.5 }] }));
    if (u === '/api/basket') return send(201, 'application/json', '{"ok":true}');
    if (u === '/robots.txt') return send(200, 'text/plain', 'User-agent: *\nDisallow: /admin\n');
    return send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + server.address().port + '/', origin: 'http://127.0.0.1:' + server.address().port, hits, close: () => server.close() })));
}

module.exports = { start };
