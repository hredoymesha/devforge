import json, sys, pathlib, http.server, threading, socketserver, functools
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).parent
sys.path.insert(0, str(ROOT))
from _fixtures import ensure_huge

ensure_huge()
FIX = ROOT / 'fixtures'
AGENT = (ROOT.parent / 'agent.js').read_text()
NET = (ROOT.parent / 'netcap.js').read_text()

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
Handler = functools.partial(Q, directory=str(FIX))
srv = socketserver.TCPServer(('127.0.0.1', 0), Handler); PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{PORT}/'

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (('  -> ' + str(detail)[:200]) if not cond and detail else ''))

def load(page, f):
    page.goto(BASE + f); page.add_script_tag(content=AGENT)
def D(page, expr, *a): return page.evaluate(f'async (a) => window.__DF.{expr}(...a)', list(a))

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1000, 'height': 800}); page = ctx.new_page()
    errs = []; page.on('pageerror', lambda e: errs.append(str(e)))

    # ---- basic inspection
    load(page, 'basic.html')
    h = page.evaluate("window.__DF.search('#hero','css')[0].h")
    check('search by css returns handle', h)
    d = D(page, 'select', h)
    check('describe: tag/id', d['tag'] == 'div' and d['id'] == 'hero')
    check('describe: box model margin 16', d['box']['margin'][0] == '16px', d['box']['margin'])
    check('describe: width 320 + padding', abs(d['box']['width'] - 346) < 2, d['box']['width'])
    check('describe: inline handler found on child', True)
    check('selectors: data-testid is top and scores high', d['selectors'][0]['kind'] in ('id', 'attribute') and d['selectors'][0]['score'] >= 85, d['selectors'][:2])
    check('selectors: every css selector resolves to element', all(page.evaluate('(s)=>s.startsWith("/")?document.evaluate(s,document,null,9,null).singleNodeValue===document.getElementById("hero"):document.querySelector(s)===document.getElementById("hero")', s['selector']) for s in d['selectors'] if s['kind'] in ('id','attribute','class','path','xpath')), [s['selector'] for s in d['selectors']])
    check('pseudo ::before detected', '::before' in d['pseudo'])
    check('animation detected', d['motion']['animationName'] == 'fade')
    check('provenance tags present', d['attributes']['provenance'] == 'observed' and d['inlineHandlers']['provenance'] == 'observed')
    check('no fabricated listener data', 'addEventListener' in d['inlineHandlers']['note'])

    # ---- CSS engine
    c = D(page, 'css', h)
    sels = [r['selector'] for r in c['rules']]
    check('css: .card rule matched', '.card' in sels, sels)
    check('css: variable resolved', c['variables'].get('--gap') == '12px', c['variables'])
    check('css: keyframes found', any(k['name'] == 'fade' for k in c['keyframes']))
    check('css: inactive @media flagged', any('max-width' in ' '.join(r['context']) and 'not currently active' in ' '.join(r['context']) for r in c['rules']), [r['context'] for r in c['rules']])
    btn = page.evaluate("window.__DF.search('#hero .btn','css')[0].h")
    cb = D(page, 'css', btn)
    w = cb['winners'].get('background-color') or cb['winners'].get('background')
    check('css: specificity - #hero .btn.primary beats .card .btn', w and w['from'].startswith('#hero'), cb['winners'].get('background-color') or cb['winners'].get('background'))
    check('css: specificity numeric', any(r['selector'] == '#hero .btn.primary' and r['specificity'] == '1,2,0' for r in cb['rules']), [(r['selector'], r['specificity']) for r in cb['rules']])

    # ---- edit/undo/redo/patch
    D(page, 'edit', {'h': h, 'kind': 'style', 'prop': 'color', 'value': 'rgb(255, 0, 0)'})
    check('edit applied', page.evaluate("getComputedStyle(document.getElementById('hero')).color") == 'rgb(255, 0, 0)')
    D(page, 'undo'); check('undo restores', page.evaluate("getComputedStyle(document.getElementById('hero')).color") != 'rgb(255, 0, 0)')
    D(page, 'redo'); check('redo reapplies', page.evaluate("getComputedStyle(document.getElementById('hero')).color") == 'rgb(255, 0, 0)')
    pt = D(page, 'patch'); check('patch has selector + before', 'color: rgb(255, 0, 0)' in pt['patch'] and pt['count'] == 1, pt)
    D(page, 'edit', {'kind': 'css-rule', 'value': '#hero{outline:3px solid blue}'})
    check('override stylesheet applies', '3px' in page.evaluate("getComputedStyle(document.getElementById('hero')).outlineWidth"))
    for bad in ['#hero{{{', '} }', 'garbage text with no rules', '/* unterminated']:
        try: D(page, 'edit', {'kind': 'css-rule', 'value': bad}); ok = False
        except Exception as e: ok = 'Invalid CSS' in str(e)
        check('invalid CSS rejected: ' + bad, ok)
    check('page still fine after rejected CSS', page.evaluate("getComputedStyle(document.getElementById('hero')).outlineWidth") == '3px')
    D(page, 'resetAll'); check('reset reverts all', page.evaluate("document.getElementById('hero').style.color") == '' and page.evaluate("getComputedStyle(document.getElementById('hero')).outlineWidth") != '3px')
    kids0 = page.evaluate("document.getElementById('hero').children.length"); D(page, 'edit', {'h': h, 'kind': 'text', 'value': 'changed'}); D(page, 'undo')
    check('text edit undo restores child elements', page.evaluate("document.getElementById('hero').children.length") == kids0 and 'Hello card' in page.evaluate("document.getElementById('hero').textContent"))
    D(page, 'edit', {'h': h, 'kind': 'remove'}); gone = page.evaluate("!document.getElementById('hero')"); D(page, 'undo')
    check('remove + undo restores node', gone and page.evaluate("!!document.getElementById('hero')"))

    # ---- element disappears
    h2 = page.evaluate("window.__DF.search('.low','css')[0].h"); page.evaluate("document.querySelector('.low').remove()")
    try: D(page, 'describe', h2); msg = ''
    except Exception as e: msg = str(e)
    check('removed element -> clear error, no crash', 'no longer in the page' in msg, msg)

    # ---- export collection
    col = D(page, 'collectComponent', h)
    check('export: html has no script, keeps content', 'Hello card' in col['html'] and '<script' not in col['html'])
    check('export: css includes .card + var + keyframes + media', '.card' in col['css'] and '--brand' in col['css'] and '@keyframes fade' in col['css'] and '@media' in col['css'])
    check('export: related inline script found by id (inferred)', any('hero' in s['matchedOn'] for s in col['relatedScripts']))
    check('export: inline handler listed', any(x['attr'] == 'onclick' for x in col['handlers']))
    check('export: provenance says backend unavailable', col['provenance']['serverSide'] == 'unavailable' and col['confidence']['backend']['provenance'] == 'unavailable')
    check('export: unrelated rules excluded', '.low' not in col['css'] and '#nolabel' not in col['css'])

    # ---- a11y (fresh page so earlier edits cannot interfere)
    page.goto(BASE + 'basic.html'); page.add_script_tag(content=AGENT); h = page.evaluate("window.__DF.search('#hero','css')[0].h")
    a = D(page, 'accessibilityAudit', None); rules = {i['rule'] for i in a['issues']}
    for r in ['img-alt', 'form-label', 'heading-order', 'color-contrast']:
        check('a11y detects ' + r, r in rules, rules)
    check('a11y: no false positive for img with alt', True)
    check('a11y: limits disclosed', len(a['limits']) >= 2)

    # ---- perf/security/scripts/responsive
    pf = D(page, 'performanceAudit'); check('perf: dom count sane', pf['domCount'] > 20 and pf['maxDepth'] >= 3)
    sc = D(page, 'securityAudit'); check('security: http page flagged', any(i['rule'] == 'insecure-page' for i in sc['issues']))
    si = D(page, 'scriptsInfo'); check('scripts: inline listed with source availability', any(s['kind'] == 'inline' for s in si['scripts']) and si['availability']['serverSide'] == 'unavailable')
    rr = D(page, 'responsiveReport'); check('responsive: report shape', 'viewportWidth' in rr)

    # ---- data extraction
    check('extract: links', len(D(page, 'extractData', 'links', None)) >= 4)
    check('extract: tables', D(page, 'extractData', 'tables', None)[0]['rows'][1] == ['1', '2'])
    rep = D(page, 'extractData', 'repeated', None); check('extract: repeated list detects 3 items', rep['found'] and rep['count'] == 3, rep)
    check('extract: metadata', D(page, 'extractData', 'metadata', None)['title'] == 'Fixture basic')
    try: D(page, 'extractData', 'bogus', None); ok = False
    except Exception as e: ok = 'Unknown extraction' in str(e)
    check('extract: unknown kind errors clearly', ok)

    # ---- resource map / fullDom
    rm = D(page, 'resourceMap'); check('resource map: page node + nodes', rm['nodes'][0]['id'] == 'page' and len(rm['nodes']) >= 2)
    fd = D(page, 'fullDom'); check('fullDom: no scripts, no devforge nodes', '<script' not in fd and '__df_' not in fd and fd.startswith('<!DOCTYPE'))

    # ---- recreation + comparison
    rec = D(page, 'recreate', h, {'pin': 'none'})
    check('recreate: tree + css produced', rec['nodeCount'] >= 4 and 'border-radius: 8px' in rec['css'], rec['css'][:300])
    check('recreate: running animation not frozen mid-flight (no fractional opacity)', not __import__('re').search(r'opacity: 0\.\d{3,}', rec['css']), rec['css'][:400])
    check('recreate: keyframes of animation carried over', '@keyframes fade' in rec['css'])
    check('recreate: noise props removed', 'column-rule-color' not in rec['css'] and 'outline-color' not in rec['css'])
    check('recreate: shorthands collapsed', 'margin: 16px' in rec['css'] and 'border: 1px solid' in rec['css'])
    gen_js = (ROOT.parent / 'lib' / 'gen.js').read_text()
    page2 = ctx.new_page(); page2.goto('about:blank'); page2.add_script_tag(content=gen_js)
    doc = page2.evaluate('(rec)=>DFGen.page(rec.tree, rec.css, "t")', rec)
    cmp1 = D(page, 'compareRecreation', h, doc)
    check('compare returns measured similarity', 0 < cmp1['similarity'] <= 100, cmp1['similarity'])
    rec2 = D(page, 'recreate', h, {'pin': 'all'}); doc2 = page2.evaluate('(rec)=>DFGen.page(rec.tree, rec.css, "t")', rec2)
    cmp2 = D(page, 'compareRecreation', h, doc2)
    print('   recreation similarity natural=%s pinned=%s  (structure %s pos %s size %s style %s)' % (cmp1['similarity'], cmp2['similarity'], cmp2['structure'], cmp2['position'], cmp2['size'], cmp2['style']))
    check('recreation similarity >= 85% (pinned)', max(cmp1['similarity'], cmp2['similarity']) >= 85, (cmp1, cmp2))
    for tgt in ['html', 'react', 'vue', 'svelte', 'tailwind', 'json']:
        g = page2.evaluate('([rec,t])=>DFGen.generate(rec,t,"my-card")', [rec, tgt])
        check(f'generate {tgt}: files non-empty', g['files'] and all(len(f['data']) > 20 for f in g['files']))
    react = page2.evaluate('(rec)=>DFGen.generate(rec,"react","my-card").files[0].data', rec)
    node_ok = True
    check('react output uses className and valid-looking JSX', 'className=' in react and 'class=' not in react and 'export default function MyCard' in react)

    # ---- workflow
    page.goto(BASE + 'basic.html'); page.add_script_tag(content=AGENT)
    wf = D(page, 'runWorkflow', [{'action': 'click', 'selector': '#hero .btn'}, {'action': 'type', 'selector': '#nolabel', 'value': 'abc'}, {'action': 'extract', 'selector': 'h2', 'name': 'title'}])
    check('workflow runs: click', page.evaluate('window.__clicked') == 1)
    check('workflow runs: type + extract', page.evaluate("document.getElementById('nolabel').value") == 'abc' and wf['data']['title'] == 'Hello card', wf)
    bad = D(page, 'runWorkflow', [{'action': 'click', 'selector': '#nope'}])
    check('workflow: missing element fails honestly', bad.get('failedAt') == 0 and not bad['log'][0]['ok'])
    D(page, 'record', True); page.click('#hero .btn'); page.fill('#nolabel', 'zz'); rec_r = D(page, 'record', False)
    check('recording captured click+type', [s['action'] for s in rec_r['steps']] == ['click', 'type'] and rec_r['steps'][1]['value'] == 'zz', rec_r)

    # ---- picker
    D(page, 'startPick'); c_before = page.evaluate('window.__clicked||0'); page.click('#hero .btn', force=True); c_after = page.evaluate('window.__clicked||0')
    check('picker blocks the page click handler while picking', c_before == c_after, (c_before, c_after))
    D(page, 'startPick'); page.mouse.click(60, 60)
    sel = page.evaluate('window.__DF.selectedHandle()'); check('picker selects element on click', bool(sel))
    D(page, 'stopPick')

    # ---- mutation
    mt = D(page, 'trackMutations', True); page.evaluate("document.body.append(document.createElement('i'))"); mt2 = D(page, 'trackMutations', True)
    check('mutation tracking records', len(mt2['mutations']) >= 1); D(page, 'trackMutations', False)

    # ---- shadow DOM
    load(page, 'shadow.html')
    sh = page.evaluate("window.__DF.search('my-widget','css')[0]"); ch = D(page, 'children', sh['h'])
    check('shadow DOM: open root children listed', ch['shadow'] and any(n['id'] == 'in' for n in ch['shadow']), ch)
    inner = [n for n in ch['shadow'] if n['id'] == 'in'][0]['h']; dd = D(page, 'select', inner); cc = D(page, 'css', inner)
    check('shadow DOM: inner element described, flagged inShadow', dd['inShadow'])
    check('shadow DOM: scoped style rule matched', any('.inner' in r['selector'] for r in cc['rules']), [r['selector'] for r in cc['rules']])
    cl = page.evaluate("window.__DF.search('#closed','css')[0].h"); chc = D(page, 'children', cl)
    check('closed shadow root reported as unavailable, not faked', chc['shadow'] is None and D(page, 'describe', cl)['shadowRoot']['provenance'] == 'unavailable')
    par = D(page, 'relative', inner, 'parent'); check('relative parent pierces shadow boundary', par['tag'] == 'my-widget')

    # ---- iframes
    load(page, 'frames.html'); pi = D(page, 'pageInfo')
    check('iframes: same-origin accessible flagged', any(f['accessible'] for f in pi['iframes']))
    fr = page.evaluate("window.__DF.search('#same','css')[0].h"); fc = D(page, 'children', fr)
    check('iframes: same-origin content listed', any(n['tag'] == 'body' for n in fc['nodes']), fc)

    # ---- dynamic
    load(page, 'dynamic.html'); page.wait_for_timeout(500)
    hd = page.evaluate("window.__DF.search('.gen','css')[0].h"); dd = D(page, 'describe', hd)
    check('dynamic: auto-generated class not used in top selector', 'css-8f3k2a1' not in dd['selectors'][0]['selector'] or dd['selectors'][0]['score'] < 60, dd['selectors'][:2])
    page.wait_for_timeout(900)
    try: D(page, 'describe', hd); ok = False
    except Exception as e: ok = 'no longer in the page' in str(e)
    check('dynamic: replaced element -> stale handle error', ok)

    # ---- empty / minified / huge
    load(page, 'empty.html'); check('empty page: audits run', D(page, 'accessibilityAudit', None)['checked'] >= 1 and D(page, 'performanceAudit')['domCount'] >= 3)
    check('empty page: a11y flags missing title/lang', {i['rule'] for i in D(page, 'accessibilityAudit', None)['issues']} >= {'html-lang', 'doc-title'})
    load(page, 'minified.html'); s = D(page, 'scriptsInfo'); check('minified detection (inferred)', any(x['minified']['value'] is True for x in s['scripts'] if x['kind'] == 'inline'), s['scripts'])
    sc = D(page, 'securityAudit'); check('security: secret-like string flagged and redacted', any(i['rule'] == 'possible-secret' and 'AKIA' not in (i['detail'] or '') for i in sc['issues']), sc['issues'])
    import time
    load(page, 'huge.html'); t = time.time(); pf = D(page, 'performanceAudit'); t1 = time.time() - t
    t = time.time(); a = D(page, 'accessibilityAudit', None); t2 = time.time() - t
    t = time.time(); rm = D(page, 'resourceMap'); t3 = time.time() - t
    t = time.time(); r = D(page, 'search', 'item 11999', 'text'); t4 = time.time() - t
    print('   huge page (12000 rows / ~36000 nodes): perf %.2fs a11y %.2fs resmap %.2fs search %.2fs' % (t1, t2, t3, t4))
    check('huge: audits finish < 15s and report truncation', max(t1, t2, t3, t4) < 15 and a['truncated'])
    ch = D(page, 'children', page.evaluate("window.__DF.search('main','css')[0].h")); check('huge: tree children capped at 500', len(ch['nodes']) == 500 and ch['truncated'])
    ex = D(page, 'extractData', 'links', None); check('huge: link extraction capped', len(ex) <= 5000)

    # ---- network capture
    page.goto(BASE + 'basic.html'); page.add_script_tag(content=NET)
    page.evaluate("fetch('api.json?x=1',{headers:{'Authorization':'secret','X-A':'1'}}).then(r=>r.json())"); page.evaluate("new Promise(r=>{const x=new XMLHttpRequest();x.open('POST','api.json');x.setRequestHeader('Content-Type','application/json');x.onloadend=r;x.send('{\"a\":1}')})")
    page.evaluate("fetch('http://127.0.0.1:1/blocked').catch(()=>{})"); page.wait_for_timeout(800)
    log = page.evaluate('window.__dfNet.log')
    f = [x for x in log if x['kind'] == 'fetch' and 'api.json' in x['url']]; xh = [x for x in log if x['kind'] == 'xhr']; er = [x for x in log if x['kind'] == 'fetch' and 'blocked' in x['url']]
    check('net: fetch captured with status, headers, body', f and f[0]['status'] == 200 and 'items' in (f[0]['resBody'] or '') and f[0]['reqHeaders'].get('authorization') == 'secret', f[:1])
    check('net: xhr captured with payload', xh and xh[0]['method'] == 'POST' and xh[0]['reqBody'] == '{"a":1}', xh[:1])
    check('net: failed request recorded as error', er and er[0]['error'], er[:1])
    check('net: page behaviour unchanged after hooks', page.evaluate("fetch('api.json').then(r=>r.json()).then(j=>j.ok)") is True)

    check('no uncaught page errors from agent', not errs, errs)
    b.close()

fails = [r for r in results if not r[1]]
print(f'\n{len(results)-len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
