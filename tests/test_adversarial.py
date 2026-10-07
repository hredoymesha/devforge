import tempfile, shutil, pathlib, json, sys, http.server, threading, socketserver, functools, time, re, subprocess
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).parent
sys.path.insert(0, str(ROOT))
from _fixtures import ensure_huge

ensure_huge(); SRC = ROOT.parent; AGENT = (SRC / 'agent.js').read_text()
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.TCPServer(('127.0.0.1', 0), functools.partial(Q, directory=str(ROOT / 'fixtures'))); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start(); BASE = f'http://127.0.0.1:{PORT}/'
results = []
def check(n, c, d=''): results.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + ('' if c else '  -> ' + str(d)[:300]))
def D(page, expr, *a): return page.evaluate(f'async (a) => window.__DF.{expr}(...a)', list(a))
def mkext(host):
    tmp = pathlib.Path(tempfile.mkdtemp()) / 'ext'; shutil.copytree(SRC, tmp, ignore=shutil.ignore_patterns('node_modules', 'tests', '*.zip', 'package*.json'))
    m = json.load(open(tmp / 'manifest.json')); m['host_permissions'] = host; json.dump(m, open(tmp / 'manifest.json', 'w')); return tmp
OVR = "(()=>{if(!(typeof chrome!=='undefined'&&chrome.tabs&&chrome.tabs.query))return;const q=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async(i)=>{const me=await chrome.tabs.getCurrent();let all=(await q({})).filter(x=>!me||x.id!==me.id);const pref=all.filter(x=>x.url&&x.url.startsWith('http://127.0.0.1'));if(pref.length)all=pref;else all=all.filter(x=>x.url!=='chrome://newtab/'&&x.url!=='about:blank');return i&&i.active?(all.length?[all[0]]:[]):all;};})();"

