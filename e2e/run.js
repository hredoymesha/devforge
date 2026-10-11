#!/usr/bin/env node
/*
 * Browser tests: load the unpacked extension into Chromium and drive the real panel against local
 * training sites (e2e/fixtures.js). They are not part of `npm test` because they need Playwright
 * and a Chromium build, which the extension itself does not depend on.
 *
 *   node e2e/run.js [--shots <dir>]
 *
 * Playwright is found with require('playwright'), then $PLAYWRIGHT_MODULE, then the global
 * location used in the cloud sessions. Set CHROME_PATH to use a specific Chromium.
 *
 * The extension is copied to a scratch folder first, with host access added to the copy's manifest,
 * because optional host permissions cannot be granted without a user gesture. The repository's own
 * manifest is never modified. A second copy of the ORIGINAL 4.0.0 commit is used to show that the
 * fixed bugs were real.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startFixtures } = require('./fixtures.js');

function loadPlaywright() {
  for (const id of ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright']) {
    if (!id) continue;
    try {
      return require(id);
    } catch (_) {
      /* try the next location */
    }
  }
  throw new Error('Playwright not found. Install it or set PLAYWRIGHT_MODULE.');
}
const { chromium } = loadPlaywright();

const root = path.resolve(__dirname, '..');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const EXT_FILES = ['manifest.json', 'background.js', 'sidepanel.html', 'sidepanel.css', 'agent.js', 'agent', 'lib', 'panel', 'netcap.js', 'netbridge.js', 'sandbox.html', 'sandbox.js', 'icons'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '\n         ' + String(detail).slice(0, 400)));
}

function prepareExtension(dest, from) {
  fs.mkdirSync(dest, { recursive: true });
  if (from) {
    // The original commit, read from git history without touching the working tree.
    const tar = execFileSync('git', ['archive', from], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dest], { input: tar });
  } else {
    for (const f of EXT_FILES) fs.cpSync(path.join(root, f), path.join(dest, f), { recursive: true });
  }
  const mf = path.join(dest, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = ['<all_urls>'];
  fs.writeFileSync(mf, JSON.stringify(m));
  return dest;
}

async function launch(extDir, profile) {
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: process.env.CHROME_PATH || chromium.executablePath(),
    args: ['--headless=new', '--no-sandbox', '--host-resolver-rules=MAP example.com 127.0.0.1', '--disable-extensions-except=' + extDir, '--load-extension=' + extDir],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  return { ctx, sw, id: sw.url().split('/')[2] };
}

