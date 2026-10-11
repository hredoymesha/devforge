// Security scan runner. Collects evidence through the page agent (agent/security.js), applies the
// scan level and request budget, and builds the report with lib/secreport.js. The UI is in
// panel/security.js. Every network request is made by the agent's scoped gate, never from here.

const SEC_COOKIE_PERMISSION = 'cookies';

class SecScanAborted extends Error {}

const SEC_SCRIPT_BYTES = 1024 * 1024;

async function secCookiePermissionGranted(origin) {
  try {
    return await chrome.permissions.contains({
      permissions: [SEC_COOKIE_PERMISSION],
      origins: [origin + '/*'],
    });
  } catch (_) {
    return false;
  }
}

// Called from a click handler: Chrome only shows the prompt inside a user gesture.
function secRequestCookiePermission(origin) {
  return chrome.permissions.request({
    permissions: [SEC_COOKIE_PERMISSION],
    origins: [origin + '/*'],
  });
}

// Cookie flags without cookie values: the value is dropped before anything leaves this function.
async function secExactCookies(origin) {
  if (!(await secCookiePermissionGranted(origin))) return null;
  const list = await chrome.cookies.getAll({ url: origin + '/' });
  return list.slice(0, 200).map((c) => ({
    name: c.name,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: c.session,
    days: c.expirationDate ? Math.round((c.expirationDate * 1000 - Date.now()) / 86400000) : undefined,
    hostOnly: c.hostOnly,
  }));
}

/*
 * opts: { level, options: {maxRequests, delayMs}, target, control: {cancelled}, onStep(id, state, reason),
 *         onProgress({used, max}), technical: boolean }
 * Resolves with { report, cancelled, technical }. `technical` is detailed diagnostic data, built only
 * when the caller asks for it (Owner mode, unlocked); it never becomes part of the report.
 */