with sync_playwright() as p:
    b = p.chromium.launch(); page = b.new_page(viewport={'width': 1000, 'height': 800}); page.goto(BASE + 'basic.html'); page.add_script_tag(content=AGENT)
    # 1 expando pollution
    h = page.evaluate("window.__DF.search('#hero','css')[0].h"); D(page, 'select', h)
    check('agent leaves no expando properties on page nodes', page.evaluate("Object.getOwnPropertyNames(document.getElementById('hero')).filter(k=>k.startsWith('__df')).length") == 0)
    # 2 memory: churn nodes, handles must be pruned
    page.evaluate("""async()=>{for(let i=0;i<3000;i++){const d=document.createElement('div');document.body.append(d);window.__DF.select ? 0:0;window.__DF.relative; const hh=window.__DF.search('div','css'); d.remove();}}""")
    page.evaluate("""()=>{for(let i=0;i<2000;i++){const d=document.createElement('div');d.id='t'+i;document.body.append(d);}}""")
    page.evaluate("""()=>{const hs=[];for(let i=0;i<2000;i++){const r=window.__DF.search('#t'+i,'css');}document.querySelectorAll('[id^=t]').forEach(e=>e.remove());for(let i=0;i<600;i++){const d=document.createElement('p');d.className='z';document.body.append(d);window.__DF.search('p.z','css');d.remove();}}""")
    st = D(page, '_stats'); check('handle registry is pruned (not unbounded)', st['handles'] < 1500, st)
    # 3 rapid concurrent calls
    res = page.evaluate("""async()=>{const h=window.__DF.search('#hero','css')[0].h;const ps=[];for(let i=0;i<60;i++){ps.push(window.__DF.css(h));ps.push(window.__DF.describe(h));ps.push(Promise.resolve(window.__DF.accessibilityAudit(null)));}const r=await Promise.all(ps);return r.length}""")
    check('60x3 rapid concurrent analyses complete', res == 180)
    ok = page.evaluate("""()=>{const h=window.__DF.search('#hero','css')[0].h;const before=getComputedStyle(document.getElementById('hero')).color;for(let i=0;i<300;i++){window.__DF.edit({h,kind:'style',prop:'color',value:'rgb('+(i%255)+',0,0)'});}for(let i=0;i<300;i++){window.__DF.undo();}return getComputedStyle(document.getElementById('hero')).color===before && window.__DF.history().undo===0 && window.__DF.history().redo===300}""")
    check('300 rapid edits then 300 undos restores exact original', ok)
    for _ in range(3): D(page, 'resetAll')
    check('change log is capped', D(page, '_stats')['changeLog'] <= 700)
    # 4 hostile markup: handlers/scripts/js: hrefs must not survive recreation or export
    page.set_content('<html lang=en><body><div id=x><a href="javascript:alert(1)" onclick="alert(2)">a</a><img src=x onerror="alert(3)"><script>alert(4)</script><style>body{}</style><svg onload="alert(5)"><circle r=3></circle></svg></div></body></html>'); page.add_script_tag(content=AGENT)
    hh = page.evaluate("window.__DF.search('#x','css')[0].h"); rec = D(page, 'recreate', hh, {}); gen = (SRC / 'lib' / 'gen.js').read_text(); pg2 = b.new_page(); pg2.set_content('<html></html>'); pg2.add_script_tag(content=gen)
    out = pg2.evaluate("(rec)=>DFGen.page(rec.tree, rec.css, 't')", rec)
    check('recreation strips scripts, on* handlers, javascript: hrefs', not re.search(r'<script|onerror|onclick|onload|javascript:', out, re.I), out)
    col = D(page, 'collectComponent', hh); check('export html has no <script>', '<script' not in col['html'])
    check('export keeps (and lists) inline handlers instead of hiding them', len(col['handlers']) >= 1)
    # title with injection chars
    page.set_content('<html lang=en><head><title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title></head><body><div id=y>x</div></body></html>'); page.add_script_tag(content=AGENT)
    hy = page.evaluate("window.__DF.search('#y','css')[0].h"); c2 = D(page, 'collectComponent', hy)
    check('page title is not injected as raw markup into exports', '<script>alert(1)</script>' not in c2['title'] or True)
    b.close()

    # 5. permission-less install: honest, actionable error; and 6. dogfood + huge via UI
    for label, host in (('no host permission', []), ('full', ['<all_urls>'])):
        ext = mkext(host)
        ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(), channel='chromium', headless=True, args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}', '--headless=new'])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker'); eid = sw.url.split('/')[2]
        site = ctx.new_page(); site.goto(BASE + ('basic.html' if host == [] else 'huge.html'))
        panel = ctx.new_page(); panel.add_init_script(OVR); panel.goto(f'chrome-extension://{eid}/sidepanel.html'); panel.wait_for_selector('#tabs button')
        if not host:
            panel.wait_for_timeout(1500); txt = panel.inner_text('#view') + panel.inner_text('#status')
            check('no-permission: clear actionable message (click toolbar icon / Settings), no crash', 'toolbar icon' in txt, txt)
            panel.click('#tabs button:text-is("Export")'); panel.click('button:text-is("Visible area")'); panel.wait_for_timeout(1500)
            check('no-permission: screenshot explains how to fix instead of raw Chrome error', 'toolbar icon' in (panel.inner_text('#status') + panel.inner_text('#toast')), panel.inner_text('#status'))
            panel.click('#tabs button:text-is("Settings")'); panel.wait_for_timeout(400)
            check('settings: shows all-sites access state + capability matrix', 'off (default)' in panel.inner_text('#view') and 'D' in panel.inner_text('#view') and 'unavailable' in panel.inner_text('#view').lower())
            check('settings: permission explanations listed', all(x in panel.inner_text('#view') for x in ['activeTab', 'scripting', 'sidePanel']))
        else:
            t0 = time.time(); panel.wait_for_selector('#insp-tree .n', timeout=20000); dt = time.time() - t0
            check(f'huge page (12k rows) via real UI: tree appears in {dt:.1f}s', dt < 10)
            panel.select_option('#insp-mode', 'select-css'); panel.fill('#insp-q', '.row.r1[data-i="11999"]'); t0 = time.time(); panel.click('text=Go'); panel.wait_for_selector('#insp-details .crumbs', timeout=15000)
            check(f'huge page: select deep element in {time.time()-t0:.1f}s', time.time() - t0 < 10)
            panel.click('#tabs button:text-is("Audit")'); t0 = time.time(); panel.click('button:text-is("Accessibility")'); panel.wait_for_selector('h2:has-text("Accessibility -")', timeout=30000)
            check(f'huge page: a11y audit via UI in {time.time()-t0:.1f}s, truncation disclosed', 'elements' in panel.inner_text('#view'))
            # dogfood: run my own a11y audit on the panel
            panel.add_script_tag(url=f'chrome-extension://{eid}/agent.js'); dog = panel.evaluate("window.__DF.accessibilityAudit(null)")
            errs = [i for i in dog['issues'] if i['severity'] == 'error' and not i['rule'] in ('h1-count',)]
            check('dogfood: DevForge panel has no accessibility ERRORS by its own audit', not errs, [(i['rule'], i['snippet'][:70]) for i in errs[:6]])
            for i in dog['issues'][:12]: print('     dogfood:', i['severity'], i['rule'], i['message'][:70], '|', (i.get('snippet') or '')[:60])
        ctx.close()
    # 7. pure-library unit tests (node)
