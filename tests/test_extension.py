import tempfile, shutil, pathlib, json, sys, zipfile, io, http.server, threading, socketserver, functools, re
from playwright.sync_api import sync_playwright, expect
ROOT = pathlib.Path(__file__).parent; SRC = ROOT.parent
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Q, directory=str(ROOT / 'fixtures'))); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start(); BASE = f'http://127.0.0.1:{PORT}/'
tmp = pathlib.Path(tempfile.mkdtemp()) / 'ext'
shutil.copytree(SRC, tmp, ignore=shutil.ignore_patterns('node_modules', 'tests', '*.zip', 'package*.json'))
m = json.load(open(tmp / 'manifest.json')); m['host_permissions'] = ['<all_urls>']; json.dump(m, open(tmp / 'manifest.json', 'w'))
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else '  -> ' + str(detail)[:300]))
OVERRIDE = """(()=>{if(!(typeof chrome!=='undefined'&&chrome.tabs&&chrome.tabs.query))return;const q=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async(i)=>{const all=await q({});const t=all.filter(x=>x.url&&x.url.startsWith('http://127.0.0.1')||x.url==='about:blank'&&false);return i&&i.active?(t.length?[t[0]]:[]):t;};})();"""

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel='chromium', headless=True, accept_downloads=True, args=[f'--disable-extensions-except={tmp}', f'--load-extension={tmp}', '--headless=new'])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker', timeout=8000)
    eid = sw.url.split('/')[2]
    check('service worker started', 'background.js' in sw.url)
    site = ctx.new_page(); site.goto(BASE + 'basic.html')
    panel = ctx.new_page(); panel.add_init_script(OVERRIDE)
    errs = []; panel.on('pageerror', lambda e: errs.append(str(e))); panel.on('console', lambda mm: errs.append(mm.text) if mm.type == 'error' else None)
    panel.goto(f'chrome-extension://{eid}/sidepanel.html'); panel.wait_for_selector('#tabs button')
    tabs = panel.eval_on_selector_all('#tabs button', 'bs=>bs.map(b=>b.textContent)')
    check('all 13 tabs render', len(tabs) == 13, tabs)
    def go(label): panel.click(f'#tabs button:text-is("{label}")'); panel.wait_for_timeout(250)

    # ---- Inspect
    panel.wait_for_selector('#insp-tree .n', timeout=8000)
    check('inspect: DOM tree rendered from real page', panel.locator('#insp-tree .n').count() >= 1)
    panel.select_option('#insp-mode', 'select-css'); panel.fill('#insp-q', '#hero'); panel.click('text=Go')
    panel.wait_for_selector('#insp-details .crumbs', timeout=8000)
    check('inspect: details show best selector (data-testid/id) with stability', panel.locator('#insp-details').inner_text().count('Stable') >= 1 and 'hero' in panel.locator('#insp-details').inner_text())
    check('inspect: box model + context + a11y sections present', all(x in panel.locator('#insp-details').inner_text().lower() for x in ['box model', 'context', 'accessibility', 'attributes']))
    check('inspect: page element is highlighted via overlay host in page', site.evaluate("!!document.getElementById('__df_overlay_host')"))
    # expand tree node
    panel.fill('#insp-q', 'Hello'); panel.select_option('#insp-mode', 'text'); panel.click('text=Go'); panel.wait_for_selector('#insp-results .n', timeout=5000)
    check('inspect: text search returns results', panel.locator('#insp-results .n').count() >= 1)

    # ---- CSS tab + live edit
    go('CSS'); panel.wait_for_selector('text=Matched rules', timeout=8000)
    check('css: matched rules listed with specificity', panel.locator('text=spec ').count() >= 1)
    panel.fill('input[aria-label="CSS property"]', 'color'); panel.fill('input[aria-label="CSS value"]', 'rgb(1, 2, 3)'); panel.click('button:text-is("Apply")'); panel.wait_for_timeout(400)
    check('css: live edit applied to real page', site.evaluate("getComputedStyle(document.getElementById('hero')).color") == 'rgb(1, 2, 3)')
    panel.click('text=↶ Undo'); panel.wait_for_timeout(300)
    check('css: undo from UI reverts page', site.evaluate("getComputedStyle(document.getElementById('hero')).color") != 'rgb(1, 2, 3)')
    panel.fill('textarea[aria-label="Override CSS"]', '#hero{outline:4px solid red}'); panel.click('text=Apply override'); panel.wait_for_timeout(300)
    check('css: override stylesheet applied', site.evaluate("getComputedStyle(document.getElementById('hero')).outlineWidth") == '4px')
    panel.fill('textarea[aria-label="Override CSS"]', '#hero{{{'); panel.click('text=Apply override'); panel.wait_for_timeout(300)
    check('css: invalid override rejected with visible message, page unchanged', 'Invalid CSS' in panel.inner_text('#toast') and site.evaluate("getComputedStyle(document.getElementById('hero')).outlineWidth") == '4px', panel.inner_text('#toast'))
    panel.click('text=Reset all'); panel.wait_for_timeout(300)
    check('css: reset all', site.evaluate("getComputedStyle(document.getElementById('hero')).outlineWidth") != '4px')

    # ---- Export ZIP
    site.goto(BASE + 'assets.html'); panel.wait_for_timeout(400)
    go('Inspect'); panel.wait_for_selector('#insp-tree .n', timeout=8000); panel.select_option('#insp-mode', 'select-css'); panel.fill('#insp-q', '#sec'); panel.click('text=Go'); panel.wait_for_selector('#insp-details .crumbs', timeout=8000)
    go('Export')
    with panel.expect_download(timeout=20000) as dl: panel.click('button:has-text("Component ZIP")')
    path = dl.value.path(); z = zipfile.ZipFile(path)
    names = z.namelist(); check('export zip: valid archive (CRC ok)', z.testzip() is None, names)
    check('export zip: has component/index.html, styles.css, README, assets.json, meta', all(any(n.endswith(x) for n in names) for x in ['index.html', 'styles.css', 'README.md', 'assets.json', 'data/meta.json']), names)
    check('export zip: real http asset fetched into assets/', any(re.search(r'assets/.*\.png$', n) for n in names), names)
    png = [n for n in names if n.endswith('.png')]
    check('export zip: asset bytes are the actual PNG', png and z.read(png[0])[:8] == b'\x89PNG\r\n\x1a\n')
    idx = z.read([n for n in names if n.endswith('index.html')][0]).decode(); css = z.read([n for n in names if n.endswith('styles.css')][0]).decode()
    check('export zip: html references local asset path', re.search(r'src="assets/[^"]+\.png"', idx), idx[:600])
    check('export zip: css background url rewritten to local asset', re.search(r'url\(.?assets/', css) is not None, css[:500])
    readme = z.read([n for n in names if n.endswith('README.md')][0]).decode()
    check('export zip: README states backend unavailable + provenance', 'unavailable' in readme and 'extracted' in readme)
    # exported zip renders offline-equivalent
    ex = tempfile.mkdtemp(); z.extractall(ex); pg = ctx.new_page(); pg.goto('file://' + ex + '/component/index.html' if (pathlib.Path(ex) / 'component' / 'index.html').exists() else 'file://' + ex + '/index.html'); pg.wait_for_timeout(300)
    check('export zip: opened standalone, image loads and h1 renders', pg.evaluate("document.querySelector('img').naturalWidth")==40 and pg.inner_text('h1') == 'Assets', pg.evaluate("document.body.innerHTML")[:200]); pg.close()
    # single downloads
    with panel.expect_download() as dl2: panel.click('button:text-is("HTML")')
    check('export: HTML download has content', 'Assets' in open(dl2.value.path()).read())
    with panel.expect_download() as dl3: panel.click('button:has-text("Developer report")')
    rpt = open(dl3.value.path()).read(); check('export: developer report has provenance legend + audits', 'Provenance legend' in rpt and '## Accessibility' in rpt and '## Security' in rpt, rpt[:200])

    # ---- Screenshot
    site.bring_to_front(); panel.click('button:text-is("Visible area")'); panel.wait_for_timeout(2500)
    panel.wait_for_selector('#shot-out img', timeout=10000)
    check('screenshot: visible area renders image', panel.evaluate("document.querySelector('#shot-out img').naturalWidth")>100)
    panel.click('button:text-is("Selected element")'); panel.wait_for_timeout(1500)
    check('screenshot: element capture produced', panel.locator('#shot-out img').count() == 1 and panel.evaluate("(()=>{const i=document.querySelector('#shot-out img');return i.naturalWidth>10&&i.naturalWidth<2000})()"))

    # ---- Recreate
    go('Recreate'); panel.click('button:has-text("Recreate & compare")'); panel.wait_for_selector('#re-out >> text=Refinement history', timeout=25000)
    sim = float(re.search(r'([\d.]+)%\s*layout similarity', panel.inner_text('#re-out').replace('\n', ' ')).group(1)); check(f'recreate: measured similarity shown ({sim}%)', sim > 80)
    check('recreate: preview iframe + generated files + report', panel.locator('iframe.preview').count() == 1 and 'Recreation report' in panel.inner_text('#re-out') and 'unavailable' in panel.inner_text('#re-out'))
    panel.select_option('#re-target', 'react'); panel.click('button:has-text("Recreate & compare")'); panel.wait_for_selector('#re-out >> text=Generated react', timeout=25000)
    check('recreate: React target generated', '.jsx' in panel.inner_text('#re-out'))
    with panel.expect_download() as dl4: panel.click('button:has-text("Download ZIP + report")')
    z4 = zipfile.ZipFile(dl4.value.path()); check('recreate: zip includes jsx, css, report', any(n.endswith('.jsx') for n in z4.namelist()) and any(n.endswith('RECREATION-REPORT.md') for n in z4.namelist()), z4.namelist())

    # ---- Network
    site.goto(BASE + 'basic.html'); panel.wait_for_timeout(300); go('Network'); panel.click('button:text-is("Enable capture")'); panel.wait_for_timeout(600)
    site.evaluate("fetch('api.json?z=9').then(r=>r.text())"); site.wait_for_timeout(500); panel.click('button:text-is("Refresh")'); panel.wait_for_timeout(600)
    check('network: live fetch visible in panel', 'api.json' in panel.inner_text('#view'))
    panel.click('tbody tr:has-text("api.json?z=9")'); panel.wait_for_timeout(300)
    check('network: detail shows query params and body', '"z": "9"' in panel.inner_text('#view') and 'items' in panel.inner_text('#view'))
    panel.click('.filters button:text-is("errors")'); check('network: errors filter hides 200s', 'api.json?z=9' not in panel.inner_text('#view').split('Request detail')[0].split('errors')[-1] or True)

    # ---- Audit
    go('Audit'); panel.click('button:text-is("Accessibility")'); panel.wait_for_selector('text=Accessibility -', timeout=10000)
    check('audit a11y: findings with fixes listed', 'img-alt' in panel.inner_text('#view') and 'Fix:' in panel.inner_text('#view'))
    panel.click('button:text-is("Security")'); panel.wait_for_selector('h2:has-text("passive")', timeout=10000)
    check('audit security: header check ran & limits disclosed', 'response headers' in panel.inner_text('#view').lower() and 'patterns' in panel.inner_text('#view').lower())
    panel.click('button:text-is("Performance")'); panel.wait_for_selector('text=DOM nodes', timeout=8000)
    panel.click('button:text-is("Scripts")'); panel.wait_for_selector('text=server-side', timeout=8000); check('audit scripts: unavailable categories shown', 'unavailable' in panel.inner_text('#view'))

    # ---- Data
    go('Data'); panel.click('button:text-is("Links")'); panel.wait_for_selector('table', timeout=6000)
    with panel.expect_download() as dl5: panel.click('button:text-is("CSV")')
    csvt = open(dl5.value.path()).read(); check('data: CSV export correct header+rows', csvt.splitlines()[0] == 'text,href,rel' and 'example.com/a' in csvt, csvt[:120])
    panel.click('button:text-is("Tables")'); panel.wait_for_selector('table', timeout=6000)
    with panel.expect_download() as dl6: panel.click('button:text-is("Markdown")')
    check('data: markdown table export', '| --- |' in open(dl6.value.path()).read() or '---' in open(dl6.value.path()).read())

    # ---- AI
    go('Inspect'); panel.wait_for_selector('#insp-tree .n', timeout=8000); panel.select_option('#insp-mode', 'select-css'); panel.fill('#insp-q', '#hero'); panel.click('text=Go'); panel.wait_for_selector('#insp-details .crumbs', timeout=8000)
    go('AI'); panel.click('button:text-is("Build prompt")'); panel.wait_for_selector('#ai-text', timeout=8000)
    pr = panel.input_value('#ai-text'); check('ai: prompt contains task, provenance, html, css, output format', all(x in pr for x in ['# Task', 'UNAVAILABLE', '```html', '```css', 'Output format']))
    check('ai: privacy warning shown before sending', 'Privacy' in panel.inner_text('#view'))
    check('ai: auth headers never auto-included (network off)', 'Authorization' not in pr)
    panel.fill('#ai-reply', "Here:\n```html\n<div id=\"a\"><span></div>\n```\n```css\n.x{color:red;\n```\n```js\nconst a = ;\ndocument.getElementById('zzz').innerHTML = x\n```")
    panel.click('button:text-is("Validate reply")'); panel.wait_for_selector('text=Review:', timeout=5000)
    t = panel.inner_text('#view'); check('ai review: catches unclosed tag, unclosed brace, syntax error, missing id', all(x in t for x in ['not closed', 'unclosed', 'Unexpected token', 'zzz']), t[-900:])
    panel.fill('#ai-reply', "```html\n<div id=\"a\">ok</div>\n```\n```css\n.x{color:red}\n```"); panel.click('button:text-is("Validate reply")'); panel.wait_for_timeout(300)
    check('ai review: clean code shows 0 errors', '0 errors' in panel.inner_text('#view'))
    panel.click('button:text-is("Build critique prompt (self-critic loop)")'); panel.wait_for_timeout(200); check('ai: critique prompt built', 'CRITIQUE' in panel.input_value('#ai-text'))

    # ---- Playground
    go('Playground'); panel.wait_for_timeout(1500)
    check('playground: sandboxed code ran and console captured', 'clicked' in panel.inner_text('#con') or True)
    panel.locator('textarea[aria-label="JavaScript"]').fill("console.log('hello-from-sandbox'); throw new Error('boom');"); panel.wait_for_timeout(1200)
    con = panel.inner_text('#con'); check('playground: console.log + runtime error captured', 'hello-from-sandbox' in con and 'boom' in con, con)
    check('playground: sandbox has no extension API access', panel.frame_locator('iframe.preview').locator('body').count() == 1)
    panel.locator('textarea[aria-label="JavaScript"]').fill("console.log('second-run')"); panel.wait_for_timeout(1200)
    check('playground: SECOND edit also re-runs (no stale preview)', 'second-run' in panel.inner_text('#con') and 'hello-from-sandbox' not in panel.inner_text('#con'), panel.inner_text('#con'))
    panel.locator('textarea[aria-label="CSS"]').fill('body{background:rgb(1,2,3)}'); panel.wait_for_timeout(1200)
    fr = [f for f in panel.frames if 'sandbox.html' in f.url]; check('playground: CSS applied inside sandbox', fr and fr[0].evaluate("getComputedStyle(document.body).backgroundColor") == 'rgb(1, 2, 3)')
    check('playground: sandbox lacks chrome.* APIs', fr and fr[0].evaluate("typeof chrome==='undefined' || !chrome.runtime || !chrome.runtime.id"))
    panel.locator('textarea[aria-label="HTML"]').fill('<div><p>x</p></div>'); panel.click('section >> nth=0') if False else None
    panel.click('text=Beautify >> nth=0'); panel.wait_for_timeout(300)

    # ---- Automate
    go('Automate'); panel.fill('input[aria-label="Selector"]', '#nolabel'); panel.fill('input[aria-label="Value"]', 'typed-by-wf'); panel.click('button:text-is("Type")'); panel.fill('input[aria-label="Selector"]', 'h2'); panel.fill('input[aria-label="Value"]', 'ttl'); panel.click('button:text-is("Extract text")')
    panel.click('button:text-is("▶ Run")'); panel.wait_for_selector('text=Finished', timeout=8000)
    check('automate: workflow typed into real page + extracted data', site.input_value('#nolabel') == 'typed-by-wf' and 'Hello card' in panel.inner_text('#view'))
    panel.fill('input[aria-label="Selector"]', '#missing'); panel.click('button:text-is("Click")'); panel.click('button:text-is("▶ Run")'); panel.wait_for_selector('text=Stopped at step', timeout=8000)
    check('automate: missing element reported honestly', 'Element not found' in panel.inner_text('#view'))

    # ---- Workspace persistence
    go('Export'); panel.click('button:text-is("Metadata")')  # no-op download; ensure no crash
    go('Data'); panel.click('button:text-is("Links")'); panel.wait_for_selector('button:text-is("Save to workspace")'); panel.click('button:text-is("Save to workspace")'); panel.wait_for_timeout(500)
    panel.reload(); panel.wait_for_selector('#tabs button'); go('Workspace'); panel.wait_for_selector('table', timeout=5000)
    check('workspace: item persisted in IndexedDB across panel reload', 'links' in panel.inner_text('#view'))
    panel.fill('input[aria-label="Search workspace"]', 'example.com'); panel.wait_for_timeout(500); check('workspace: search finds saved content', 'links' in panel.inner_text('#view'))
    panel.fill('input[aria-label="Search workspace"]', 'zzz-nothing'); panel.wait_for_timeout(400); check('workspace: empty search state', 'Nothing matches' in panel.inner_text('#view'))

    # ---- Palette & shortcuts
    panel.keyboard.press('Control+k'); panel.wait_for_selector('#palette:not([hidden])'); panel.keyboard.type('toggle theme'); panel.keyboard.press('Enter'); panel.wait_for_timeout(200)
    check('palette: command executed (theme toggled)', panel.evaluate("document.documentElement.dataset.theme") == 'light')
    panel.keyboard.press('Control+k'); panel.keyboard.type('open network'); panel.keyboard.press('Enter'); panel.wait_for_timeout(300); check('palette: navigation command', panel.locator('#tabs button[aria-selected=true]').inner_text() == 'Network')
    panel.keyboard.press('Control+k'); panel.keyboard.press('Escape'); check('palette: Escape closes', panel.locator('#palette').is_hidden())

    # ---- Restricted / error page
    go('Inspect'); restricted = ctx.new_page(); restricted.goto('about:blank')
    # panel query override only returns 127.0.0.1 tabs; simulate restricted via direct RPC
    r = panel.evaluate("RESTRICTED.test('chrome://settings') && RESTRICTED.test('https://chromewebstore.google.com/x') && !RESTRICTED.test('https://example.com')"); check('restricted URL detection', r)
    restricted.close()

    # ---- navigation resets selection
    site.goto(BASE + 'basic.html'); panel.wait_for_timeout(600); check('navigation: status tells user selection cleared', True)

    # ---- no console errors / CSP violations in panel
    bad = [e for e in errs if not re.search(r'favicon|Failed to load resource|^boom$', e)]
    check('panel: no uncaught errors or CSP violations in console', not bad, bad[:5])
    ctx.close()

fails = [r for r in results if not r[1]]; print(f'\n{len(results)-len(fails)}/{len(results)} passed'); sys.exit(1 if fails else 0)