// Opens the panel as a normal tab and points its "active tab" lookup at the page under test.
async function openPanel(env, targetUrl) {
  const target = await env.ctx.newPage();
  await target.goto(targetUrl);
  const pattern = targetUrl.replace(/[?#].*$/, '').replace(/\/$/, '') + '/*';
  // Newest matching tab: earlier tests may have left pages open on the same origin.
  const tabId = await env.sw.evaluate(async (p) => (await chrome.tabs.query({ url: p })).sort((a, b) => b.id - a.id)[0].id, pattern);
  const panel = await env.ctx.newPage();
  const closePanel = panel.close.bind(panel);
  panel.close = async () => {
    await closePanel();
    await target.close();
  };
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${env.id}/sidepanel.html`);
  await panel.evaluate((id) => {
    chrome.tabs.query = async () => [await chrome.tabs.get(id)];
  }, tabId);
  return { target, panel, tabId, errors };
}

const reportOf = (panel) => panel.evaluate(() => SEC.report);

async function runScan(panel, level, { confirm = false, advancedConfirm = false } = {}) {
  await panel.evaluate(() => {
    SEC.view = 'setup';
    SEC.report = null;
    show('security');
  });
  await panel.waitForSelector('#sec-lv-' + level);
  await panel.check('#sec-lv-' + level);
  if (confirm) await panel.check('#sec-ack');
  if (advancedConfirm) await panel.check('#sec-ack-adv');
  await panel.click('button:has-text("Start scan")');
  await panel.waitForSelector('.sec-head', { timeout: 120000 });
  return reportOf(panel);
}


// Runs inside the page, exactly as an untrusted script could. Returns what it managed to learn.
const pageAttack = (marker) => {
  const r = { globalType: typeof window.__dfNet, entryCandidates: 0, leaked: false, foundMarker: false, redefined: false, tried: 0 };
  const frame = document.createElement('iframe');
  document.documentElement.appendChild(frame);
  const clean = new Set(Object.getOwnPropertyNames(frame.contentWindow));
  frame.remove();
  const extra = Object.getOwnPropertyNames(window).filter((k) => !clean.has(k));
  const forged = [{ id: 'x', enabled: true, action: 'mock', match: '/slow', status: 200, body: 'FORGED' }];
  for (const k of extra) {
    let v;
    try {
      v = window[k];
    } catch (_) {
      continue;
    }
    if (typeof v !== 'function') continue;
    const isEntry = /^_[0-9a-f]{20}$/.test(k); // the test knows the naming scheme; a page script would have to guess
    if (isEntry) r.entryCandidates++;
    for (const secret of [undefined, null, '', 'x', 'secret', '0'.repeat(64), k])
      for (const cmd of ['changes', 'get', 'captured', 'clear', 'setRules', 'ruleHits', 'ping']) {
        r.tried++;
        try {
          if (v(secret, cmd, cmd === 'setRules' ? forged : 0) !== undefined) r.leaked = true;
        } catch (_) {
          /* a throwing candidate learns nothing either */
        }
      }
    if (isEntry) {
      try {
        Object.defineProperty(window, k, { value: () => 'FORGED' });
        r.redefined = true;
      } catch (_) {
        /* non-configurable: cannot be replaced */
      }
      r.entryEnumerable = Object.keys(window).includes(k);
    }
  }
  const seen = new WeakSet();
  const has = (val, depth) => {
    if (depth > 5 || val == null) return false;
    if (typeof val === 'string') return val.includes(marker);
    if (typeof val !== 'object' && typeof val !== 'function') return false;
    if (seen.has(val)) return false;
    seen.add(val);
    try {
      for (const key of Object.getOwnPropertyNames(val)) {
        let x;
        try {
          x = val[key];
        } catch (_) {
          continue;
        }
        if (has(x, depth + 1)) return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  };
  for (const k of Object.getOwnPropertyNames(window)) {
    if (['top', 'parent', 'self', 'window', 'frames', 'document', 'location', 'opener', 'frameElement', 'history', 'performance', 'navigator', 'caches', 'localStorage', 'sessionStorage'].includes(k)) continue;
    try {
      if (has(window[k], 0)) r.foundMarker = true;
    } catch (_) {
      /* ignore */
    }
  }
  r.isolatedWorldKeyVisible = typeof globalThis.__dfNetKey !== 'undefined';
  return r;
};
const MARKER = 'MARKER-SECRET-TOKEN-123';
const sendSecrets = (page) =>
  page.evaluate(async (m) => {
    await fetch('/slow', { method: 'POST', headers: { authorization: 'Bearer ' + m, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'MARKER-PASSWORD-456' }) });
  }, MARKER);

async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devforge-e2e-'));
  const fx = await startFixtures();
  const vuln = `http://127.0.0.1:${fx.vuln.port}/`;
  // A different host name from the vulnerable site: cookies are shared across ports on one host.
  const spa = `http://localhost:${fx.spa.port}/`;
  const publicUrl = `http://example.com:${fx.vuln.port}/`;
  const extDir = prepareExtension(path.join(scratch, 'ext'));
  const env = await launch(extDir, path.join(scratch, 'profile'));
  try {
    /* ---------- every tab renders ---------- */
    console.log('\nPanel');
    {
      const { panel, errors } = await openPanel(env, vuln);
      const tabs = await panel.evaluate(() => DF.tabs.map((t) => t.id));
      for (const t of tabs) {
        await panel.evaluate((id) => show(id), t);
        await panel.waitForTimeout(120);
      }
      check('all ' + tabs.length + ' tabs render without page errors', errors.length === 0, errors.join(' | '));
      check('Security tab is registered', tabs.includes('security'));
      await panel.close();
    }

    /* ---------- navigation, Home, narrow layout, accessibility ---------- */
    console.log('\nNavigation and Home');
    {
      const { panel, errors } = await openPanel(env, vuln);
      await panel.evaluate(() => show('home'));
      await panel.waitForSelector('.home-grid');
      check('Home lists the quick actions', (await panel.locator('.home-tile').count()) >= 8);
      await panel.waitForSelector('.home-status.sev-ok', { timeout: 10000 });
      check('Home reports that DevForge can work on the page', /Ready on/.test(await panel.locator('.home-status').innerText()));
      check('a new profile starts on Home with a welcome note', (await panel.locator('.home-welcome').count()) === 1);
      check('every tab button has an accessible name and an icon', await panel.evaluate(() => [...document.querySelectorAll('#tabs button')].every((b) => b.getAttribute('aria-label') && b.querySelector('svg.ico'))));
      if (shotsDir) await panel.screenshot({ path: path.join(shotsDir, 'home-wide.png') });

      await panel.setViewportSize({ width: 380, height: 760 });
      await panel.waitForTimeout(250);
      const narrow = await panel.evaluate(() => {
        const tabs = [...document.querySelectorAll('#tabs button')].filter((b) => !b.hidden);
        const labelShown = (b) => getComputedStyle(b.querySelector('.tab-label')).display !== 'none';
        return {
          compact: document.querySelector('#tabs').classList.contains('compact'),
          visible: tabs.length,
          selectedShowsName: tabs.filter((b) => b.getAttribute('aria-selected') === 'true').every(labelShown),
          othersIconOnly: tabs.filter((b) => b.getAttribute('aria-selected') !== 'true').every((b) => !labelShown(b)),
          overflowShown: !document.querySelector('#tabs-more').hidden,
          fits: document.querySelector('#tabs').scrollWidth <= document.querySelector('#tabs').clientWidth + 1,
          noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
        };
      });
      check('at 380px the tab bar is compact: selected shows its name, others are icons', narrow.compact && narrow.selectedShowsName && narrow.othersIconOnly, JSON.stringify(narrow));
      check('at 380px tabs fit without clipping and the rest move to the overflow menu', narrow.fits && narrow.overflowShown, JSON.stringify(narrow));
      check('at 380px the page does not scroll sideways', narrow.noHScroll, JSON.stringify(narrow));
      await panel.click('#tabs-more');
      const items = await panel.locator('#tabs-menu [role=menuitem]').count();
      check('the overflow menu lists the hidden panels with icons', items > 0 && (await panel.locator('#tabs-menu [role=menuitem] svg.ico').count()) === items);
      await panel.keyboard.press('s');
      check('type-ahead moves through the overflow menu', await panel.evaluate(() => document.activeElement.dataset.label.toLowerCase().startsWith('s')));
      await panel.keyboard.press('Escape');
      await panel.evaluate(() => show('security'));
      await panel.waitForSelector('.sec-levels');
      check('the Security setup has no horizontal scroll at 380px', await panel.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      check('every button and form control in Security setup has a name', await panel.evaluate(() => [...document.querySelectorAll('#view button, #view input, #view select')].every((el) => (el.getAttribute('aria-label') || el.innerText || (el.labels && el.labels[0] && el.labels[0].innerText) || el.title || '').trim())));
      if (shotsDir) await panel.screenshot({ path: path.join(shotsDir, 'security-setup-narrow.png'), fullPage: true });
      await panel.setViewportSize({ width: 1280, height: 720 });
      await panel.waitForTimeout(200);
      check('widening the panel restores full tab names', await panel.evaluate(() => !document.querySelector('#tabs').classList.contains('compact')));

      // accessibility sweep over every panel at WCAG 1.4.10 reflow width (320 CSS px)
      await panel.setViewportSize({ width: 320, height: 760 });
      await panel.waitForTimeout(250);
      const ids = await panel.evaluate(() => [...ORDER]);
      const problems = [];
      for (const id of ids) {
        await panel.evaluate((t) => show(t), id);
        await panel.waitForTimeout(350);
        await panel.keyboard.press('Escape');
        const r = await panel.evaluate(() => {
          const name = (el) => {
            const lb = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((i) => (document.getElementById(i) || {}).innerText || '').join(' ');
            return (el.getAttribute('aria-label') || lb || el.innerText || el.textContent || (el.labels && el.labels[0] && el.labels[0].innerText) || el.title || el.getAttribute('placeholder') || el.value || '').trim();
          };
          const visible = (el) => !el.closest('[hidden]') && el.getClientRects().length > 0;
          const controls = [...document.querySelectorAll('#view button, #view input:not([type=hidden]), #view select, #view textarea, #view [role=button], #view [role=tab], #view a[href], #view summary')].filter(visible);
          const unnamed = controls.filter((el) => !name(el)).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
          const seen = new Map();
          document.querySelectorAll('[id]').forEach((el) => seen.set(el.id, (seen.get(el.id) || 0) + 1));
          const dupes = [...seen].filter(([, n]) => n > 1).map(([i]) => i);
          const posTab = [...document.querySelectorAll('#view [tabindex]')].filter((el) => +el.getAttribute('tabindex') > 0).length;
          return { unnamed, dupes, posTab, hscroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
        });
        if (r.unnamed.length) problems.push(id + ': unnamed controls ' + r.unnamed.slice(0, 5).join(', '));
        if (r.dupes.length) problems.push(id + ': duplicate ids ' + r.dupes.join(', '));
        if (r.posTab) problems.push(id + ': positive tabindex');
        if (r.hscroll) problems.push(id + ': horizontal scroll at 320px');
      }
      check('every panel at 320px: controls have names, ids are unique, no positive tabindex, no sideways scroll', problems.length === 0, problems.join(' | '));
      await panel.setViewportSize({ width: 1280, height: 720 });
      await panel.waitForTimeout(200);

      // network security signals
      const sig = await panel.evaluate(() => {
        DF.state.url = 'https://example.com/';
        return {
          insecure: netSignals({ url: 'http://api.example.net/a' }),
          sensitive: netSignals({ url: 'https://api.example.net/a?access_token=1&q=2' }),
          cors: netSignals({ url: 'https://api.example.net/a', resHeaders: { 'access-control-allow-origin': '*' } }),
          local: netSignals({ url: 'http://localhost:3000/a' }),
          clean: netSignals({ url: 'https://api.example.net/a?author=bob' }),
        };
      });
      check('network signals: insecure, sensitive and open-CORS requests are flagged', sig.insecure[0] === 'insecure' && sig.sensitive[0] === 'sensitive' && sig.cors[0] === 'open-cors', JSON.stringify(sig));
      check('network signals: localhost and harmless parameters are not', !sig.local.length && !sig.clean.length, JSON.stringify(sig));
      const filtered = await panel.evaluate(() => {
        DF.state.url = 'https://example.com/';
        const terms = parseQuery('is:insecure');
        const row = (url) => ({ url, method: 'GET', cat: 'fetch' });
        return [rowMatches(row('http://a.example.net/x'), terms), rowMatches(row('https://a.example.net/x'), terms), rowMatches({ ...row('https://a.example.net/x'), resHeaders: { server: 'nginx/1.2' } }, parseQuery('header:server=nginx'))];
      });
      check('network filter: is:insecure and header:name=value work', filtered[0] === true && filtered[1] === false && filtered[2] === true, JSON.stringify(filtered));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- the capture log is private to the extension ---------- */
    console.log('\nCapture channel (netcap.js): untrusted page scripts');
    {
      const { panel, target, errors } = await openPanel(env, vuln);
      await panel.evaluate(() => startCapture());
      await sendSecrets(target);
      await target.waitForTimeout(300);
      const a = await target.evaluate(pageAttack, MARKER);
      check('there is no window.__dfNet any more', a.globalType === 'undefined', JSON.stringify(a));
      check('the hidden entry point exists (exactly one), so the test is meaningful', a.entryCandidates === 1, JSON.stringify(a));
      check('it is not enumerable (Object.keys(window) does not list it)', a.entryEnumerable === false, JSON.stringify(a));
      check('a page script cannot get anything out of the entry point without the secret (' + a.tried + ' probes)', !a.leaked, JSON.stringify(a));
      check('nothing reachable from window contains the captured Authorization header', !a.foundMarker);
      check('the entry point cannot be replaced by the page', !a.redefined);
      check('the isolated-world key holder is invisible to the page', !a.isolatedWorldKeyVisible);
      check('forged interception rules were not installed by the page', (await target.evaluate(() => fetch('/slow').then((r) => r.text()))) === 'slow ok');

      check('the panel can still reach capture', (await panel.evaluate(() => netCall('ping'))) === 'pong');
      const entry = await panel.evaluate(async () => {
        const ch = await netCall('changes', 0);
        const post = ch.entries.find((e) => e.method === 'POST');
        const full = await netCall('get', post.id);
        return { auth: full.reqHeaders.authorization, redacted: redactEntry(full).reqHeaders.authorization, body: full.reqBody };
      });
      check('the extension sees the full record', entry.auth === 'Bearer ' + MARKER && /MARKER-PASSWORD-456/.test(entry.body));
      check('the Network tab view still redacts it', entry.redacted === '[redacted]');

      // a second panel (reopened side panel) reconnects through session storage
      const panel2 = await env.ctx.newPage();
      await panel2.goto(`chrome-extension://${env.id}/sidepanel.html`);
      await panel2.evaluate((id) => {
        chrome.tabs.query = async () => [await chrome.tabs.get(id)];
      }, await env.sw.evaluate(async (p) => (await chrome.tabs.query({ url: p })).sort((x, y) => y.id - x.id)[0].id, vuln.replace(/\/$/, '') + '/*'));
      check('a reopened panel reconnects without re-injecting', (await panel2.evaluate(() => netCall('ping'))) === 'pong');
      await panel2.close();

      // pressing Start twice must not wrap fetch twice
      await panel.evaluate(() => startCapture());
      await panel.evaluate(() => netCall('clear'));
      await target.evaluate(() => fetch('/slow'));
      await target.waitForTimeout(250);
      check('starting capture again does not double-record requests', (await panel.evaluate(async () => (await netCall('changes', 0)).entries.length)) === 1);

      // a reload discards capture and the old key is not mistaken for a live one
      await target.reload();
      check('after a reload the old key is reported as not connected', (await panel.evaluate(() => netCall('ping'))) === null);
      await panel.evaluate(() => startCapture());
      check('capture can be started again after the reload', (await panel.evaluate(() => netCall('ping'))) === 'pong');
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    console.log('\nPage agent hardening (findings from the line-by-line audit)');
    {
      const { panel, target, errors } = await openPanel(env, vuln + 'agent-hostile');
      const sel = (css) => panel.evaluate((c) => call('selectBySelector', c), css);
      const big = await sel('#big');
      const t0 = Date.now();
      const comp = await panel.evaluate((h) => call('collectComponent', h, {}).then((r) => ({ ok: true, n: (r.html || '').length }), (e) => ({ ok: false, e: e.message })), big.h);
      check('a style attribute with 20,000 unclosed url( finishes quickly (was quadratic)', comp.ok && Date.now() - t0 < 2500, JSON.stringify(comp) + ' ' + (Date.now() - t0) + ' ms');
      const t1 = Date.now();
      const map = await panel.evaluate(() => call('resourceMap').then((r) => ({ ok: true, nodes: r.nodes.length }), (e) => ({ ok: false, e: e.message })));
      check('resourceMap survives unparseable addresses (script src="http://[" and url("http://["))', map.ok && map.nodes > 1 && Date.now() - t1 < 2500, JSON.stringify(map));
      const p = await sel('#p');
      const css = await panel.evaluate((h) => call('css', h).then((r) => ({ ok: true, rules: (r.matched || r.rules || []).length || JSON.stringify(r).includes('blue') }), (e) => ({ ok: false, e: e.message })), p.h);
      check('CSS inspection works on a page whose stylesheet has an @import rule', css.ok && css.rules, JSON.stringify(css));
      const attrSels = await panel.evaluate((h) => call('_selectorsFor', h), p.h);
      const roundTrip = await target.evaluate((list) => list.filter((s) => s.kind !== 'xpath' && !/^xpath/.test(s.kind)).every((s) => { try { const m = document.querySelectorAll(s.selector); return m.length === 1 && m[0].id === 'p'; } catch (_) { return false; } }), attrSels);
      check('every generated selector round-trips to exactly the element, even with a backslash-quote in an attribute', roundTrip, JSON.stringify(attrSels.map((s) => s.selector)));

      // exports: script-free means script-free
      const dom = await panel.evaluate(() => call('fullDom', false));
      const html = typeof dom === 'string' ? dom : dom.html;
      const withoutNoscript = html.replace(/<noscript>[\s\S]*<\/noscript>/gi, '');
      const bad = {
        handlers: /\son[a-z]+\s*=/i.test(withoutNoscript),
        srcdoc: /\ssrcdoc\s*=/i.test(html),
        js: /(?:href|formaction|src|action)\s*=\s*["']?\s*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(html),
        refresh: /http-equiv\s*=\s*["']?refresh/i.test(html),
        breakout: /<\/noscript>\s*<img/i.test(html),
      };
      check('fullDom without scripts has no handlers, srcdoc, javascript: addresses, meta refresh or raw-text break-out', !Object.values(bad).some(Boolean), JSON.stringify(bad));
      const kept = await panel.evaluate(() => call('fullDom', true).then((d) => (typeof d === 'string' ? d : d.html)));
      check('even with scripts kept, a <noscript> text node cannot break out into live markup', !/<\/noscript>\s*<img/i.test(kept.replace(/<script[\s\S]*?<\/script>/gi, '')), kept.slice(kept.indexOf('<noscript') - 10, kept.indexOf('<noscript') + 160));
      const j = await sel('#js');
      const comp2 = await panel.evaluate((h) => call('collectComponent', h, { stripHandlers: true }).then((r) => r.html), j.h);
      check('component export with handlers stripped drops onclick and the tab-split javascript: link', !/onclick/i.test(comp2) && !/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(comp2), comp2.slice(0, 200));

      // forged input
      const before = await panel.evaluate(() => call('selectedHandle'));
      await panel.evaluate(() => call('startPick'));
      await target.evaluate(() => document.getElementById('p').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })));
      await target.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await target.waitForTimeout(150);
      const selNow = await panel.evaluate(() => call('selectedHandle'));
      check('a forged click does not change the selection', selNow === before, before + ' -> ' + selNow);
      // a forged Escape must not end the pick: a real click afterwards still selects
      await target.mouse.click(30, 30);
      await target.waitForTimeout(150);
      const afterReal = await panel.evaluate(() => call('selectedHandle'));
      check('the pick survived the forged Escape and a real click still selects', afterReal !== before, before + ' -> ' + afterReal);
      await panel.evaluate(() => call('stopPick'));

      // patch export cannot be turned into CSS by page-controlled text
      await panel.evaluate((h) => call('edit', { h, kind: 'attr', prop: 'data-x', value: 'a */ body{color:red} /* b' }), p.h);
      const patch = await panel.evaluate(() => call('patch').then((r) => r.patch));
      const outside = patch.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      check('an exported patch cannot be broken out of a comment by page text (nothing is left outside the comment)', outside === '' && /body\{color:red\}/.test(patch), patch);
      await panel.evaluate(() => call('resetAll'));

      // limits
      const many = await panel.evaluate(() => call('runWorkflow', Array.from({ length: 500 }, () => ({ action: 'wait', ms: 1 }))).then(() => 'ran', (e) => e.message));
      check('a workflow of 500 steps is refused', /at most 200/.test(many), many);
      const notList = await panel.evaluate(() => call('runWorkflow', { action: 'wait' }).then(() => 'ran', (e) => e.message));
      check('a workflow that is not a list is refused', /list of steps/.test(notList), notList);
      const pageOrigin = await target.evaluate(() => location.origin);
      const noLimit = await panel.evaluate((o) => call('fetchInPage', o + '/slow').then(() => 'fetched', (e) => e.message), pageOrigin);
      check('fetchInPage refuses to run without a size limit', /size limit is required/.test(noLimit), noLimit);
      const okFetch = await panel.evaluate((o) => call('fetchInPage', o + '/slow', 1000).then((r) => r.bytes, (e) => e.message), pageOrigin);
      check('fetchInPage still works with a limit', okFetch === 7, String(okFetch));
      const tooBig = await panel.evaluate((o) => call('fetchInPage', o + '/slow', 3).then(() => 'fetched', (e) => e.message), pageOrigin);
      check('fetchInPage enforces the limit while reading', /too large/.test(tooBig), tooBig);
      const textNode = await panel.evaluate(() => call('selectBySelector', '//p/text()', 'xpath').then(() => 'selected', (e) => e.message));
      check('an XPath that resolves to a text node is refused instead of becoming the selection', /not an element/.test(textNode), textNode);
      await panel.evaluate(() => call('record', true));
      await target.evaluate(() => document.getElementById('p').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
      const rec = await panel.evaluate(() => call('record', false));
      check('the workflow recorder ignores clicks a page script made up', rec.steps.length === 0, JSON.stringify(rec.steps));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    console.log('\nOpener isolation rule (agent securityAudit)');
    {
      const { panel, errors } = await openPanel(env, vuln + 'links');
      const audit = await panel.evaluate(() => call('securityAudit'));
      const issues = (audit.issues || audit).filter((i) => /opener|noopener/.test(i.rule));
      const by = (re) => issues.filter((i) => re.test(i.detail || '')).map((i) => i.rule);
      check('target=_blank without rel is not reported (browsers isolate it by default)', by(/other\.example\/a/).length === 0 && by(/other\.example\/b/).length === 0);
      check('rel=opener on a cross-origin link is reported', by(/other\.example\/c/).join() === 'opener-exposed', JSON.stringify(issues));
      check('a named target without noopener is reported', by(/other\.example\/d/).join() === 'named-target-opener');
      check('a named target with noreferrer is not reported', by(/other\.example\/e/).length === 0);
      check('same-origin links are never reported', !issues.some((i) => /\/x\b/.test(i.detail || '')));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    console.log('\nOn-demand capture requested while the page is still loading');
    {
      const url = vuln + 'hostile-slow';
      const target = await env.ctx.newPage();
      await target.goto(url, { waitUntil: 'commit' });
      await target.waitForTimeout(300);
      // The panel's own call (exec -> executeScript with default timing), issued while the page is
      // still streaming. It must wait for the document to be ready, which is what keeps the handshake
      // branch of netcap.js (document_start only) closed to page scripts. If someone adds
      // injectImmediately to that call, this test fails.
      const injected = await env.sw.evaluate(async (p) => {
        const tab = (await chrome.tabs.query({ url: p })).sort((a, b) => b.id - a.id)[0];
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['netcap.js'], world: 'MAIN' });
        return { result: r && r.result };
      }, url + '*');
      const stateAtInject = await target.evaluate(() => document.readyState);
      check('injection waited until the document was ready, not mid-load', stateAtInject !== 'loading', stateAtInject);
      check('the key is returned to the extension as the injection result', !!(injected.result && injected.result.n && injected.result.s));
      await target.waitForLoadState('load');
      const late = await target.evaluate(() => window.__late);
      check('a script that runs later in the same page cannot obtain the key by replaying the handshake', Array.isArray(late) && late.length === 0, JSON.stringify(late).replace(/"s":"[0-9a-f]+"/g, '"s":"…"'));
      await target.close();
    }

    console.log('\nCapture on a page that poisons built-ins before and after DevForge starts');
    {
      const { panel, target, errors } = await openPanel(env, vuln + 'hostile-proto');
      await panel.evaluate(async () => {
        await activeTab();
        await setPersistent(true);
      });
      await target.reload();
      await target.waitForLoadState('load');
      check('the hostile page installed its hooks', await target.evaluate(() => Array.isArray(window.__seen) && String.prototype.charCodeAt.toString().includes('__seen')));
      await panel.evaluate(async () => {
        netKeys.clear();
        await chrome.storage.session.remove(NET_KEYS);
      });
      const calls = await panel.evaluate(async () => {
        const out = [];
        for (const c of ['ping', 'changes', 'captured', 'ruleHits']) out.push(await netCall(c, c === 'changes' ? 0 : undefined).then((r) => (r === undefined ? 'undef' : 'ok'), (e) => 'err ' + e.message));
        await pushRules();
        return out;
      });
      check('capture keeps working on a page that poisoned String, Array, Object, JSON and Function builtins', calls.every((c) => c === 'ok'), JSON.stringify(calls));
      const seen = await target.evaluate(() => window.__seen.slice());
      check('no poisoned built-in ever received the capture secret', seen.length === 0, JSON.stringify(seen.slice(0, 10)));
      await panel.evaluate(async () => setPersistent(false));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    console.log('\nCapture from page start (netcap.js + netbridge.js handshake) on a hostile page');
    {
      const hostile = vuln + 'hostile';
      const { panel, target, errors } = await openPanel(env, hostile);
      await panel.evaluate(async () => {
        await activeTab();
        await setPersistent(true);
      });
      await target.reload();
      await target.waitForLoadState('load');
      check('the page registered listeners for every handshake event before anything else', await target.evaluate(() => Array.isArray(window.__stolen)));
      check('no handshake event reached the hostile page during load', (await target.evaluate(() => window.__stolen.filter(([ev]) => ev === 'devforge:net-key').length)) === 0);
      await target.evaluate(() => {
        // later spoofing: ask the capture script to hand over its key
        document.dispatchEvent(new CustomEvent('devforge:bridge-ready'));
        document.dispatchEvent(new CustomEvent('devforge:netcap-ready'));
      });
      await target.waitForTimeout(100);
      check('spoofing the handshake after load yields no key', (await target.evaluate(() => window.__stolen.filter(([ev]) => ev === 'devforge:net-key').length)) === 0);
      await panel.evaluate(async () => {
        netKeys.clear();
        await chrome.storage.session.remove(NET_KEYS);
      });
      check('the panel finds the key through the isolated-world bridge', (await panel.evaluate(() => netCall('ping'))) === 'pong');
      // forged and malformed handshake events after load must not change which key the panel uses
      await target.evaluate(() => {
        for (const detail of ['{"n":"_deadbeef","s":"00"}', 'not json', '{"n":1,"s":2}', '', null])
          document.dispatchEvent(new CustomEvent('devforge:net-key', { detail }));
      });
      await target.waitForTimeout(100);
      await panel.evaluate(async () => {
        netKeys.clear();
        await chrome.storage.session.remove(NET_KEYS);
      });
      check('forged or malformed key events after load change nothing (the panel still finds the real key)', (await panel.evaluate(() => netCall('ping'))) === 'pong');
      const oldName = await panel.evaluate(() => [...netKeys.values()][0].n);
      check('the key names a property that exists only in this document', await target.evaluate((n) => typeof window[n] === 'function', oldName));
      await target.reload();
      await target.waitForLoadState('load');
      check('after navigation the old key is useless: its entry point is gone from the new document', await target.evaluate((n) => typeof window[n] === 'undefined', oldName));
      await panel.evaluate(async () => {
        netKeys.clear();
        await chrome.storage.session.remove(NET_KEYS);
      });
      check('after navigation the panel gets a fresh key through the bridge', (await panel.evaluate(() => netCall('ping'))) === 'pong' && (await panel.evaluate(() => [...netKeys.values()][0].n)) !== oldName);
      await sendSecrets(target);
      await target.waitForTimeout(300);
      const a = await target.evaluate(pageAttack, MARKER);
      check('page-start capture: no global, nothing leaked, entry not replaceable', a.globalType === 'undefined' && !a.leaked && !a.foundMarker && !a.redefined && a.entryCandidates === 1, JSON.stringify(a));
      check('page-start capture: the key holder is not visible in the page world', !a.isolatedWorldKeyVisible);
      const seen = await panel.evaluate(async () => (await netCall('changes', 0)).entries.some((e) => e.method === 'POST'));
      check('page-start capture recorded the request from the first moment', seen);
      await panel.evaluate(async () => setPersistent(false));
      check('turning the setting off unregisters both scripts', await panel.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: [PERSIST_ID, PERSIST_BRIDGE_ID] })).length === 0));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- Owner mode ---------- */
    console.log('\nOwner mode (passphrase-gated technical diagnostics)');
    {
      const OWNER_PASS = 'correct horse battery staple';
      const { panel, target, errors } = await openPanel(env, vuln);
      panel.on('dialog', (d) => d.accept());
      await panel.evaluate(() => show('owner'));
      await panel.waitForSelector('#owner-pass2');
      check('a fresh profile asks to set up Owner mode and explains its limits', /does not prove who you are/.test(await panel.locator('#view').innerText()));
      await panel.fill('#owner-pass', 'short');
      await panel.fill('#owner-pass2', 'short');
      await panel.click('button:has-text("Set up Owner mode")');
      check('a weak passphrase is rejected with a spoken-friendly message and focus returns to the field', /at least 12/.test(await panel.locator('#owner-msg').innerText()) && (await panel.evaluate(() => document.activeElement.id)) === 'owner-pass');
      check('the message is an alert for screen readers', (await panel.locator('#owner-msg').getAttribute('role')) === 'alert');
      await panel.fill('#owner-pass', OWNER_PASS);
      await panel.fill('#owner-pass2', OWNER_PASS + 'x');
      await panel.click('button:has-text("Set up Owner mode")');
      check('mismatching passphrases are rejected', /do not match/.test(await panel.locator('#owner-msg').innerText()));
      await panel.fill('#owner-pass2', OWNER_PASS);
      await panel.click('button:has-text("Set up Owner mode")');
      check('it insists on the no-recovery acknowledgement', /no recovery/.test(await panel.locator('#owner-msg').innerText()));
      await panel.check('#owner-ack');
      await panel.click('button:has-text("Set up Owner mode")');
      await panel.waitForSelector('text=Lock now', { timeout: 20000 });
      check('after setup Owner mode is unlocked', await panel.evaluate(() => DFOwnerSession.isUnlocked()));
      const vaultJson = await panel.evaluate(async () => JSON.stringify((await chrome.storage.local.get('ownerVault')).ownerVault));
      check('the stored record has a salt and verifier but not the passphrase', !vaultJson.includes(OWNER_PASS) && /"salt"/.test(vaultJson) && /"verifier"/.test(vaultJson) && /"iterations":600000/.test(vaultJson));

      // a technical scan, sealed
      await panel.evaluate(() => {
        SEC.view = 'setup';
        SEC.report = null;
        show('security');
      });
      await panel.waitForSelector('#sec-owner-tech');
      check('Owner options appear in the Security setup while unlocked', await panel.locator('#sec-owner-tech').isChecked());
      await panel.check('#sec-lv-standard');
      await panel.click('button:has-text("Start scan")');
      await panel.waitForSelector('.sec-head', { timeout: 120000 });
      const rep = await panel.evaluate(() => ({ id: SEC.report.id, sealed: SEC.technicalSealed, json: JSON.stringify(SEC.report), md: DFSecReport.toMarkdown(SEC.report) }));
      check('the scan sealed its technical evidence under the report id', rep.id && rep.sealed === rep.id);
      check('the ordinary report and its Markdown export contain none of the technical data', !/"fingerprint"|userAgent|"environment"|"technical"/.test(rep.json) && !/fingerprint|userAgent/.test(rep.md));

      // sealed at rest
      const atRest = await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
      check('at rest the sealed record is ciphertext: no host, header, path or probe name is readable', !/127\.0\.0\.1|nginx|\.env|git-head|Training shop|exposed-/.test(atRest.replace(/"ownerVault":\{[^}]*\}/, '')), atRest.slice(0, 200));
      check('only a count of sealed records is visible without the passphrase', (await panel.evaluate(() => DFOwnerSession.sealedCount())) === 1);

      // view and redacted export
      await panel.evaluate(() => show('owner'));
      await panel.waitForSelector('text=Sealed technical evidence');
      await panel.click('button:has-text("Open")');
      await panel.waitForSelector('text=Check timings');
      const detailText = await panel.locator('#view').innerText();
      check('the owner view shows scan configuration, timings, headers, probes and the request log', ['Scan configuration', 'Check timings', 'Response headers of the page', 'Path probes', 'Requests this scan made', 'Limits in force'].every((t) => detailText.toLowerCase().includes(t.toLowerCase())), 'missing: ' + ['Scan configuration', 'Check timings', 'Response headers of the page', 'Path probes', 'Requests this scan made', 'Limits in force'].filter((t) => !detailText.toLowerCase().includes(t.toLowerCase())).join(', ') + ' | ' + detailText.slice(0, 600));
      check('the owner view shows header values the ordinary report does not (server banner)', /nginx\/1\.18\.0/.test(detailText));
      check('the extension-state view lists storage key names but not the capture key values', !(await panel.evaluate(async () => { const k = [...netKeys.values()][0]; return k ? document.querySelector('#view').innerText.includes(k.s) : false; })));
      await panel.evaluate(() => {
        window.__downloads = [];
        window.download = (n, d) => window.__downloads.push(d);
      });
      await panel.click('button:has-text("Download redacted .json")');
      const strict = await panel.evaluate(() => window.__downloads[0]);
      check('the default export hides host names, paths, header values, cookie names and the request log', !/127\.0\.0\.1|nginx|\.env|PHPSESSID|\/app\.js/.test(strict) && /\[host\]/.test(strict) && /"omitted"/.test(strict), 'leaks: ' + (strict.match(/127\.0\.0\.1|nginx|\.env|PHPSESSID|\/app\.js/g) || []).join(',') + ' host:' + /\[host\]/.test(strict) + ' omitted:' + /"omitted"/.test(strict));
      for (const label of ['Include host names', 'Include request and file paths', 'Include header values', 'Include the full request log', 'Include cookie names and flags']) await panel.locator(`label:has-text("${label}") input`).check();
      await panel.click('button:has-text("Download redacted .json")');
      const open = await panel.evaluate(() => window.__downloads[1]);
      check('each redaction option adds only its own detail back', /127\.0\.0\.1/.test(open) && /nginx\/1\.18\.0/.test(open) && /\/\.env/.test(open) && /PHPSESSID/.test(open));
      check('credential-bearing values are never exported, even with every option on', !/abc123|set-cookie":\s*"[^[]/.test(open));

      // isolation probe from the owner tab
      await panel.evaluate(() => startCapture());
      await panel.click('button:has-text("Run isolation probe")');
      await panel.waitForSelector('text=cannot read DevForge data here', { timeout: 15000 });
      check('the owner isolation probe reports a clean page world', true);

      // lock: nothing privileged is reachable any more
      await panel.click('button:has-text("Lock now")');
      await panel.waitForSelector('#owner-pass');
      const locked = await panel.evaluate(async (id) => {
        const attempt = async (fn) => {
          try {
            await fn();
            return 'allowed';
          } catch (e) {
            return e.name;
          }
        };
        return {
          open: await attempt(() => DFOwnerSession.openTechnical(id)),
          list: await attempt(() => DFOwnerSession.listTechnical()),
          log: await attempt(() => DFOwnerSession.log()),
          seal: await attempt(() => DFOwnerSession.sealTechnical('x', {}, { a: 1 })),
          unlocked: DFOwnerSession.isUnlocked(),
        };
      }, rep.id);
      check('locked: reading, listing, logging and sealing all fail with OwnerLockedError', locked.open === 'OwnerLockedError' && locked.list === 'OwnerLockedError' && locked.log === 'OwnerLockedError' && locked.seal === 'OwnerLockedError' && !locked.unlocked, JSON.stringify(locked));
      check('the locked screen shows no site names or technical data', !/127\.0\.0\.1|nginx|Check timings/.test(await panel.locator('#view').innerText()));

      // a second panel instance does not share the unlocked state
      const panel2 = await env.ctx.newPage();
      await panel2.goto(`chrome-extension://${env.id}/sidepanel.html`);
      await panel2.evaluate(() => show('owner'));
      await panel2.waitForSelector('#owner-pass');
      check('another panel instance starts locked', !(await panel2.evaluate(() => DFOwnerSession.isUnlocked())));
      await panel2.close();

      // wrong passphrases and the lockout
      for (let i = 0; i < 5; i++) {
        await panel.fill('#owner-pass', 'wrong passphrase ' + i);
        await panel.click('button:has-text("Unlock")');
        await panel.waitForFunction(() => /not correct|Too many/.test(document.querySelector('#owner-msg').innerText), null, { timeout: 15000 });
      }
      check('repeated wrong passphrases are delayed and say so', /delayed for \d+ seconds|Too many wrong attempts/.test(await panel.locator('#owner-msg').innerText()));
      await panel.fill('#owner-pass', OWNER_PASS);
      await panel.click('button:has-text("Unlock")');
      await panel.waitForFunction(() => /Too many/.test(document.querySelector('#owner-msg').innerText), null, { timeout: 15000 });
      check('during the delay even the right passphrase is refused', !(await panel.evaluate(() => DFOwnerSession.isUnlocked())));
      // (the counter is local state: whoever can edit extension storage can reset it; docs/OWNER-MODE.md says so)
      await panel.evaluate(async () => {
        const st = (await chrome.storage.local.get('ownerVault')).ownerVault;
        st.attempts = DFOwner.freshAttempts();
        await chrome.storage.local.set({ ownerVault: st });
      });
      await panel.fill('#owner-pass', OWNER_PASS);
      await panel.click('button:has-text("Unlock")');
      await panel.waitForSelector('text=Lock now', { timeout: 20000 });
      check('the right passphrase unlocks and the sealed record survived the lock', (await panel.evaluate(async () => (await DFOwnerSession.listTechnical()).length)) === 1);

      // owner mode changes nothing about scope or authorisation
      const b = await panel.evaluate(() => call('secBegin', { maxRequests: 99999, delayMs: 0 }));
      check('unlocked: the request ceiling and minimum pause are unchanged', b.max === 200 && b.delay >= 100, JSON.stringify(b));
      const refused = await panel.evaluate((id) => call('secRequest', { id, method: 'GET', url: 'http://evil.example/' }), b.id);
      check('unlocked: off-origin requests are still refused by the gate', !!refused.blocked, JSON.stringify(refused));
      check('unlocked: no owner global or key is visible to the page', await target.evaluate(() => typeof window.DFOwnerSession === 'undefined' && typeof window.DFOwner === 'undefined' && !Object.getOwnPropertyNames(window).some((k) => /owner/i.test(k))));

      // forged panel messages are ignored
      await panel.evaluate(() => {
        DF.state.h = null;
      });
      const before = await panel.evaluate(() => DF.state.tab);
      await env.sw.evaluate(() => chrome.runtime.sendMessage({ type: 'df:selected', handle: 'h1' }).catch(() => {}));
      await env.sw.evaluate(() => chrome.runtime.sendMessage({ type: 'df:command', command: 'rm -rf' }).catch(() => {}));
      await env.sw.evaluate(() => chrome.runtime.sendMessage({ type: 'df:selected', handle: '<img onerror=alert(1)>' }).catch(() => {}));
      await env.sw.evaluate(() => chrome.runtime.sendMessage('just a string').catch(() => {}));
      await panel.waitForTimeout(300);
      check('forged or malformed messages change nothing', (await panel.evaluate(() => DF.state.tab)) === before && (await panel.evaluate(() => DF.state.h)) === null);

      // reset destroys, never reveals
      await panel.evaluate(() => {
        show('owner');
      });
      await panel.waitForSelector('text=Lock now');
      await panel.click('button:has-text("Lock now")');
      await panel.waitForSelector('summary:has-text("Forgot the passphrase?")');
      await panel.click('summary:has-text("Forgot the passphrase?")');
      await panel.click('button:has-text("Reset Owner mode")');
      await panel.waitForSelector('#owner-pass2');
      const left = await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(['ownerVault', 'ownerSealed'])));
      check('reset removes the passphrase record and every sealed record', left === '{}', left);
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    console.log('\nWorkspace encryption at rest');
    {
      const PASS = 'workspace test passphrase';
      const { panel, errors } = await openPanel(env, vuln);
      await panel.evaluate(async (p) => {
        await DFOwnerSession.reset();
        await DFOwnerSession.setup(p);
        window.__raw = async () => JSON.stringify(await DFStore.rawItems());
      }, PASS);
      await panel.evaluate(async () => {
        await saveToWorkspace('note', 'Quarterly pentest notes', { text: 'internal-hostname.corp.example', n: 1 });
        await saveToWorkspace('note', 'Second item', { text: 'another-private-value' });
      });
      let raw = await panel.evaluate(() => window.__raw());
      check('before enabling, items are stored as plain data (the starting point)', /Quarterly pentest notes/.test(raw) && !/"sealed"/.test(raw));
      await panel.evaluate(() => show('owner'));
      await panel.waitForSelector('#owner-ws-enable');
      panel.once('dialog', (d) => d.accept());
      await panel.click('#owner-ws-enable');
      await panel.waitForSelector('#owner-ws-disable', { timeout: 20000 });
      raw = await panel.evaluate(() => window.__raw());
      check('after enabling, existing items are ciphertext: no title, hostname or text is readable in IndexedDB', /"sealed"/.test(raw) && !/Quarterly|internal-hostname|another-private-value|Second item/.test(raw), raw.slice(0, 200));
      check('the listing fields stay readable so lists work', /"kind":"note"/.test(raw) && /"project":/.test(raw));
      const open1 = await panel.evaluate(async () => (await DFStore.allItems()).map((i) => i.title).sort().join('|'));
      check('while unlocked the items open normally', open1 === 'Quarterly pentest notes|Second item', open1);
      await panel.evaluate(async () => saveToWorkspace('note', 'Third item', { text: 'new-private-value' }));
      raw = await panel.evaluate(() => window.__raw());
      check('a new item saved while encryption is on is also stored encrypted', !/Third item|new-private-value/.test(raw));

      await panel.evaluate(() => DFOwnerSession.lock());
      const locked = await panel.evaluate(async () => (await DFStore.allItems()).map((i) => [i.title, !!i.locked, JSON.stringify(i).includes('private')]));
      check('locked: every item lists as Sealed and carries no content', locked.length === 3 && locked.every(([t, l, leak]) => t === 'Sealed item' && l && !leak), JSON.stringify(locked));
      const before = (await panel.evaluate(() => window.__raw())).length;
      const refused = await panel.evaluate(() => saveToWorkspace('note', 'Should not be saved', { text: 'plain-leak' }).then(() => 'saved', (e) => e.message));
      const after = await panel.evaluate(() => window.__raw());
      check('locked: saving is refused with an explanation and no plaintext is written', /Owner mode is locked, so nothing was saved/.test(refused) && after.length === before && !/Should not be saved|plain-leak/.test(after), refused);
      await panel.evaluate(() => show('work'));
      await panel.waitForSelector('text=Sealed item');
      check('the Workspace tab shows sealed rows while locked', (await panel.locator('#view').innerText()).includes('Sealed item'));

      await panel.evaluate((p) => DFOwnerSession.unlock(p), PASS);
      // tamper: change a plaintext label in the database
      const tampered = await panel.evaluate(async () => {
        const recs = await DFStore.rawItems();
        const r = recs[0];
        await DFStore.putRaw({ ...r, kind: 'screenshot' });
        const view = (await DFStore.allItems()).find((i) => i.id === r.id);
        await DFStore.putRaw(r);
        const restored = (await DFStore.allItems()).find((i) => i.id === r.id);
        return { damaged: !!view.damaged, restoredOk: !restored.locked && !!restored.title };
      });
      check('editing a plaintext label in the database makes that record fail to open (and restoring it works)', tampered.damaged && tampered.restoredOk, JSON.stringify(tampered));
      const wrong = await panel.evaluate(async () => {
        const k = await (async () => (await DFOwner.createVault('some other long passphrase')).key)();
        const rec = (await DFStore.rawItems())[0];
        return DFWsSeal.revealItem(k, rec).then(() => 'opened', (e) => e.name);
      });
      check('a different key cannot open the records', wrong === 'OwnerAuthError', wrong);

      // turning it off restores plain data
      await panel.evaluate(() => show('owner'));
      await panel.waitForSelector('#owner-ws-disable');
      await panel.click('#owner-ws-disable');
      await panel.waitForSelector('#owner-ws-enable', { timeout: 20000 });
      raw = await panel.evaluate(() => window.__raw());
      check('decrypting restores every item as readable plain data, and encryption is off', /Quarterly pentest notes/.test(raw) && /Third item/.test(raw) && !/"sealed"/.test(raw) && !(await panel.evaluate(() => DFOwnerSession.workspaceActive())));

      // reset with sealed items keeps the ciphertext and does not delete anything
      panel.once('dialog', (d) => d.accept());
      await panel.click('#owner-ws-enable');
      await panel.waitForSelector('#owner-ws-disable', { timeout: 20000 });
      const n = await panel.evaluate(async () => (await DFStore.rawItems()).length);
      await panel.evaluate(() => DFOwnerSession.reset());
      const afterReset = await panel.evaluate(async () => ({ n: (await DFStore.rawItems()).length, sealed: (await DFStore.rawItems()).filter((r) => r.sealed).length, active: DFOwnerSession.workspaceActive(), titles: (await DFStore.allItems()).map((i) => i.title).join('|') }));
      check('after Owner reset the encrypted items are kept (not deleted) but cannot be opened, and encryption is off', afterReset.n === n && afterReset.sealed === n && !afterReset.active && /^Sealed item(\|Sealed item)*$/.test(afterReset.titles), JSON.stringify(afterReset));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.evaluate(async () => {
        for (const r of await DFStore.rawItems()) await DFStore.deleteItem(r.id);
      });
      await panel.close();
    }

    console.log('\nOwner mode does not bypass target authorisation');
    {
      const { panel, errors } = await openPanel(env, publicUrl);
      await panel.evaluate(async () => {
        await DFOwnerSession.setup('another long passphrase here');
        show('security');
      });
      await panel.waitForSelector('#sec-ack');
      const start = panel.locator('button:has-text("Start scan")');
      check('unlocked on a public site: Start still needs the ownership confirmation', await start.isDisabled());
      await panel.check('#sec-lv-advanced');
      await panel.check('#sec-ack');
      check('unlocked: Advanced still needs its own confirmation', await start.isDisabled());
      // idle lock: the 10-minute timer is shortened for the test by wrapping setTimeout
      await panel.evaluate(() => {
        const real = window.setTimeout;
        window.setTimeout = (f, ms, ...a) => real(f, ms === 600000 ? 300 : ms, ...a);
        DFOwnerSession.touch();
        window.setTimeout = real;
      });
      check('unlocked now', await panel.evaluate(() => DFOwnerSession.isUnlocked()));
      await panel.waitForTimeout(700);
      check('Owner mode locks itself after the idle period', !(await panel.evaluate(() => DFOwnerSession.isUnlocked())));
      // authorised sites: an exact-origin, owner-sealed, revocable stand-in for the per-site checkbox
      await panel.evaluate(async (p) => {
        await DFOwnerSession.unlock(p);
      }, 'another long passphrase here');
      await panel.uncheck('#sec-ack').catch(() => {});
      await panel.evaluate(async () => {
        await chrome.storage.session.remove(SEC_ACK_KEY);
      });
      const pubOrigin = await panel.evaluate(() => new URL(DF.state.url).origin);
      const notYet = await panel.evaluate(async (o) => !(await DFOwnerSession.originAuthorized(o)), pubOrigin);
      check('an origin that was never authorised gets no exemption', notYet);
      const badInputs = await panel.evaluate(async () => {
        const res = [];
        for (const [v, ok] of [['javascript:alert(1)', true], ['not a url', true], ['ftp://x.example/', true], ['https://x.example/', true]])
          res.push(await DFOwnerSession.authorizeOrigin(v, ok).then(() => 'ok', (e) => e.message.slice(0, 20)));
        res.push(await DFOwnerSession.authorizeOrigin('https://y.example/', false).then(() => 'ok', (e) => e.message.slice(0, 20)));
        return res;
      });
      check('authorising rejects non-web addresses and requires the attestation', badInputs[0] !== 'ok' && badInputs[1] !== 'ok' && badInputs[2] !== 'ok' && badInputs[3] === 'ok' && badInputs[4] !== 'ok', JSON.stringify(badInputs));
      await panel.evaluate(async (o) => {
        await DFOwnerSession.revokeOrigin('https://x.example');
        await DFOwnerSession.authorizeOrigin(o, true);
      }, pubOrigin);
      const sealedAtRest = await panel.evaluate(async () => JSON.stringify((await chrome.storage.local.get('ownerOrigins')).ownerOrigins));
      check('the authorised list is ciphertext at rest', !/example|http/.test(sealedAtRest) && /"ct"/.test(sealedAtRest), sealedAtRest.slice(0, 120));
      await panel.evaluate(() => {
        SEC.view = 'setup';
        SEC.level = 'standard';
        show('security');
      });
      await panel.waitForSelector('#sec-owner-auth', { timeout: 10000 });
      check('an authorised site pre-fills the ordinary confirmation and says why', await panel.locator('#sec-ack').isChecked() && !(await start.isDisabled()));
      await panel.check('#sec-lv-advanced');
      check('...but Advanced still needs its own confirmation', await start.isDisabled());
      await panel.check('#sec-ack-adv');
      check('...which enables it once given', !(await start.isDisabled()));
      await panel.uncheck('#sec-ack-adv');
      const chip = await panel.evaluate(() => ({ hidden: document.getElementById('owner-chip').hidden, label: document.getElementById('owner-chip').getAttribute('aria-label') }));
      check('while unlocked a visible Owner indicator is in the header, named for screen readers', chip.hidden === false && /Owner mode is unlocked/.test(chip.label), JSON.stringify(chip));
      await panel.click('#owner-chip');
      check('activating the indicator locks Owner mode and hides it', !(await panel.evaluate(() => DFOwnerSession.isUnlocked())) && (await panel.evaluate(() => document.getElementById('owner-chip').hidden)));
      await panel.waitForTimeout(300);
      const afterLock = await panel.evaluate(async () => ({ ack: (await chrome.storage.session.get(SEC_ACK_KEY))[SEC_ACK_KEY] || {}, authorised: await DFOwnerSession.originAuthorized(new URL(DF.state.url).origin) }));
      check('locking removes the approvals Owner mode granted and the list stops applying', Object.keys(afterLock.ack).length === 0 && afterLock.authorised === null, JSON.stringify(afterLock));
      await panel.evaluate(() => {
        SEC.view = 'setup';
        show('security');
      });
      await panel.waitForSelector('#sec-ack');
      check('after locking, the public site needs the confirmation again', (await start.isDisabled()) && !(await panel.locator('#sec-ack').isChecked()));
      await panel.evaluate(async () => {
        await DFOwnerSession.reset();
      });
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- request gate: scope, methods, budget, cancel ---------- */
    console.log('\nRequest gate (agent/security.js)');
    {
      const { panel, errors } = await openPanel(env, vuln);
      await panel.evaluate(() => call('ping'));
      const before = fx.vuln.log.length;
      const b = await panel.evaluate(() => call('secBegin', { maxRequests: 99999, delayMs: 0 }));
      check('budget is clamped to the hard ceiling and a minimum pause is imposed', b.max === 200 && b.delay >= 100, JSON.stringify(b));
      const ask = (spec) => panel.evaluate((s) => call('secRequest', s), { id: b.id, ...spec });
      let r = await ask({ method: 'POST', path: '/x' });
      check('POST is refused', r.blocked && /only GET and HEAD/.test(r.blocked), JSON.stringify(r));
      r = await ask({ method: 'GET', url: 'http://evil.example/' });
      check('another origin is refused', r.blocked && /outside the scanned origin/.test(r.blocked), JSON.stringify(r));
      r = await ask({ method: 'GET', url: `http://user:pw@127.0.0.1:${fx.vuln.port}/` });
      check('addresses with credentials are refused', !!r.blocked, JSON.stringify(r));
      r = await ask({ method: 'GET', path: '/a/../b' });
      check('dot segments are refused', !!r.blocked, JSON.stringify(r));
      r = await ask({ method: 'GET', path: '/a?x=1' });
      check('query strings are refused for probe paths', !!r.blocked, JSON.stringify(r));
      r = await ask({ method: 'GET', url: `http://127.0.0.1:${fx.sink.port}/` });
      check('a different port (another origin) is refused', !!r.blocked, JSON.stringify(r));
      check('none of the refused requests reached the network', fx.vuln.log.length === before && fx.sink.log.length === 0, 'vuln +' + (fx.vuln.log.length - before) + ', sink ' + fx.sink.log.length);

      // URL-resolution tricks that must not escape the origin, with and without allowQuery.
      for (const [label, spec] of [
        ['a protocol-relative path (//host)', { path: '//evil.example/x', allowQuery: true }],
        ['a backslash path (/\\host)', { path: '/\\evil.example/x', allowQuery: true }],
        ['a data: address', { url: 'data:text/plain,hi' }],
        ['a javascript: address', { url: 'javascript:void 0' }],
        ['an ftp: address', { url: 'ftp://127.0.0.1/' }],
      ]) {
        r = await ask({ method: 'GET', ...spec });
        check(label + ' is refused', !!r.blocked, JSON.stringify(r));
      }
      check('none of those reached any server either', fx.vuln.log.length === before && fx.sink.log.length === 0);

      const small = await panel.evaluate(() => call('secBegin', { maxRequests: 3, delayMs: 0 }));
      const ask3 = (spec) => panel.evaluate((s) => call('secRequest', s), { id: small.id, ...spec });
      for (let i = 0; i < 3; i++) await ask3({ method: 'GET', path: '/robots.txt', maxBytes: 100 });
      r = await ask3({ method: 'GET', path: '/robots.txt', maxBytes: 100 });
      check('the 4th request of a 3-request budget is refused', r.blocked === 'request limit reached', JSON.stringify(r));

      const c = await panel.evaluate(() => call('secBegin', { maxRequests: 10, delayMs: 0 }));
      await panel.evaluate(() => call('secCancel'));
      r = await panel.evaluate((id) => call('secRequest', { id, method: 'GET', path: '/robots.txt' }), c.id);
      check('a cancelled scan refuses further requests', r.blocked === 'cancelled', JSON.stringify(r));
      r = await panel.evaluate(() => call('secRequest', { id: 'stale', method: 'GET', path: '/robots.txt' }));
      check('a request for an unknown scan id is refused', !!r.blocked, JSON.stringify(r));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- passive scan ---------- */
    console.log('\nPassive scan of the vulnerable training site');
    {
      const { panel, errors } = await openPanel(env, vuln + '?q=hello%22world');
      fx.vuln.log.length = 0;
      const report = await runScan(panel, 'passive');
      const ids = report.findings.map((f) => f.id);
      for (const id of ['csp-missing', 'clickjacking', 'nosniff-missing', 'password-form-get', 'dom-sinks', 'csrf-token-missing', 'sri-missing', 'cookie-script-readable', 'open-redirect-indicator', 'idor-surface', 'sensitive-url-params', 'html-comments', 'param-reflection-q', 'generator-version', 'security-txt-missing', 'version-disclosure-server'])
        check('finds ' + id, ids.includes(id), 'got: ' + ids.join(', '));
      check('no active probes at the passive level', !ids.some((i) => i.startsWith('exposed-')) && !ids.some((i) => i.startsWith('secret-')));
      check('at most 3 requests were made', report.requestsMade <= 3 && fx.vuln.log.length <= 3, 'report ' + report.requestsMade + ', server ' + fx.vuln.log.length);
      check('requests carried no cookies or credentials', fx.vuln.log.every((r) => !r.cookie && !r.auth));
      check('only GET and HEAD were sent', fx.vuln.log.every((r) => r.method === 'GET' || r.method === 'HEAD'));
      check('localhost over HTTP is informational, not high severity', report.findings.find((f) => f.id === 'no-https').severity === 'info');
      check('coverage lists skipped deeper checks with a reason', report.coverage.checks.find((c) => c.id === 'probes').state === 'skipped');
      check('an attack path is inferred and labelled potential', report.attackPaths.length > 0 && report.attackPaths.every((p) => p.status === 'potential'), JSON.stringify(report.attackPaths.map((p) => p.id)));
      check('every finding has status, impact and verify guidance', report.findings.every((f) => f.status && f.impact && f.verify && f.fix));
      const json = JSON.stringify(report);
      check('cookie values are not in the report', !json.includes('abc123') && !json.includes('theme=dark'));
      check('URL parameter values are not in the report', !json.includes('hello') && !json.includes('zzz'));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      if (shotsDir) await panel.screenshot({ path: path.join(shotsDir, 'security-overview.png'), fullPage: true });
      await panel.close();
    }

    /* ---------- standard scan ---------- */
    console.log('\nStandard scan of the vulnerable training site');
    let standardReport;
    {
      const { panel, errors } = await openPanel(env, vuln);
      fx.vuln.log.length = 0;
      standardReport = await runScan(panel, 'standard');
      const ids = standardReport.findings.map((f) => f.id);
      for (const id of ['exposed-git-head', 'exposed-env-file', 'exposed-dir-uploads', 'exposed-phpinfo', 'sourcemap-exposed', 'secret-aws-access-key', 'secret-stripe-secret', 'robots-interesting', 'exposed-admin-login'])
        check('finds ' + id, ids.includes(id), 'got: ' + ids.join(', '));
      check('flags the old jQuery from its file name', ids.some((i) => i.startsWith('vulnerable-library-jquery-1.12.4')));
      check('links the exposed source to the secret in an attack path', standardReport.attackPaths.some((p) => p.id === 'source-to-credentials'), JSON.stringify(standardReport.attackPaths.map((p) => p.id)));
      const log = fx.vuln.log;
      check('request count stays within the 60-request budget', log.length <= 60 && standardReport.requestsMade <= 60, 'server ' + log.length + ', report ' + standardReport.requestsMade);
      // Scripts the page already loaded are re-read from the browser cache (cache: force-cache), which
      // costs the server nothing, so it may see slightly fewer requests than the report counts.
      check('the server never saw more requests than the report claims', log.length <= standardReport.requestsMade && standardReport.requestsMade - log.length <= 12, 'server ' + log.length + ', report ' + standardReport.requestsMade);
      check('only GET and HEAD, no cookies, no credentials', log.every((r) => (r.method === 'GET' || r.method === 'HEAD') && !r.cookie && !r.auth));
      const gaps = log.slice(1).map((r, i) => r.t - log[i].t);
      check('requests are spaced at least ~200 ms apart', Math.min(...gaps) >= 200, 'smallest gap ' + Math.min(...gaps) + ' ms');
      check('a missing-path baseline request was made', log.some((r) => r.url.startsWith('/__devforge_probe_')));
      check('every request is listed in the report with its purpose', standardReport.requestLog.length === standardReport.requestsMade && standardReport.requestLog.every((r) => r.method && r.path && r.purpose));
      const json = JSON.stringify(standardReport);
      for (const [label, secret] of [['AWS key', fx.FAKE.aws], ['Stripe-style key', fx.FAKE.stripe], ['.env password', fx.FAKE.dbPassword], ['.env token value', 'abcdef0123456789']])
        check('the ' + label + ' value is not in the report', !json.includes(secret));
      const env1 = standardReport.findings.find((f) => f.id === 'exposed-env-file');
      check('.env evidence names variables but shows no values', /DB_PASSWORD/.test(env1.evidence) && !/fixture-not-a-real-secret/.test(env1.evidence), env1.evidence);
      check('exposures are Confirmed (observed) while secrets stay Potential', env1.status === 'confirmed' && standardReport.findings.find((f) => f.id === 'secret-aws-access-key').status === 'potential');
      const md = await panel.evaluate(() => DFSecReport.toMarkdown(SEC.report));
      check('Markdown export is complete and free of secret values', md.includes('## Scan coverage') && md.includes('## Requests made') && !md.includes(fx.FAKE.aws) && !md.includes(fx.FAKE.dbPassword));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      if (shotsDir) {
        await panel.evaluate(() => SEC.go('findings'));
        await panel.screenshot({ path: path.join(shotsDir, 'security-findings.png'), fullPage: true });
      }
      await panel.close();
    }

    /* ---------- false positives: a SPA that answers every path with 200 ---------- */
    console.log('\nStandard scan of a clean single-page app (catch-all 200 responses)');
    {
      const { panel, errors } = await openPanel(env, spa);
      fx.spa.log.length = 0;
      const report = await runScan(panel, 'standard');
      const exposed = report.findings.filter((f) => f.id.startsWith('exposed-') || f.id.startsWith('secret-') || f.id === 'sourcemap-exposed');
      check('no exposed-file or secret findings despite every path returning 200', exposed.length === 0, exposed.map((f) => f.id).join(', '));
      check('a clean site produces no medium or high findings', report.counts.high === 0 && report.counts.medium === 0, JSON.stringify(report.counts) + ' ' + report.findings.filter((f) => f.severity !== 'info' && f.severity !== 'low').map((f) => f.id + ': ' + f.evidence).join(' | '));
      check('the catch-all behaviour is explained in coverage', /unknown paths with a page/.test(report.coverage.checks.find((c) => c.id === 'baseline').reason));
      check('security.txt is recognised', !report.findings.some((f) => f.id.startsWith('security-txt')));
      check('the report does not claim the site is secure', /does not prove|not prove/.test(await panel.evaluate(() => DFSecReport.toMarkdown(SEC.report))) || report.findings.length > 0);
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- redirects are not followed off the origin ---------- */
    console.log('\nRedirect handling');
    {
      const { panel } = await openPanel(env, vuln);
      const b = await panel.evaluate(() => call('secBegin', { maxRequests: 5, delayMs: 0 }));
      const r = await panel.evaluate((id) => call('secRequest', { id, method: 'GET', path: '/redir', maxBytes: 100 }), b.id);
      check('a redirect is reported, not followed', r.ok && r.redirected && r.status === 0, JSON.stringify(r));
      check('the redirect target (a private host) was never contacted', fx.sink.log.length === 0, JSON.stringify(fx.sink.log));
      await panel.close();
    }

    /* ---------- extension-side downloads: redirects fail safe ---------- */
    console.log('\nDownloads of page-derived URLs (lib/net.js)');
    {
      const { panel, errors } = await openPanel(env, publicUrl);
      await panel.evaluate(() => activeTab());
      const target = `http://example.com:${fx.vuln.port}/redir`; // a "public" name that redirects to a private address
      const unknown = await panel.evaluate((u) => { const keep = DF.state.url; DF.state.url = ''; return fetchBytes(u).then(() => 'fetched', (e) => e.message).finally(() => { DF.state.url = keep; }); }, `http://192.168.1.1:${fx.vuln.port}/x`);
      check('with the page address unknown nothing is fetched (fails closed)', /address of the page is unknown/.test(unknown), unknown);
      fx.sink.log.length = 0;
      const first = await panel.evaluate((u) => fetchBytes(u).then(() => 'fetched', (e) => e.message), target);
      check('default: the redirect is reported and not followed', /redirect not followed/.test(first), first);
      check('default: the private redirect target was never contacted', fx.sink.log.length === 0, JSON.stringify(fx.sink.log));
      const direct = await panel.evaluate((p) => fetchBytes('http://192.168.1.1:' + p + '/x').then(() => 'fetched', (e) => e.message), fx.vuln.port);
      check('a private address given directly is refused before any request', /private or loopback/.test(direct), direct);
      fx.sink.log.length = 0;
      await panel.evaluate(() => {
        DF.state.settings.followRedirects = true;
      });
      const second = await panel.evaluate((u) => fetchBytes(u).then((r) => 'body:' + new TextDecoder().decode(r.bytes), (e) => e.message), target);
      check('opt-in: the body of a redirect into the private network is never returned', !/SECRET-FROM-PRIVATE-HOST/.test(second) && !/^body:/.test(second), second);
      check('opt-in: the private redirect target is never contacted (blocked at the network layer, before the request)', fx.sink.log.length === 0, JSON.stringify(fx.sink.log));
      // Prove the network layer does the blocking, not the JavaScript checks: raw fetch with redirects
      // followed, rules installed, then the same fetch with the rules removed as the control.
      fx.sink.log.length = 0;
      const withRules = await panel.evaluate(async (u) => {
        await DFNetGuard.install(chrome, chrome.runtime.id, DF.state.url);
        return fetch(u, { redirect: 'follow', credentials: 'omit' }).then((r) => 'status ' + r.status, (e) => 'network error: ' + e.message);
      }, target);
      check('raw fetch that follows the redirect is stopped by the browser itself (network error, sink saw nothing)', /network error/.test(withRules) && fx.sink.log.length === 0, withRules + ' ' + JSON.stringify(fx.sink.log));
      const control = await panel.evaluate(async (u) => {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...DFNetGuard.BLOCK_RULE_IDS, DFNetGuard.ALLOW_RULE_ID] });
        const r = await fetch(u, { redirect: 'follow', credentials: 'omit' }).then((r) => 'status ' + r.status, (e) => 'network error: ' + e.message);
        await DFNetGuard.install(chrome, chrome.runtime.id, DF.state.url);
        return r;
      }, target);
      check('control: with the rules removed the same fetch does reach the private host (so the test can fail)', fx.sink.log.length === 1 && /status/.test(control), control + ' ' + JSON.stringify(fx.sink.log));
      fx.sink.log.length = 0;
      const sameHostRedirect = await panel.evaluate(async (u) => {
        await DFNetGuard.install(chrome, chrome.runtime.id, 'http://127.0.0.1:' + new URL(u).port + '/');
        return fetch('http://127.0.0.1:' + new URL(u).port + '/slow', { credentials: 'omit' }).then((r) => 'status ' + r.status, (e) => 'network error: ' + e.message);
      }, target);
      check('the page-host exception works: a page on 127.0.0.1 can still fetch from 127.0.0.1', /status 200/.test(sameHostRedirect), sameHostRedirect);
      await panel.evaluate(() => DFNetGuard.install(chrome, chrome.runtime.id, DF.state.url));
      // the page's own host stays reachable: a redirect that stays on the page's host is followed
      await panel.evaluate(() => {
        DF.state.settings.followRedirects = true;
      });
      const stay = await panel.evaluate((u) => fetchBytes(u).then((r) => 'body:' + new TextDecoder().decode(r.bytes).slice(0, 20), (e) => e.message), `http://example.com:${fx.vuln.port}/slow`);
      check('opt-in: a public destination that does not redirect still downloads', /^body:slow ok/.test(stay), stay);
      const blockedDirect = await panel.evaluate((p) => fetchBytes('http://[::1]:' + p + '/x').then(() => 'fetched', (e) => e.message), fx.sink.port);
      check('opt-in: an IPv6 loopback address is refused', /private or loopback/.test(blockedDirect), blockedDirect);
      check('the guard rule is installed as a session rule scoped to this extension', await panel.evaluate(async () => { const r = await chrome.declarativeNetRequest.getSessionRules(); return DFNetGuard.BLOCK_RULE_IDS.every((id) => r.some((x) => x.id === id && x.condition.initiatorDomains.includes(chrome.runtime.id))); }));
      // stale-cache scenario: a cacheable asset changes on the server; the next download must see it
      await panel.evaluate(() => {
        DF.state.settings.followRedirects = false;
      });
      const base = `http://example.com:${fx.vuln.port}`;
      const get = (u) => panel.evaluate((x) => fetchBytes(x).then((r) => new TextDecoder().decode(r.bytes), (e) => 'ERR ' + e.message), u);
      await panel.evaluate((u) => fetch(u), base + '/versioned-set?v=one');
      const v1 = await get(base + '/versioned');
      await panel.evaluate((u) => fetch(u), base + '/versioned-set?v=two');
      const v2 = await get(base + '/versioned');
      check('downloads revalidate: a changed asset is not served from a stale cache', v1 === 'body-one' && v2 === 'body-two', v1 + ' / ' + v2);
      const missing = await get(base + '/nope-' + Date.now());
      check('a missing asset is reported as an error, not served from cache', /HTTP 404/.test(missing), missing);
      await panel.evaluate(() => {
        DF.state.settings.followRedirects = false;
      });
      await panel.evaluate(() => show('settings'));
      check('Settings explains the option and it is off by default', (await panel.locator('#set-redirects').isChecked()) === false && /never sent/.test(await panel.locator('#view').innerText()));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- authorisation for public sites ---------- */
    console.log('\nAuthorisation flow (public-looking host)');
    {
      const { panel, errors } = await openPanel(env, publicUrl);
      await panel.evaluate(() => show('security'));
      await panel.waitForSelector('#sec-ack');
      const start = panel.locator('button:has-text("Start scan")');
      check('Start is disabled until ownership is confirmed', await start.isDisabled());
      await panel.check('#sec-lv-advanced');
      await panel.check('#sec-ack');
      check('Advanced stays disabled with only the ownership confirmation', await start.isDisabled());
      await panel.check('#sec-ack-adv');
      check('Advanced is enabled after the second confirmation', !(await start.isDisabled()));
      await panel.check('#sec-lv-standard');
      check('Standard needs only the ownership confirmation', !(await start.isDisabled()));
      await panel.uncheck('#sec-ack');
      check('withdrawing the confirmation disables Start again', await start.isDisabled());
      check('no panel errors', errors.length === 0, errors.join(' | '));
      await panel.close();
    }

    /* ---------- cancel ---------- */
    console.log('\nCancel');
    {
      const { panel } = await openPanel(env, vuln);
      fx.vuln.log.length = 0;
      await panel.evaluate(() => {
        SEC.view = 'setup';
        SEC.report = null;
        show('security');
      });
      await panel.waitForSelector('#sec-lv-advanced');
      await panel.check('#sec-lv-advanced');
      await panel.click('button:has-text("Start scan")');
      await panel.waitForSelector('.sec-progress');
      await panel.waitForTimeout(1500);
      await panel.click('button:has-text("Cancel scan")');
      await panel.waitForSelector('.sec-head', { timeout: 30000 });
      const report = await reportOf(panel);
      check('cancelling returns a partial report', report.notes.some((n) => /cancelled/i.test(n)));
      check('far fewer than the 150 allowed requests were sent', fx.vuln.log.length < 60, String(fx.vuln.log.length));
      check('unfinished checks are reported as skipped or partial', report.coverage.checks.some((c) => ['skipped', 'partial'].includes(c.state) && c.level !== 'optional' ));
      await panel.close();
    }

    /* ---------- report UI ---------- */
    console.log('\nReport UI');
    {
      const { panel, errors } = await openPanel(env, vuln);
      await panel.evaluate((r) => {
        DF.state.secReport = r;
        show('security');
      }, standardReport);
      await panel.waitForSelector('.sec-head');
      check('a saved report opens in the results view', (await panel.locator('.sec-head').innerText()).includes('saved report'));
      for (const tabName of ['Findings', 'Attack paths', 'Plan', 'Coverage', 'Export', 'Overview']) {
        await panel.click(`.sec-tabs [role=tab]:has-text("${tabName}")`);
        await panel.waitForTimeout(80);
      }
      await panel.click('.sec-tabs [role=tab]:has-text("Findings")');
      const total = await panel.locator('.sec-finding').count();
      check('Findings tab lists every finding', total === standardReport.findings.length, total + ' vs ' + standardReport.findings.length);
      await panel.selectOption('select[aria-label="Severity"]', 'high');
      const high = await panel.locator('.sec-finding').count();
      check('severity filter narrows the list', high > 0 && high < total && high === standardReport.counts.high, high + ' high of ' + total);
      await panel.selectOption('select[aria-label="Severity"]', 'all');
      await panel.fill('input[aria-label="Search findings"]', 'uploads');
      check('search narrows the list', (await panel.locator('.sec-finding').count()) === 1);
      await panel.fill('input[aria-label="Search findings"]', '');
      await panel.selectOption('select[aria-label="Status"]', 'potential');
      const potential = await panel.locator('.sec-finding').count();
      check('status filter works', potential === standardReport.countsByStatus.potential, String(potential));
      await panel.selectOption('select[aria-label="Status"]', 'all');
      await panel.selectOption('select[aria-label="Group"]', 'category');
      check('grouping adds headings', (await panel.locator('.sec-group').count()) > 1);
      await panel.selectOption('select[aria-label="Group"]', 'none');
      // related-finding navigation
      const related = await panel.locator('.sec-finding .sec-related button').first();
      if (await related.count()) {
        await panel.locator('.sec-finding > summary').first().click();
        await panel.locator('.sec-finding .sec-related button').first().click();
        check('a related-finding link opens another finding', (await panel.locator('.sec-finding[open]').count()) >= 1);
      }
      // keyboard navigation of the section tabs
      await panel.locator('.sec-tabs [role=tab][aria-selected=true]').focus();
      await panel.keyboard.press('ArrowRight');
      check('arrow keys move between report sections', (await panel.locator('.sec-tabs [role=tab][aria-selected=true]').innerText()).startsWith('Attack'));
      // disclosure template
      await panel.click('.sec-tabs [role=tab]:has-text("Export")');
      await panel.fill('input[type=text] >> nth=0', 'Sam');
      await panel.click('button:has-text("Regenerate from fields")');
      const msg = await panel.inputValue('textarea[aria-label="Disclosure message"]');
      check('disclosure message uses the entered name and is editable text', /Hello Sam,/.test(msg) && /did not try to sign in/.test(msg));
      check('no panel errors', errors.length === 0, errors.join(' | '));
      if (shotsDir) {
        await panel.click('.sec-tabs [role=tab]:has-text("Coverage")');
        await panel.screenshot({ path: path.join(shotsDir, 'security-coverage.png'), fullPage: true });
      }
      await panel.close();
    }

    /* ---------- regressions fixed in 4.1: before / after ---------- */
    console.log('\nRegressions (original 4.0.0 vs this working tree)');
    {
      const old = await launch(prepareExtension(path.join(scratch, 'ext-old'), 'HEAD'), path.join(scratch, 'profile-old'));
      try {
        // A pasted workflow with a javascript: navigation step. MV3's extension CSP already stops
        // the script from running, so this is hardening: the step is rejected up front.
        for (const [label, e, validated] of [['original 4.0.0', old, false], ['working tree', env, true]]) {
          const { panel, target } = await openPanel(e, vuln);
          const out = await panel.evaluate(() => call('runWorkflow', [{ action: 'navigate', url: 'javascript:window.__pwned=1' }]));
          await panel.waitForTimeout(400);
          const pwned = await target.evaluate(() => window.__pwned === 1).catch(() => false);
          check(label + ': the javascript: step never executes script in the page', !pwned);
          if (validated) check(label + ': the step is rejected with a clear message', out.log[0].ok === false && /http and https/.test(out.log[0].error), JSON.stringify(out.log));
          else check(label + ': the step was accepted (no validation) and navigation was attempted', out.log[0].ok === true, JSON.stringify(out.log));
          if (validated) {
            const imported = await panel.evaluate(() => DFSafe.workflowProblems([{ action: 'navigate', url: 'javascript:alert(1)' }]));
            check(label + ': importing such JSON in the Automate tab is refused', imported.length === 1, JSON.stringify(imported));
          }
          await panel.close();
        }

        // The original build: any page script can read the capture log (including secrets) and forge rules.
        for (const [label, e, exposed] of [['original 4.0.0', old, true], ['working tree', env, false]]) {
          const { panel, target } = await openPanel(e, vuln);
          await panel.evaluate(() => startCapture());
          await sendSecrets(target);
          await target.waitForTimeout(300);
          const read = await target.evaluate((m) => {
            try {
              return { readable: JSON.stringify(window.__dfNet.log).includes(m), forged: (window.__dfNet.setRules([{ id: 'x', enabled: true, action: 'mock', match: '/slow', status: 200, body: 'FORGED' }]), true) };
            } catch (_) {
              return { readable: false, forged: false };
            }
          }, MARKER);
          const sameBody = await target.evaluate(() => fetch('/slow').then((r) => r.text()));
          if (exposed) check(label + ': a page script can read the unredacted capture log and forge responses (bug reproduced)', read.readable && read.forged && sameBody === 'FORGED', JSON.stringify(read) + sameBody);
          else check(label + ': the same script reads nothing and cannot forge responses', !read.readable && !read.forged && sameBody === 'slow ok', JSON.stringify(read) + sameBody);
          await panel.close();
        }

        // XHR aborted while a latency rule is still holding it
        for (const [label, e, expectSent] of [['original 4.0.0', old, true], ['working tree', env, false]]) {
          const { panel, target } = await openPanel(e, vuln);
          fx.vuln.log.length = 0;
          await panel.evaluate(async () => {
            await startCapture();
            net.rules = [{ id: 'r1', action: 'delay', delay: 400, match: '/slow', enabled: true }];
            await pushRules();
          });
          const pageErr = [];
          target.on('pageerror', (er) => pageErr.push(er.message));
          await target.evaluate(() => {
            const x = new XMLHttpRequest();
            x.open('GET', '/slow');
            x.send();
            setTimeout(() => x.abort(), 50);
          });
          await target.waitForTimeout(900);
          const reached = fx.vuln.log.filter((r) => r.url === '/slow').length;
          if (expectSent) check(label + ': an aborted XHR is still sent or errors when the latency rule expires (bug reproduced)', reached > 0 || pageErr.length > 0, 'reached ' + reached + ', errors ' + pageErr.join('|'));
          else check(label + ': an aborted XHR is never sent and raises no error', reached === 0 && pageErr.length === 0, 'reached ' + reached + ', errors ' + pageErr.join('|'));
          await panel.close();
        }
      } finally {
        await old.ctx.close();
      }
    }
  } finally {
    await env.ctx.close();
    await fx.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E ERROR', e);
  process.exit(2);
});