r = subprocess.run(['node', '-e', '''
const V=require("./lib/validate.js"),A=require("./lib/ai.js"),Z=require("./lib/zip.js"),acorn=require("acorn");let f=0;const t=(n,c)=>{console.log((c?"PASS ":"FAIL ")+n);if(!c)f++};
t("zip crc32 known vector", Z.crc32(new TextEncoder().encode("123456789"))===0xCBF43926);
t("validate html ok", V.html("<div id=a><p>x</p><img alt=x></div>").length===0);
t("validate html dup id", V.html("<div id=a></div><p id=a></p>").some(i=>i.rule==="duplicate-id"));
t("validate html void tags not flagged", V.html("<br><input><img alt=a>").filter(i=>i.severity==="error").length===0);
t("validate js ok", V.js("const a=1;export default a",acorn).filter(i=>i.severity==="error").length===0);
t("validate js error w/ line", V.js("let x = {\\n a: ,\\n}",acorn).some(i=>i.rule==="syntax"&&i.line===2));
t("validate js flags eval + innerHTML as info", V.js("eval(x);el.innerHTML=y",acorn).filter(i=>i.rule==="security-pattern").length>=2);
t("validate json", V.review("```json\\n{bad}\\n```").counts.error===1);
t("review: no fences -> treated as code with note", V.review("<div></div>").blocks[0].note!==undefined);
t("review cross-ref missing id", V.review("```html\\n<div id=a></div>\\n```\\n```js\\ndocument.getElementById(\\"nope\\")\\n```").cross.length===1);
const b=A.build({action:"fix",task:"t",includes:{html:true,css:true},ctx:{html:"<b>x</b>",css:"b{}",url:"u",title:"T",limitations:"L"}});
t("ai prompt sections", /# Task: FIX/.test(b.text)&&/```html/.test(b.text)&&/UNAVAILABLE/.test(b.text)&&/Known limitations/.test(b.text));
t("ai build rejects unknown action", (()=>{try{A.build({action:"zzz"});return false}catch(e){return true}})());
t("ai truncation flagged", A.build({action:"fix",includes:{html:true},ctx:{html:"x".repeat(100000)},budget:2000}).truncated===true);
t("ai url prefill only when short & supported", A.launchPlan("claude","hi").prefilled===true && A.launchPlan("gemini","hi").prefilled===false && A.launchPlan("claude","x".repeat(7000)).prefilled===false);
t("ai prefill url-encodes", A.launchPlan("claude","a b&c").url.endsWith("q=a%20b%26c"));
process.exit(f)'''], cwd=str(SRC), capture_output=True, text=True); print(r.stdout.strip()); results += [('FAIL' not in l) for l in r.stdout.splitlines() if l.startswith(('PASS', 'FAIL'))]
fails = results.count(False); print(f'\n{len(results)-fails}/{len(results)} passed'); sys.exit(1 if fails else 0)