async function secRunScan(opts) {
  const { level, options, target, control, onProgress } = opts;
  // Time each check for the technical diagnostics: from its first "running" to its final state.
  const began = {};
  const timings = {};
  const onStep = (id, state, reason) => {
    if (state === 'running') began[id] = began[id] === undefined ? Date.now() : began[id];
    else if (began[id] !== undefined && timings[id] === undefined) timings[id] = Date.now() - began[id];
    opts.onStep(id, state, reason);
  };
  const budget = DFSecScan.scanBudget(level, options);
  const checks = {};
  const startedAt = new Date().toISOString();
  const tab = await activeTab();
  const tabId = tab.id;
  const pageUrl = tab.url;
  let used = 0;

  const setCheck = (id, state, reason = '', requests = 0) => {
    checks[id] = { state, reason, requests };
    onStep(id, state, reason);
  };
  // A scan belongs to one tab and one origin. If the user moves elsewhere it stops instead of
  // continuing against whatever page is now in front.
  const stillOnTarget = () => {
    if (DF.state.tabId !== tabId) return false;
    try {
      return new URL(DF.state.url).origin === target.origin;
    } catch (_) {
      return false;
    }
  };
  const check = () => {
    if (control.cancelled) throw new SecScanAborted('cancelled');
  };

  const begin = await call('secBegin', budget);
  const scanId = begin.id;
  const request = async (spec) => {
    check();
    if (used >= budget.maxRequests) return { ok: false, blocked: 'request limit reached' };
    used++;
    const r = await call('secRequest', { id: scanId, ...spec });
    onProgress({ used, max: budget.maxRequests });
    if (!stillOnTarget()) {
      control.cancelled = true;
      control.reason = 'The active tab or page changed, so the scan stopped.';
      throw new SecScanAborted('tab changed');
    }
    return r;
  };

  const data = { checks, probes: [], probeLog: [], scripts: { urls: [], items: [], inline: [] } };
  let facts = null;
  try {
    /* ---- page contents (no requests) ---- */
    onStep('page', 'running');
    facts = await call('secFacts');
    data.scripts.urls = facts.scripts.map((s) => s.src);
    data.scripts.inline = facts.inlineScripts || [];
    setCheck('page', 'done');
    setCheck('cookies', 'done', 'Script-visible cookies and web-storage key names. Names only.');
    setCheck('libraries', 'done', facts.scripts.length + ' script address(es) examined.');
    check();

    /* ---- observed traffic from the Network tab ---- */
    if (typeof net !== 'undefined' && net.captureOn && net.rows.size) {
      data.traffic = { entries: [...net.rows.values()] };
      setCheck('traffic', 'done', net.rows.size + ' captured request(s) analysed.');
    } else {
      setCheck('traffic', 'skipped', 'Network capture was off. Turn it on in the Network tab, use the site, then scan again to include the requests the page makes.');
    }

    /* ---- response headers ---- */
    onStep('headers', 'running');
    const here = new URL(pageUrl);
    const pagePath = here.pathname + here.search;
    const headerSpec = { path: pagePath, allowQuery: true, follow: true, headers: await call('secHeaderNames'), purpose: 'page response headers' };
    let before = used;
    let res = await request({ ...headerSpec, method: 'HEAD' });
    let method = 'HEAD';
    if (!(res.ok && res.status >= 200 && res.status < 400)) {
      method = 'GET';
      res = await request({ ...headerSpec, method: 'GET', maxBytes: 0 });
    }
    data.headers = res.ok && res.headers ? { ok: true, status: res.status, method, headers: res.headers } : { ok: false, error: res.error || res.blocked || 'no response' };
    setCheck('headers', data.headers.ok ? 'done' : 'failed', data.headers.ok ? 'HTTP ' + res.status + ' via ' + method + ', without cookies.' : data.headers.error, used - before);

    /* ---- security.txt ---- */
    before = used;
    const txt = await request({ method: 'GET', path: '/.well-known/security.txt', maxBytes: 16384, purpose: 'security contact file' });
    if (txt.ok) {
      const isText = /^text\/plain/i.test(txt.type || '');
      data.securityTxt = { found: txt.status === 200 && isText, status: txt.status, text: txt.status === 200 && isText ? txt.text : '' };
      setCheck('security-txt', 'done', txt.status === 200 && !isText ? 'The address returned a page that is not plain text, which is treated as "not found".' : 'HTTP ' + txt.status + '.', used - before);
    } else {
      data.securityTxt = { found: false, status: 'skipped' };
      setCheck('security-txt', 'failed', txt.error || txt.blocked, used - before);
    }

    if (level !== 'passive') {
      /* ---- what the site does for a path that cannot exist ---- */
      before = used;
      onStep('baseline', 'running');
      const nope = '/__devforge_probe_' + Math.random().toString(36).slice(2, 10);
      const b = await request({ method: 'GET', path: nope, maxBytes: 8192, purpose: 'baseline for a missing path' });
      if (b.ok) {
        data.baseline = { path: nope, res: { status: b.status, type: b.type, text: b.text || '' } };
        setCheck('baseline', 'done', 'HTTP ' + b.status + (b.status === 200 ? ' (the site answers unknown paths with a page, so results are compared against it).' : '.'), used - before);
      } else setCheck('baseline', 'failed', b.error || b.blocked, used - before);

      /* ---- robots.txt ---- */
      before = used;
      onStep('robots', 'running');
      const rb = await request({ method: 'GET', path: '/robots.txt', maxBytes: 65536, purpose: 'robots.txt' });
      if (rb.ok) {
        const real = rb.status === 200 && /^text\/plain/i.test(rb.type || '');
        data.robots = { found: real, text: real ? rb.text : '' };
        setCheck('robots', 'done', 'HTTP ' + rb.status + '.', used - before);
      } else setCheck('robots', 'failed', rb.error || rb.blocked, used - before);

      /* ---- the page's own scripts and their source maps ---- */
      before = used;
      onStep('scripts', 'running');
      const limit = DFSecScan.SCRIPT_LIMIT[level] || 10;
      const urls = facts.scriptFetch.slice(0, limit);
      let failedScripts = 0;
      for (const url of urls) {
        const s = await request({ method: 'GET', url, allowQuery: true, cache: 'force-cache', maxBytes: SEC_SCRIPT_BYTES, purpose: 'page script' });
        if (!s.ok || s.status !== 200) {
          failedScripts++;
          continue;
        }
        const item = { url, text: s.text || '' };
        const ref = DFSecProbe.sourceMapRef(item.text);
        if (ref && !/^data:/i.test(ref)) {
          let mapUrl = null;
          try {
            const u = new URL(ref, url);
            if (u.origin === target.origin) mapUrl = u.href;
          } catch (_) {
            /* an unparseable reference is simply ignored */
          }
          if (mapUrl) {
            const m = await request({ method: 'GET', url: mapUrl, allowQuery: true, cache: 'force-cache', maxBytes: 2048, purpose: 'source map' });
            item.map = {
              url: mapUrl,
              status: m.status,
              exposed: !!(m.ok && m.status === 200 && /"version"\s*:\s*\d/.test(m.text || '') && /"(sources|mappings)"/.test(m.text || '')),
            };
          }
        }
        data.scripts.items.push(item);
      }
      const skippedScripts = facts.scriptFetch.length - urls.length;
      setCheck(
        'scripts',
        failedScripts || skippedScripts ? 'partial' : 'done',
        data.scripts.items.length + ' same-origin script(s) read from cache or server' + (skippedScripts ? '; ' + skippedScripts + ' more were not read (level limit)' : '') + (failedScripts ? '; ' + failedScripts + ' could not be read' : '') + '. Third-party scripts are not fetched.',
        used - before
      );

      /* ---- well-known sensitive paths ---- */
      before = used;
      onStep('probes', 'running');
      const probes = DFSecProbe.probesFor(level === 'advanced' ? 'advanced' : 'standard');
      let ran = 0;
      for (const p of probes) {
        if (used >= budget.maxRequests) break;
        if (!DFSecProbe.isSafeProbePath(p.path)) continue;
        const r = await request({ method: 'GET', path: p.path, maxBytes: 8192, purpose: p.id });
        ran++;
        data.probeLog.push({ id: p.id, path: p.path, status: r.ok ? r.status : 0, type: r.type || '', bytes: r.bytes || 0, error: r.ok ? undefined : r.error || r.blocked });
        if (r.ok && (r.status === 200 || r.status === 401)) {
          data.probes.push({ probe: p.id, path: p.path, res: { status: r.status, type: r.type, text: r.text || '', redirected: r.redirected, wwwAuthenticate: r.wwwAuthenticate } });
        }
        onStep('probes', 'running', ran + ' of ' + probes.length + ' paths');
      }
      setCheck(
        'probes',
        ran < probes.length ? 'partial' : 'done',
        ran < probes.length ? 'Request limit reached after ' + ran + ' of ' + probes.length + ' paths. Raise the limit or choose a deeper level to run the rest.' : ran + ' path(s) requested. A hit needs a matching file signature, not just HTTP 200.',
        used - before
      );
    }
  } catch (e) {
    if (!(e instanceof SecScanAborted)) {
      // Anything unexpected ends the scan but keeps what was already collected.
      control.error = e.message || String(e);
    }
  }

  // Cookie flags need an optional permission and make no requests, so they run even after a cancel.
  try {
    const exact = await secExactCookies(target.origin);
    if (exact) {
      data.cookies = { exact: true, list: exact };
      setCheck('cookie-flags', 'done', exact.length + ' cookie(s); values are never read.');
    } else setCheck('cookie-flags', 'skipped', 'Optional permission not granted, so HttpOnly and SameSite flags are unknown. Use "Allow cookie flag checks" to enable it.');
  } catch (e) {
    setCheck('cookie-flags', 'failed', e.message);
  }

  const ended = await call('secEnd').catch(() => ({ log: [] }));
  const cancelled = !!control.cancelled;
  // Checks that never started are reported as skipped, with the reason.
  for (const c of DFSecReport.CHECKS) {
    if (checks[c.id]) continue;
    const covered = c.level === 'optional' || c.level === 'passive' || level !== 'passive';
    if (covered && (cancelled || control.error))
      checks[c.id] = { state: 'skipped', reason: cancelled ? control.reason || 'Cancelled before this check ran.' : 'Not run because the scan stopped: ' + control.error };
  }
  for (const [id, c] of Object.entries(checks)) if (c.state === 'running') checks[id] = { ...c, state: 'partial' };

  if (!facts) {
    const msg = control.error || control.reason || 'The page could not be read.';
    throw new Error(msg);
  }
  const report = DFSecReport.buildReport({
    url: pageUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    level,
    budget,
    requestLog: ended.log || [],
    facts,
    headers: data.headers,
    securityTxt: data.securityTxt,
    robots: data.robots,
    baseline: data.baseline,
    probes: data.probes,
    scripts: data.scripts,
    cookies: data.cookies,
    traffic: data.traffic,
    checks,
  });
  // Added after assembly, so they get the same scrubbing as the rest of the report.
  if (cancelled) report.notes.unshift(DFSecReport.scrub(control.reason || 'The scan was cancelled. Results cover only the checks that finished.'));
  if (control.error) report.notes.unshift(DFSecReport.scrub('The scan stopped early because of an error: ' + control.error));
  let technical = null;
  if (opts.technical) {
    technical = DFSecReport.buildTechnical({
      report,
      facts,
      headers: data.headers,
      baseline: data.baseline,
      probeLog: data.probeLog,
      scripts: data.scripts,
      cookies: data.cookies,
      traffic: data.traffic,
      timings,
      environment: { extensionVersion: chrome.runtime.getManifest().version, agentVersion: AGENT_VERSION, userAgent: navigator.userAgent.slice(0, 200) },
    });
  }
  return { report, cancelled, technical };
}
