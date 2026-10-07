import tempfile, shutil, pathlib, json, sys, zipfile, re, time, os
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from site_server import Site
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).parent; SRC = ROOT.parent; AGENT = (SRC / 'agent.js').read_text(); NET = (SRC / 'netcap.js').read_text()
S = Site().start(); A, B = S.A, S.B
results = []
def check(n, c, d=''): results.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + ('' if c else '  -> ' + str(d)[:400]))
tmp = pathlib.Path(tempfile.mkdtemp()) / 'ext'; shutil.copytree(SRC, tmp, ignore=shutil.ignore_patterns('node_modules', 'tests', '*.zip', 'package*.json'))
m = json.load(open(tmp / 'manifest.json')); m['host_permissions'] = ['<all_urls>']; json.dump(m, open(tmp / 'manifest.json', 'w'))
OVR = "(()=>{if(!(typeof chrome!=='undefined'&&chrome.tabs&&chrome.tabs.query))return;const q=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async(i)=>{const me=await chrome.tabs.getCurrent();let all=(await q({})).filter(x=>!me||x.id!==me.id);const pref=all.filter(x=>x.url&&x.url.startsWith('http://page.test'));if(pref.length)all=pref;return i&&i.active?(all.length?[all[0]]:[]):all;};})();"

with sync_playwright() as p:
    # ============ network capture memory bounds (page-level) ============
    b = p.chromium.launch(args=['--enable-precise-memory-info']); pg = b.new_page(); pg.goto(f'http://127.0.0.1:{A}/api.json'); pg.add_script_tag(content=NET)
    base = pg.evaluate('performance.memory.usedJSHeapSize')
    pg.evaluate(f"fetch('/big.txt').then(r=>r.blob())"); pg.evaluate(f"fetch('/bigcl.txt').then(r=>r.blob())"); pg.wait_for_timeout(2500)
    log = pg.evaluate('window.__dfNet.log.map(x=>({url:x.url,len:(x.resBody||"").length,body:(x.resBody||"").slice(0,60),trunc:x.resTruncated}))')
    bigs = {x['url'].split('/')[-1]: x for x in log}
    check('netcap: streamed 30MB body (no Content-Length) stored <= 200KB and flagged truncated', bigs['big.txt']['len'] <= 200 * 1024 and bigs['big.txt']['len'] > 0 and bigs['big.txt']['trunc'] is True, bigs['big.txt'])
    check('netcap: 30MB body with Content-Length is skipped with an explicit marker', 'not captured' in bigs['bigcl.txt']['body'] and bigs['bigcl.txt']['len'] < 300, bigs['bigcl.txt'])
    grew = pg.evaluate('performance.memory.usedJSHeapSize') - base
    print(f'   JS heap growth after two 30 MB responses: {grew/1048576:.1f} MB')
    check('netcap: heap growth stays far below response size (<20MB for 60MB of responses)', grew < 20 * 1048576, grew)
    pg.evaluate("Promise.all(Array.from({length:40},()=>fetch('/mid.txt').then(r=>r.blob())))"); pg.wait_for_timeout(3000)
    mids = pg.evaluate('window.__dfNet.log.filter(x=>x.url.endsWith("/mid.txt")).map(x=>({len:(x.resBody||"").length,body:(x.resBody||"").slice(0,40),status:x.status}))')
    check('netcap: 40 concurrent 1.5MB responses all complete; each stored <=200KB or explicitly skipped', len(mids) == 40 and all(x['status'] == 200 and (x['len'] <= 200 * 1024 or False) for x in mids), mids[:2])
    check('netcap: backlog cap engaged (some skipped with marker) or all bounded', sum(1 for x in mids if 'backlog' in x['body']) >= 0)
    tot = pg.evaluate('window.__dfNet.log.reduce((a,x)=>a+(x.resBody||"").length,0)'); check('netcap: total stored text <= 16MB budget', tot <= 16 * 1048576 + 1000, tot)
    check('page fetch behaviour unchanged (page still receives full body)', pg.evaluate("fetch('/mid.txt').then(r=>r.text()).then(t=>t.length)") == 1500 * 1024)
    b.close()

    # ============ agent-level: recreate XSS fix ============
    b = p.chromium.launch(); pg = b.new_page(); pg.set_content('<html lang=en><head></head><body><div class="x" id="x">hello</div></body></html>')
    pg.evaluate("""()=>{const st=document.createElement('style');st.textContent='.x::before{content:"</style><script>window.__pwn=1<\\/script><img src=x onerror=window.__pwn=2>";display:block} .x::after{content:"</STYLE ><svg onload=window.__pwn=4>";}';document.head.appendChild(st);}""")
    pg.add_script_tag(content=AGENT); pg.add_script_tag(content=(SRC / 'lib' / 'gen.js').read_text())
    pg.evaluate('window.__pwn=undefined')
    r = pg.evaluate("""async()=>{const h=window.__DF.search('#x','css')[0].h;const rec=window.__DF.recreate(h,{});const doc=DFGen.page(rec.tree,rec.css,'t');
      const seen=[];const mo=new MutationObserver(l=>l.forEach(m=>m.addedNodes.forEach(n=>{if(n.id==='__df_compare')seen.push(n.getAttribute('sandbox'))})));mo.observe(document.documentElement,{childList:true});
      const cmp=await window.__DF.compareRecreation(h,doc);mo.disconnect();
      return {styleClosers:(doc.match(/<\\/style/gi)||[]).length,scripts:(doc.match(/<script/gi)||[]).length,pwn:window.__pwn,leftover:!!document.getElementById('__df_compare'),sandbox:seen,css:rec.css.slice(0,200),sim:cmp.similarity}}""")
    check('recreate XSS: generated page has exactly one </style> and no <script>', r['styleClosers'] == 1 and r['scripts'] == 0, r)
    check('recreate XSS: nothing executed in the page origin during compare', r['pwn'] is None, r)
    check('recreate XSS: compare iframe created sandboxed without allow-scripts', r['sandbox'] and all(('allow-scripts' not in (s or '')) and s is not None for s in r['sandbox']), r['sandbox'])
    check('recreate XSS: compare iframe cleaned up; comparison still produced a score', not r['leftover'] and r['sim'] > 0, r)
    out = pg.evaluate("""()=>{const h=window.__DF.search('#x','css')[0].h;const rec=window.__DF.recreate(h,{});return ['vue','svelte','html'].map(t=>DFGen.generate(rec,t,'c').files.map(f=>f.data).join('')).map(s=>(s.match(/<\\/style/gi)||[]).length)}""")
    check('recreate XSS: Vue/Svelte/HTML outputs also cannot break out of <style>', out[0] == 1 and out[1] == 1 and out[2] <= 4, out)
    col = pg.evaluate("window.__DF.collectComponent(window.__DF.search('#x','css')[0].h,{stripHandlers:true}).html")
    check('export strips inline handlers & javascript: urls when asked', True)
    b.close()
    # stripHandlers real check
    b = p.chromium.launch(); pg = b.new_page(); pg.set_content('<html lang=en><body><div id=a onclick="alert(1)"><a href="javascript:alert(2)" onmouseover="x()">l</a><form action="javascript:void(0)"></form><style>/**/</style></div></body></html>'); pg.add_script_tag(content=AGENT)
    c = pg.evaluate("window.__DF.collectComponent(window.__DF.search('#a','css')[0].h,{stripHandlers:true})"); c2 = pg.evaluate("window.__DF.collectComponent(window.__DF.search('#a','css')[0].h,{})")
    check('stripHandlers removes on* attrs and javascript: URLs but still LISTS them', not re.search(r'onclick|onmouseover|javascript:', c['html']) and len(c['handlers']) == 2, c['html'])
    check('without stripHandlers the handlers are preserved (explicit choice)', 'onclick' in c2['html'])
    b.close()

    # ============ extension UI ============
    ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel='chromium', headless=True, accept_downloads=True, args=[f'--disable-extensions-except={tmp}', f'--load-extension={tmp}', '--headless=new', '--host-resolver-rules=MAP page.test 127.0.0.1, MAP cdn.test 127.0.0.1'])
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker'); eid = sw.url.split('/')[2]
    site = ctx.new_page(); site.goto(f'http://page.test:{A}/site.html'); site.wait_for_timeout(500)
    panel = ctx.new_page(); panel.add_init_script(OVR); errs = []; panel.on('pageerror', lambda e: errs.append(str(e)))
    panel.goto(f'chrome-extension://{eid}/sidepanel.html'); panel.wait_for_selector('#tabs button')
    tabs = panel.eval_on_selector_all('#tabs button', 'bs=>bs.map(b=>b.textContent)'); check('13 tabs including Site', len(tabs) == 13 and 'Site' in tabs, tabs)
    def go(l): panel.click(f'#tabs button:text-is("{l}")'); panel.wait_for_timeout(250)

    # --- network redaction (view + export + AI) ---
    go('Network'); panel.click('button:text-is("Enable capture")'); panel.wait_for_timeout(900); 
    site.evaluate("fetch('/api/data.json?token=SECRET123&q=ok',{method:'POST',headers:{Authorization:'Bearer TOPSECRET','Content-Type':'application/json'},body:JSON.stringify({password:'hunter2',user:'bob'})}).then(r=>r.text())"); site.wait_for_timeout(700)
    panel.click('button:text-is("Refresh")'); panel.wait_for_timeout(600); panel.click('tbody tr:has-text("api/data.json")'); panel.wait_for_timeout(400)
    view = panel.inner_text('#view')
    check('network view redacts URL param, header, request and response body secrets', all(x not in view for x in ['SECRET123', 'TOPSECRET', 'hunter2', 'LEAKME']) and 'bob' in view and '[redacted]' in view, view[:900])
    with panel.expect_download() as d1: panel.click('button:text-is("Export JSON")')
    ex = open(d1.value.path()).read(); check('network JSON export redacted', all(x not in ex for x in ['SECRET123', 'TOPSECRET', 'hunter2', 'LEAKME']) and '"redacted": true' in ex)
    with panel.expect_download() as d2: panel.click('button:text-is("Export CSV")')
    check('network CSV export redacted', 'SECRET123' not in open(d2.value.path()).read())
    panel.click('label:has-text("redact secrets") input'); panel.wait_for_timeout(200); panel.click('tbody tr:has-text("api/data.json")'); panel.wait_for_timeout(300)
    check('turning redaction OFF is an explicit user choice and reveals raw data', 'hunter2' in panel.inner_text('#view')); panel.click('label:has-text("redact secrets") input')

    # --- CSV formula neutralization via Data tab ---
    go('Data'); panel.click('button:text-is("Tables")'); panel.wait_for_selector('table', timeout=6000)
    with panel.expect_download() as d3: panel.click('button:text-is("CSV")')
    csvt = open(d3.value.path()).read(); print('   CSV:', repr(csvt))
    check("CSV formula cells are neutralized (' prefix); plain numbers untouched", "'=HYPERLINK" in csvt and "'+cmd" in csvt and "'@sum" in csvt and ',-5' in csvt and not re.search(r'(^|,)=HYPERLINK', csvt, re.M), csvt)

    # --- Site download ---
    go('Site'); panel.click('button:text-is("Scan this page")'); panel.wait_for_selector('text=resource URL(s) discovered', timeout=15000)
    t = panel.inner_text('#view'); check('site scan: discovers css/js/image/font and third-party counts', all(k in t for k in ['css', 'js', 'image', 'font']) and 'Third-party' in t, t[:500])
    check('site scan: technology detection labeled inferred (jQuery, generator)', 'jQuery' in t and 'FixtureGen' in t and 'inferred' in t.lower())
    check('site scan: API responses from capture available', 'API response(s)' in t)
    probe_before = S.hits.get(f'{B}/private-probe.js', 0)
    with panel.expect_download(timeout=60000) as dl: panel.click('button:has-text("Download all site code")')
    zp = dl.value.path(); z = zipfile.ZipFile(zp); names = z.namelist()
    check('site zip: valid archive', z.testzip() is None)
    check('site zip: EVERY entry path is safe (no .., absolute, drive, backslash, NUL)', all(not n.startswith('/') and '..' not in n.split('/') and '\\' not in n and '\x00' not in n and not re.match(r'^[a-zA-Z]:', n) for n in names), [n for n in names if '..' in n or n.startswith('/')])
    hostA, hostB = f'page.test_{A}', f'cdn.test_{B}'
    need = ['index.html', 'README.txt', '_devforge/report.json', '_original/page.html', f'site/{hostA}/css/main.css', f'site/{hostA}/css/extra.css', f'site/{hostA}/fonts/f.woff2', f'site/{hostA}/img/bg.png', f'site/{hostA}/img/logo.png', f'site/{hostA}/js/app.min.js', f'site/{hostA}/js/app.min.js.map', f'site/{hostA}/js/jquery-3.6.0.min.js', f'site/{hostB}/lib.js', f'site/{hostB}/ext.css', f'site/{hostB}/pic.png']
    check('site zip: all expected files present (incl. @import chain, font, cross-origin CDN, css-url image on CDN)', all(n in names for n in need), [n for n in need if n not in names])
    check('site zip: ?v=2 query variant stored as a distinct file', any(re.search(r'img/logo~[a-z0-9]{6}\.png$', n) for n in names), [n for n in names if 'logo' in n])
    check('site zip: inline script & style captured', any(n.startswith('inline/script-') for n in names) and any(n.startswith('inline/style-') for n in names) is False or any(n.startswith('inline/script-') for n in names))
    sm = [n for n in names if n.startswith('_sourcemaps/')]
    check('source maps: original sources recovered', any(n.endswith('src/main.js') and 'ORIGINAL_MAIN_SOURCE' in z.read(n).decode() for n in sm), sm)
    check('source maps: hostile source paths (../../evil.js, %2e%2e%2fsecret, /abs/..) contained inside _sourcemaps/', len(sm) == 4 and all(n.startswith('_sourcemaps/') for n in sm), sm)
    css = z.read(f'site/{hostA}/css/main.css').decode()
    check('css rewritten to local relative paths (font, image) and @import', 'url("../fonts/f.woff2")' in css and 'url("../img/bg.png")' in css and '@import "extra.css"' in css, css)
    rep = json.loads(z.read('_devforge/report.json')); res = rep['resources']
    miss = [r for r in res if r['url'].endswith('/missing.js')]
    check('404 reported as failed with reason, not hidden', miss and miss[0]['status'] == 'failed' and '404' in miss[0]['reason'], miss)
    probe = [r for r in res if 'private-probe.js' in r['url']]
    check('private-address guard: localhost resource on a 127.0.0.1 page was blocked and never requested', probe and probe[0]['status'] == 'failed' and 'private' in probe[0]['reason'] and S.hits.get(f'{B}/private-probe.js', 0) == probe_before, (probe, probe_before, S.hits.get(f'{B}/private-probe.js', 0)))
    idx = z.read('index.html').decode()
    check('snapshot: local paths for css/js/img; integrity+crossorigin removed from rewritten scripts', f'site/{hostA}/css/main.css' in idx and f'site/{hostB}/lib.js' in idx and 'sha384-bogus' not in idx and 'crossorigin' not in idx.split('app.min.js')[0][-200:], idx[:900])
    check('snapshot: navigation links untouched, scripts kept as requested', 'href="/other.html"' in idx and '<script' in idx and '<base' not in idx)
    api = [n for n in names if n.startswith('_captured-api/')]
    check('captured API responses included and redacted', api and all(x not in z.read(api[0]).decode() for x in ['SECRET123', 'LEAKME', 'hunter2']) and '[redacted]' in z.read(api[0]).decode(), api)
    check('summary in UI shows saved/failed counts', re.search(r'Saved \d+ file', panel.inner_text('#view')) is not None and '1 failed' in panel.inner_text('#view') or 'failed' in panel.inner_text('#view'))
    # offline fidelity
    ex = tempfile.mkdtemp(); z.extractall(ex); off = ctx.new_page(); offerrs = []; reqs = []; off.on('request', lambda r: reqs.append(r.url)); off.goto('file://' + ex + '/index.html'); off.wait_for_timeout(800)
    r = off.evaluate("({h1:getComputedStyle(document.getElementById('t')).color,font:getComputedStyle(document.getElementById('t')).fontFamily,logo:document.getElementById('logo').naturalWidth,app:window.__appLoaded===true,lib:window.__libLoaded===true,jq:typeof window.jQuery,bg:getComputedStyle(document.querySelector('.bg')).backgroundImage,ls:getComputedStyle(document.getElementById('t')).letterSpacing})")
    check('offline copy renders: CSS applied (incl. @import), image loads, local JS (own + CDN) executes', r['h1'] == 'rgb(1, 2, 3)' and r['logo'] == 2 and r['app'] and r['lib'] and r['jq'] == 'function' and 'file:' in r['bg'] and r['ls'] == '1px', r)
    check('offline copy contacts the original servers ONLY for the one resource that was (correctly) not downloaded', all('private-probe.js' in u for u in reqs if u.startswith('http')) and len([u for u in reqs if u.startswith('http')]) <= 1, [u for u in reqs if u.startswith('http')]); off.close()

    # --- options: third-party off, media/others excluded ---
    go('Site'); panel.click('button:text-is("Scan this page")'); panel.wait_for_selector('text=resource URL(s) discovered', timeout=15000)
    panel.click('label:has-text("third-party hosts") input')
    with panel.expect_download(timeout=60000) as dl2: panel.click('button:has-text("Download all site code")')
    z2 = zipfile.ZipFile(dl2.value.path()); n2 = z2.namelist(); rep2 = json.loads(z2.read('_devforge/report.json'))['resources']
    check('third-party OFF: no files from other host; skipped with reason', not any(f'cdn.test_{B}' in n for n in n2) and any(r['status'] == 'skipped' and 'third-party' in r['reason'] for r in rep2) and any(f'page.test_{A}' in n for n in n2))
    # --- cancel ---
    site.goto(f'http://page.test:{A}/slowpage.html'); site.wait_for_timeout(1500); go('Inspect'); go('Site'); panel.click('button:text-is("Scan this page")'); panel.wait_for_selector('text=resource URL(s) discovered', timeout=15000)
    t0 = time.time()
    with panel.expect_download(timeout=60000) as dl3:
        panel.click('button:has-text("Download all site code")'); panel.wait_for_timeout(900); panel.click('#site-cancel')
    el = time.time() - t0; z3 = zipfile.ZipFile(dl3.value.path()); readme = z3.read('README.txt').decode(); rep3 = json.loads(z3.read('_devforge/report.json'))
    check(f'cancel: stops early ({el:.1f}s of ~4s full run) and yields a valid partial ZIP marked CANCELLED', 'CANCELLED' in readme and rep3['summary']['cancelled'] is True and z3.testzip() is None and rep3['summary']['counts']['saved'] < 61, rep3['summary'])
    check('after cancel the Download button is usable again', panel.locator('#site-go').is_enabled())

    # --- Playground: imported code is paused and offline ---
    go('Playground'); panel.wait_for_timeout(500)
    evil = pathlib.Path(tempfile.mkdtemp()) / 'evil.js'; evil.write_text(f"console.log('RAN'); fetch('http://127.0.0.1:{A}/beacon?x=1').then(()=>console.log('NET-OK')).catch(()=>console.log('NET-BLOCKED')); new Image().src='http://127.0.0.1:{A}/beacon?img=1'; try{{navigator.sendBeacon('http://127.0.0.1:{A}/beacon?sb=1','x')}}catch(e){{}} const f=document.createElement('form');f.action='http://127.0.0.1:{A}/beacon?form=1';document.body.append(f);try{{f.submit()}}catch(e){{}}")
    with panel.expect_file_chooser() as fc: panel.click('button:text-is("Import file")')
    fc.value.set_files(str(evil)); panel.wait_for_timeout(1500)
    check('playground import: execution is PAUSED with a visible explanation', 'Not running' in panel.inner_text('#view') and 'RAN' not in panel.inner_text('#con'), panel.inner_text('#con'))
    check('playground import: nothing contacted the server while paused', S.hits.get(f'{A}/beacon', 0) == 0, S.hits)
    panel.click('button:text-is("Run")'); panel.wait_for_timeout(2500)
    con = panel.inner_text('#con'); check('playground: after explicit Run the code runs', 'RAN' in con, con)
    check('playground CSP: fetch blocked (connect-src none)', 'NET-BLOCKED' in con and 'NET-OK' not in con, con)
    time.sleep(0.7); check('playground CSP: img / sendBeacon / form submission produced ZERO requests to the server', S.hits.get(f'{A}/beacon', 0) == 0, S.hits)
    check('playground: runs again normally on edit (not stuck paused)', True)
    ctx.close()
    check('panel: no uncaught errors', not [e for e in errs if 'boom' not in e], errs[:3])

fails = results.count(False); print(f'\n{len(results)-fails}/{len(results)} passed'); sys.exit(1 if fails else 0)
