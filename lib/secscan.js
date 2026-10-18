/*
 * Analysis for the Security tab. Everything here is a pure function over data that the page agent
 * and the panel collected, so it runs in the panel and in Node tests. Nothing in this file touches
 * the network. Report assembly, attack paths and exports live in lib/secreport.js.
 *
 * A finding has:
 *   id, title, resource (affected address or path), owasp (A01..A10), theme,
 *   severity   high | medium | low | info          how bad it is if the condition is real
 *   confidence high | medium | low                 how sure we are that the evidence means that
 *   status     confirmed | potential | manual | info
 *                confirmed  the condition itself was directly observed (a header is absent, a file
 *                           is readable). It does not mean it is exploitable.
 *                potential  a pattern points at a possible problem; the conditions were not verified
 *                manual     cannot be judged from here; a person needs to check, see `verify`
 *                info       an observation worth knowing, not a weakness by itself
 *   evidence, why (plain language), impact, verify (safe steps), fix, example, details, refs
 *
 * Severity and confidence are separate on purpose, and nothing here calls a pattern a confirmed
 * vulnerability.
 */
const DFSecScan = (() => {
  // Loaded after lib/safe.js and lib/secprobe.js in the panel; required directly under Node.
  const Safe = typeof DFSafe !== 'undefined' ? DFSafe : require('./safe.js');
  const Probe = typeof DFSecProbe !== 'undefined' ? DFSecProbe : require('./secprobe.js');

  const SEVERITIES = ['high', 'medium', 'low', 'info'];
  const STATUSES = ['confirmed', 'potential', 'manual', 'info'];
  const RANK = { high: 0, medium: 1, low: 2, info: 3 };

  const OWASP = {
    A01: 'A01:2021 Broken Access Control',
    A02: 'A02:2021 Cryptographic Failures',
    A03: 'A03:2021 Injection',
    A04: 'A04:2021 Insecure Design',
    A05: 'A05:2021 Security Misconfiguration',
    A06: 'A06:2021 Vulnerable and Outdated Components',
    A07: 'A07:2021 Identification and Authentication Failures',
    A08: 'A08:2021 Software and Data Integrity Failures',
    A09: 'A09:2021 Security Logging and Monitoring Failures',
    A10: 'A10:2021 Server-Side Request Forgery',
  };

  const MDN = 'https://developer.mozilla.org/en-US/docs/Web/';
  const OWASP_CS = 'https://cheatsheetseries.owasp.org/cheatsheets/';

  function finding(f) {
    const out = {
      confidence: 'high',
      status: 'confirmed',
      owasp: 'A05',
      theme: 'misc',
      effort: 'moderate',
      resource: '',
      refs: [],
      ...f,
    };
    if (out.status === 'info') out.severity = 'info';
    out.category = OWASP[out.owasp] || out.owasp;
    return out;
  }

  /* ---------- target classification ---------- */

  const LOCAL_SUFFIX = /\.(localhost|local|internal|test|example|invalid|lan)$/i;
  const IPV4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

  function isLocalHost(host) {
    host = String(host || '')
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    if (host === 'localhost' || LOCAL_SUFFIX.test(host)) return true;
    const m = host.match(IPV4);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  }

  /*
   * Decides whether DevForge may scan a page and whether it needs the user's confirmation first.
   *   kind "local"       localhost, private networks and reserved test domains: no confirmation
   *   kind "public"      any other http(s) site: the user must confirm they may test it
   *   kind "unsupported" anything else (chrome://, file:, extension pages, ...)
   */
  function classifyTarget(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return { kind: 'unsupported', reason: 'This tab has no web address that can be checked.' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return {
        kind: 'unsupported',
        reason: 'Only http and https pages can be checked (this one is ' + u.protocol + ').',
      };
    }
    const local = isLocalHost(u.hostname);
    return {
      kind: local ? 'local' : 'public',
      origin: u.origin,
      host: u.hostname,
      reason: local
        ? 'Local or reserved address, treated as a development or training environment.'
        : 'Public website. Only scan sites you own or have permission to test.',
    };
  }

  /* ---------- scan levels ---------- */

  /*
   * What each level may do. The agent enforces the same ceilings (agent/security.js), so a
   * modified panel cannot ask for more than this. All requests go to the scanned origin only,
   * use GET or HEAD, carry no cookies, and are spaced out.
   */
  const LEVELS = {
    passive: {
      label: 'Passive',
      summary: 'Reads the open page and its response headers. Sends at most 3 requests.',
      maxRequests: 3,
      delayMs: 0,
      probes: null,
      requires: 'confirm',
    },
    standard: {
      label: 'Standard',
      summary: 'Adds low-impact checks: a few well-known files, source maps and a scan of the page’s own scripts. Up to 60 requests.',
      maxRequests: 60,
      delayMs: 250,
      probes: 'standard',
      requires: 'confirm',
    },
    advanced: {
      label: 'Advanced',
      summary: 'Adds a longer list of sensitive paths and more scripts. Up to 150 requests, so it is visible in server logs and may trigger alerts.',
      maxRequests: 150,
      delayMs: 150,
      probes: 'advanced',
      requires: 'advanced',
    },
  };
  const HARD_MAX_REQUESTS = 200;
  const HARD_MIN_DELAY_MS = 100;

  // Clamps user-chosen options to what the level and the hard limits allow.
  function scanBudget(level, options = {}) {
    const lv = LEVELS[level] || LEVELS.passive;
    const max = Math.min(Math.max(parseInt(options.maxRequests, 10) || lv.maxRequests, 3), HARD_MAX_REQUESTS);
    const delay = Math.max(parseInt(options.delayMs, 10) || lv.delayMs, lv.delayMs ? HARD_MIN_DELAY_MS : 0);
    return {
      level: LEVELS[level] ? level : 'passive',
      maxRequests: level === 'passive' ? lv.maxRequests : Math.min(max, HARD_MAX_REQUESTS),
      delayMs: delay,
    };
  }

  // How many of the page's own scripts each level reads (each may add one source-map request).
  const SCRIPT_LIMIT = { standard: 10, advanced: 25 };

  /*
   * What a scan would send, without sending anything. Mirrors the runner (panel/securityrun.js):
   * the page's headers (one HEAD, plus one GET if HEAD does not give a usable answer), security.txt,
   * and for Standard/Advanced the missing-path baseline, robots.txt, the page's scripts (and their
   * source maps) and then the probe list in catalog order until the budget runs out.
   */
  function planScan(level, options = {}, { scripts = 0 } = {}) {
    const budget = scanBudget(level, options);
    const steps = [{ purpose: 'page response headers', min: 1, max: 2 }, { purpose: 'security.txt', min: 1, max: 1 }];
    const lv = budget.level;
    let probes = { planned: 0, total: 0, paths: [], skippedForBudget: 0 };
    if (lv !== 'passive') {
      const read = Math.min(SCRIPT_LIMIT[lv] || 10, scripts);
      steps.push({ purpose: 'missing-path baseline', min: 1, max: 1 }, { purpose: 'robots.txt', min: 1, max: 1 }, { purpose: 'page scripts (cache first)', min: read, max: read }, { purpose: 'source maps referenced by those scripts', min: 0, max: read });
      const catalog = Probe.probesFor(lv === 'advanced' ? 'advanced' : 'standard');
      const before = steps.reduce((n, s) => n + s.max, 0);
      const room = Math.max(0, budget.maxRequests - before);
      const chosen = catalog.slice(0, room);
      probes = { planned: chosen.length, total: catalog.length, paths: chosen.map((p) => p.path), skippedForBudget: catalog.length - chosen.length };
      steps.push({ purpose: 'well-known sensitive paths', min: chosen.length, max: chosen.length });
    }
    const minTotal = Math.min(steps.reduce((n, s) => n + s.min, 0), budget.maxRequests);
    const maxTotal = Math.min(steps.reduce((n, s) => n + s.max, 0), budget.maxRequests);
    return { level: lv, budget, steps, probes, minTotal, maxTotal, methods: 'GET and HEAD only', credentials: 'none (no cookies)', scope: 'the scanned origin only' };
  }

  /* ---------- Content-Security-Policy ---------- */

  function parseCsp(text) {
    const policy = {};
    for (const part of String(text || '').split(';')) {
      const bits = part.trim().split(/\s+/).filter(Boolean);
      if (!bits.length) continue;
      const name = bits[0].toLowerCase();
      if (!(name in policy)) policy[name] = bits.slice(1);
    }
    return policy;
  }

  function analyzeCsp(text, { reportOnly = false, resource = '' } = {}) {
    const out = [];
    const policy = parseCsp(text);
    const label = reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    const refs = [MDN + 'HTTP/Headers/Content-Security-Policy', OWASP_CS + 'Content_Security_Policy_Cheat_Sheet.html'];
    const base = { owasp: 'A05', theme: 'headers', resource, refs };
    const scriptSrc = policy['script-src'] || policy['default-src'];
    const scriptName = policy['script-src'] ? 'script-src' : 'default-src';

    if (reportOnly) {
      out.push(
        finding({
          ...base,
          id: 'csp-report-only',
          title: 'The policy only reports, it does not block',
          severity: 'info',
          status: 'info',
          evidence: label + ' is set and no enforcing Content-Security-Policy was seen.',
          why: 'A report-only policy is a good way to test a policy safely, but it does not protect visitors until it is enforced.',
          impact: 'Injected scripts are not blocked while the policy stays in report-only mode.',
          verify: 'Check the browser console on a few pages for policy reports, then switch the header name.',
          fix: 'When the reports look clean, serve the same policy as Content-Security-Policy.',
          effort: 'quick',
        })
      );
    }
    if (!scriptSrc) {
      out.push(
        finding({
          ...base,
          id: 'csp-no-script-src',
          title: 'The policy does not restrict scripts',
          severity: 'medium',
          evidence: label + ' has neither script-src nor default-src.',
          why: 'Without a script rule, the policy does little to stop injected scripts from running.',
          impact: 'If an attacker finds a way to inject script into a page, the policy will not stop it.',
          verify: 'Read the header value and check which directives it lists.',
          fix: "Add script-src (or default-src) with the sources you actually use, for example script-src 'self'.",
        })
      );
    } else {
      const strict = scriptSrc.some((s) => /^'(nonce-|sha(256|384|512)-)/.test(s) || s === "'strict-dynamic'");
      if (scriptSrc.includes("'unsafe-inline'") && !strict) {
        out.push(
          finding({
            ...base,
            id: 'csp-unsafe-inline',
            title: "The policy allows inline scripts ('unsafe-inline')",
            severity: 'medium',
            evidence: scriptName + " contains 'unsafe-inline' and no nonce or hash.",
            why: 'Allowing inline scripts removes most of the protection a CSP gives against cross-site scripting (XSS).',
            impact: 'A cross-site scripting bug elsewhere in the site would not be contained by this policy.',
            verify: 'Search the page for inline <script> blocks and onclick-style attributes that depend on this allowance.',
            fix: "Move inline scripts into files, or allow them with a per-response nonce or a hash, then remove 'unsafe-inline'.",
          })
        );
      }
      if (scriptSrc.includes("'unsafe-eval'")) {
        out.push(
          finding({
            ...base,
            id: 'csp-unsafe-eval',
            title: "The policy allows eval() ('unsafe-eval')",
            severity: 'low',
            evidence: scriptName + " contains 'unsafe-eval'.",
            why: 'It lets scripts turn text into code, which makes injected content easier to run.',
            impact: 'Weakens the policy against script injection.',
            verify: 'Check whether a framework or library needs it (some only need it in development builds).',
            fix: "Remove 'unsafe-eval'.",
          })
        );
      }
      const broad = scriptSrc.filter((s) => s === '*' || s === 'https:' || s === 'http:' || s === 'data:');
      if (broad.length) {
        out.push(
          finding({
            ...base,
            id: 'csp-broad-source',
            title: 'The script rule allows very broad sources',
            severity: 'medium',
            evidence: scriptName + ' contains ' + broad.join(', ') + '.',
            why: 'If any site on the internet can supply scripts, the rule gives little protection.',
            impact: 'An attacker who can load a script from any allowed host can run it on your page.',
            verify: 'List the hosts your site really loads scripts from.',
            fix: 'List the specific hosts you rely on, or use nonces with strict-dynamic.',
          })
        );
      }
    }
    if (!policy['object-src'] && !(policy['default-src'] || []).includes("'none'")) {
      out.push(
        finding({
          ...base,
          id: 'csp-no-object-src',
          title: 'The policy does not block plugins (object-src)',
          severity: 'low',
          evidence: 'No object-src, and default-src is not none.',
          why: 'Old plugin content can sometimes be used to get around script rules.',
          impact: 'Small today; plugin content is rare in modern browsers.',
          verify: 'Check the header for object-src.',
          fix: "Add object-src 'none'.",
          effort: 'quick',
        })
      );
    }
    if (!policy['base-uri']) {
      out.push(
        finding({
          ...base,
          id: 'csp-no-base-uri',
          title: 'The policy does not limit <base> tags (base-uri)',
          severity: 'low',
          evidence: 'No base-uri directive.',
          why: 'An injected <base> tag can change where relative script paths load from.',
          impact: 'Could let injected markup redirect relative script loads to an attacker-controlled host.',
          verify: 'Check the header for base-uri.',
          fix: "Add base-uri 'self' (or 'none').",
          effort: 'quick',
        })
      );
    }
    return out;
  }

  /* ---------- response headers ---------- */

  const lowerKeys = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const parseMaxAge = (value) => {
    const m = String(value || '').match(/max-age\s*=\s*"?(\d+)/i);
    return m ? +m[1] : null;
  };

  /*
   * headers: response headers of the page (null for any header that was absent)
   * ctx: { https: boolean, hasPasswordForm: boolean, resource: string }
   */
  function analyzeHeaders(rawHeaders, ctx = {}) {
    const h = lowerKeys(rawHeaders);
    const out = [];
    const resource = ctx.resource || '';
    const base = { owasp: 'A05', theme: 'headers', resource };

    const csp = h['content-security-policy'];
    const cspRo = h['content-security-policy-report-only'];
    if (csp) out.push(...analyzeCsp(csp, { resource }));
    else if (cspRo) out.push(...analyzeCsp(cspRo, { reportOnly: true, resource }));
    else {
      out.push(
        finding({
          ...base,
          id: 'csp-missing',
          title: 'No Content-Security-Policy header',
          severity: 'medium',
          evidence: 'The response has no Content-Security-Policy header.',
          why: 'A Content-Security-Policy tells the browser which scripts and resources it may load. It is the main safety net if an attacker manages to inject script into a page.',
          impact: 'If a cross-site scripting bug exists anywhere on the site, nothing limits what the injected script can do.',
          verify: 'Open DevTools → Network, select the page request and look at its response headers.',
          fix: "Start with a report-only policy, fix what it reports, then enforce it.",
          example: "Content-Security-Policy-Report-Only: default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
          refs: [MDN + 'HTTP/Headers/Content-Security-Policy'],
        })
      );
    }

    const hsts = h['strict-transport-security'];
    if (ctx.https) {
      if (!hsts) {
        out.push(
          finding({
            ...base,
            owasp: 'A02',
            id: 'hsts-missing',
            title: 'No Strict-Transport-Security (HSTS) header',
            severity: 'medium',
            evidence: 'The HTTPS response has no Strict-Transport-Security header.',
            why: 'HSTS tells browsers to always use HTTPS for this site. Without it, a visitor on a hostile network can be tricked into an unencrypted first request.',
            impact: 'A person on the same network (public Wi-Fi) may downgrade a visitor’s first connection and read or alter it.',
            verify: 'Check the response headers of the HTTPS page.',
            fix: 'Send Strict-Transport-Security once every subdomain works over HTTPS.',
            example: 'Strict-Transport-Security: max-age=31536000; includeSubDomains',
            refs: [MDN + 'HTTP/Headers/Strict-Transport-Security'],
            effort: 'quick',
          })
        );
      } else {
        const age = parseMaxAge(hsts);
        if (age !== null && age < 15552000) {
          out.push(
            finding({
              ...base,
              owasp: 'A02',
              id: 'hsts-short',
              title: 'HSTS lifetime is short',
              severity: 'low',
              evidence: 'Strict-Transport-Security: ' + hsts + ' (' + Math.round(age / 86400) + ' days).',
              why: 'A short lifetime means browsers forget the rule quickly and the protection lapses.',
              impact: 'Visitors who return after the lifetime ends are exposed to downgrade attempts again.',
              verify: 'Read the max-age value in the header.',
              fix: 'Raise max-age to at least 15552000 (180 days); 31536000 (one year) is common.',
              refs: [MDN + 'HTTP/Headers/Strict-Transport-Security'],
              effort: 'quick',
            })
          );
        }
      }
    }

    if (String(h['x-content-type-options'] || '').toLowerCase() !== 'nosniff') {
      out.push(
        finding({
          ...base,
          id: 'nosniff-missing',
          title: 'No X-Content-Type-Options: nosniff',
          severity: 'low',
          evidence: 'X-Content-Type-Options is ' + (h['x-content-type-options'] || 'absent') + '.',
          why: 'Without it, a browser may guess that an uploaded file is a script and run it.',
          impact: 'Can turn a file-upload feature into a way to run script, if uploads are served from the same site.',
          verify: 'Check the response headers.',
          fix: 'Send X-Content-Type-Options: nosniff on all responses.',
          example: 'X-Content-Type-Options: nosniff',
          refs: [MDN + 'HTTP/Headers/X-Content-Type-Options'],
          effort: 'quick',
        })
      );
    }

    const frameAncestors = parseCsp(csp)['frame-ancestors'];
    if (!h['x-frame-options'] && !frameAncestors) {
      out.push(
        finding({
          ...base,
          id: 'clickjacking',
          title: 'The page can be shown inside another site (clickjacking)',
          severity: ctx.hasPasswordForm ? 'medium' : 'low',
          evidence: 'No X-Frame-Options header and no frame-ancestors rule in the CSP.',
          why: 'Another site could load this page in an invisible frame and trick visitors into clicking buttons on it.',
          impact: 'Visitors could be tricked into performing actions (such as confirming a change) on this site while believing they are clicking something else.',
          verify: 'Create a test page you control that embeds this page in an <iframe> and see whether it loads.',
          fix: 'Send a frame-ancestors rule (or X-Frame-Options) that allows only your own site.',
          example: "Content-Security-Policy: frame-ancestors 'self'",
          refs: [MDN + 'HTTP/Headers/X-Frame-Options', OWASP_CS + 'Clickjacking_Defense_Cheat_Sheet.html'],
          effort: 'quick',
        })
      );
    }

    const referrer = String(h['referrer-policy'] || '').toLowerCase();
    if (!referrer) {
      out.push(
        finding({
          ...base,
          id: 'referrer-missing',
          title: 'No Referrer-Policy header',
          severity: 'info',
          status: 'info',
          evidence: 'The response has no Referrer-Policy.',
          why: 'Browsers apply a sensible default today, but setting it explicitly keeps full page addresses from leaking to other sites in older browsers.',
          impact: 'Page addresses (which can contain tokens or search terms) may be sent to other sites in older browsers.',
          verify: 'Check the response headers.',
          fix: 'Send Referrer-Policy: strict-origin-when-cross-origin (or stricter).',
          example: 'Referrer-Policy: strict-origin-when-cross-origin',
          refs: [MDN + 'HTTP/Headers/Referrer-Policy'],
          effort: 'quick',
        })
      );
    } else if (/(^|,\s*)(unsafe-url|no-referrer-when-downgrade)\s*$/.test(referrer)) {
      out.push(
        finding({
          ...base,
          id: 'referrer-weak',
          title: 'Referrer-Policy sends full page addresses to other sites',
          severity: 'low',
          evidence: 'Referrer-Policy: ' + referrer,
          why: 'Page addresses can contain private details such as reset links or search terms.',
          impact: 'Private details in URLs can leak to third-party sites that the page links to or loads resources from.',
          verify: 'Check whether any page address contains tokens or personal data.',
          fix: 'Use strict-origin-when-cross-origin or no-referrer.',
          refs: [MDN + 'HTTP/Headers/Referrer-Policy'],
          effort: 'quick',
        })
      );
    }

    if (!h['permissions-policy']) {
      out.push(
        finding({
          ...base,
          id: 'permissions-policy-missing',
          title: 'No Permissions-Policy header',
          severity: 'info',
          status: 'info',
          evidence: 'The response has no Permissions-Policy.',
          why: 'It lets a site switch off browser features (camera, microphone, geolocation) that it does not use, including for embedded third-party content.',
          impact: 'Embedded third-party content is not prevented from asking for powerful browser features.',
          verify: 'Check the response headers.',
          fix: 'Disable the features you do not use and loosen only what you need.',
          example: 'Permissions-Policy: camera=(), microphone=(), geolocation=()',
          refs: [MDN + 'HTTP/Headers/Permissions-Policy'],
          effort: 'quick',
        })
      );
    }

    for (const name of ['server', 'x-powered-by', 'x-aspnet-version']) {
      const value = h[name];
      if (value && /\d+\.\d+/.test(value)) {
        out.push(
          finding({
            ...base,
            id: 'version-disclosure-' + name,
            title: 'The server announces its software version',
            theme: 'disclosure',
            severity: 'info',
            status: 'info',
            evidence: name + ': ' + value,
            why: 'Exact version numbers help an attacker look up known weaknesses. This is a hint, not a vulnerability by itself.',
            impact: 'Makes targeted attacks against known versions easier.',
            verify: 'Compare the version with the vendor’s current release and security notices.',
            fix: 'Hide or shorten the ' + name + ' header in your web server or framework settings.',
            refs: [OWASP_CS + 'HTTP_Headers_Cheat_Sheet.html'],
            effort: 'quick',
          })
        );
      }
    }

    const acao = h['access-control-allow-origin'];
    if (acao === '*' && String(h['access-control-allow-credentials']).toLowerCase() === 'true') {
      out.push(
        finding({
          ...base,
          theme: 'cors',
          id: 'cors-wildcard-credentials',
          title: 'CORS allows any origin together with credentials',
          severity: 'medium',
          status: 'potential',
          confidence: 'medium',
          evidence: 'Access-Control-Allow-Origin: * and Access-Control-Allow-Credentials: true.',
          why: 'Browsers refuse this combination, but it suggests the CORS setup is misconfigured and may reflect other origins elsewhere.',
          impact: 'If the server also reflects arbitrary origins, other websites could read signed-in responses.',
          verify: 'With permission, send a request with a different Origin header (curl) and see whether the server reflects it with credentials allowed. DevForge cannot set the Origin header, so it does not test this.',
          fix: 'Return a specific allowed origin from a fixed list instead of a wildcard when credentials are involved.',
          refs: [MDN + 'HTTP/CORS'],
        })
      );
    } else if (acao === '*') {
      out.push(
        finding({
          ...base,
          theme: 'cors',
          id: 'cors-wildcard',
          title: 'The page response allows any origin to read it (CORS *)',
          severity: 'info',
          status: 'info',
          evidence: 'Access-Control-Allow-Origin: * on the page response.',
          why: 'This is fine for public data, but a wildcard on a page or API that returns personal data would be a problem.',
          impact: 'Any website can read this response from a visitor’s browser (without cookies).',
          verify: 'Check whether this URL returns anything that should not be public.',
          fix: 'Use a specific origin, or remove the header if cross-origin reads are not intended.',
          refs: [MDN + 'HTTP/CORS'],
        })
      );
    }

    if (ctx.hasPasswordForm && !/no-store/i.test(h['cache-control'] || '')) {
      out.push(
        finding({
          ...base,
          owasp: 'A04',
          id: 'cache-sensitive-page',
          title: 'A page with a password form may be cached',
          severity: 'info',
          status: 'info',
          evidence: 'Cache-Control is ' + (h['cache-control'] || 'absent') + ' on a page containing a password field.',
          why: 'Cached copies of sign-in pages can be shown to the next person using a shared computer.',
          impact: 'Low: mainly affects shared computers.',
          verify: 'Check the Cache-Control header on sign-in and account pages.',
          fix: 'Send Cache-Control: no-store on pages that handle credentials.',
          example: 'Cache-Control: no-store',
          refs: [MDN + 'HTTP/Headers/Cache-Control'],
          effort: 'quick',
        })
      );
    }
    return out;
  }

  /* ---------- page contents ---------- */

  const looksSecret = (name) => Safe.isSensitiveKey(name);
  const REDIRECT_PARAM = /^(url|redirect|redirect_?uri|redirect_?url|return|return_?url|return_?to|next|continue|dest|destination|goto|target|forward|callback|link|r|u)$/i;
  const ID_PARAM = /^(id|uid|user_?id|account(_?id)?|order(_?id)?|invoice(_?id)?|doc(ument)?(_?id)?|file(_?id)?|profile(_?id)?|customer(_?id)?)$/i;

  const evidenceList = (items, max = 5) => items.slice(0, max).join('; ') + (items.length > max ? '; … (+' + (items.length - max) + ' more)' : '');

  /*
   * facts: what agent/security.js collected from the page (see secFacts there).
   * Values from the page (URL parameters, cookies, storage) arrive as names and kinds only.
   */
  function analyzeFacts(facts) {
    const out = [];
    const https = facts.protocol === 'https:';
    const pageUrl = facts.origin || '';
    const forms = facts.forms || [];
    const hasPasswordForm = forms.some((f) => f.hasPassword);

    if (!https) {
      // Plain HTTP is normal on localhost and lab networks; it only matters once the site is public.
      const severity = facts.isLocal ? 'info' : hasPasswordForm ? 'high' : 'medium';
      out.push(
        finding({
          id: 'no-https',
          owasp: 'A02',
          theme: 'transport',
          title: facts.isLocal ? 'The page is served over HTTP (fine for local development)' : 'The page is not served over HTTPS',
          severity,
          status: facts.isLocal ? 'info' : 'confirmed',
          resource: pageUrl,
          evidence: 'The page address starts with ' + facts.protocol + '//.',
          why: 'Everything sent to or from an HTTP page, including passwords, can be read or changed by anyone on the network path.',
          impact: 'Passwords, session cookies and page content can be read or modified in transit.',
          verify: 'Look at the address bar: a site with HTTPS shows a padlock and https://.',
          fix: "Get a certificate (free ones are available from Let's Encrypt), serve the site over HTTPS and redirect HTTP to it.",
          refs: [MDN + 'Security/Mixed_content'],
          effort: 'involved',
        })
      );
    }

    const mixed = facts.mixed || [];
    const mixedActive = mixed.filter((m) => /^(script|link|css|iframe|xmlhttprequest|fetch|other)$/.test(m.type));
    const mixedPassive = mixed.filter((m) => !mixedActive.includes(m));
    if (https && mixedActive.length) {
      out.push(
        finding({
          id: 'mixed-active',
          owasp: 'A02',
          theme: 'transport',
          title: 'Scripts or other active content load over plain HTTP',
          severity: 'high',
          resource: mixedActive[0].url,
          evidence: mixedActive.length + ' resource(s), for example ' + mixedActive[0].url,
          why: 'Content loaded over HTTP can be swapped by someone on the network, which would let them change what the page does.',
          impact: 'Someone on the network path could replace the script and take control of the page.',
          verify: 'Open DevTools → Network and filter for http:// requests on the HTTPS page.',
          fix: 'Load every resource over https://. Browsers block most of these requests, which can also break parts of the page.',
          details: mixedActive.slice(0, 20).map((m) => m.type + ' ' + m.url).join('\n'),
          refs: [MDN + 'Security/Mixed_content'],
          effort: 'quick',
        })
      );
    }
    if (https && mixedPassive.length) {
      out.push(
        finding({
          id: 'mixed-passive',
          owasp: 'A02',
          theme: 'transport',
          title: 'Images or media load over plain HTTP',
          severity: 'low',
          resource: mixedPassive[0].url,
          evidence: mixedPassive.length + ' resource(s), for example ' + mixedPassive[0].url,
          why: 'Visitors lose the HTTPS padlock guarantee, and the images could be replaced by someone on the network.',
          impact: 'Content could be swapped on the network; the page logic itself is not affected.',
          verify: 'Open DevTools → Network and filter for http:// requests.',
          fix: 'Change these addresses to https://.',
          details: mixedPassive.slice(0, 20).map((m) => m.type + ' ' + m.url).join('\n'),
          refs: [MDN + 'Security/Mixed_content'],
          effort: 'quick',
        })
      );
    }

    for (const form of forms) {
      if (form.hasPassword && form.insecureAction) {
        out.push(
          finding({
            id: 'password-form-http',
            owasp: 'A02',
            theme: 'transport',
            title: 'A password form submits over plain HTTP',
            severity: 'high',
            resource: form.action,
            evidence: 'Form action: ' + form.action,
            why: 'Passwords sent over HTTP can be read by anyone on the network.',
            impact: 'Credentials can be captured on the network.',
            verify: 'Inspect the form’s action attribute.',
            fix: 'Point the form at an https:// address.',
            effort: 'quick',
          })
        );
      }
      if (form.hasPassword && form.method === 'get') {
        out.push(
          finding({
            id: 'password-form-get',
            owasp: 'A04',
            theme: 'forms',
            title: 'A password form uses the GET method',
            severity: 'medium',
            resource: form.action,
            evidence: 'Form action ' + (form.action || '(this page)') + ' uses method GET.',
            why: 'With GET the password ends up in the web address, browser history and server logs.',
            impact: 'Passwords can be stored in logs and history and leak through the Referer header.',
            verify: 'Inspect the form’s method attribute.',
            fix: 'Use method="post".',
            effort: 'quick',
          })
        );
      }
      if (form.hasPassword && form.crossOrigin && !form.insecureAction) {
        out.push(
          finding({
            id: 'password-form-cross-origin',
            owasp: 'A07',
            theme: 'forms',
            title: 'A password form submits to a different site',
            severity: 'info',
            status: 'manual',
            confidence: 'medium',
            resource: form.action,
            evidence: 'Form action: ' + form.action,
            why: 'This is normal for single sign-on, but unexpected for a site that handles its own sign-in.',
            impact: 'If the destination is not trusted, credentials would be sent to a third party.',
            verify: 'Confirm that the destination is a service you intend to use.',
            fix: 'Make sure the destination is a trusted identity provider.',
          })
        );
      }
    }

    const postNoToken = forms.filter((f) => f.method === 'post' && !f.hasCsrfToken && !f.isSearch);
    if (postNoToken.length) {
      out.push(
        finding({
          id: 'csrf-token-missing',
          owasp: 'A01',
          theme: 'forms',
          title: 'POST forms without an anti-CSRF token field',
          severity: 'low',
          status: 'manual',
          confidence: 'low',
          resource: postNoToken[0].action,
          evidence: postNoToken.length + ' POST form(s) have no hidden field that looks like a CSRF token, for example the form posting to ' + (postNoToken[0].action || 'this page') + '.',
          why: 'Cross-site request forgery (CSRF) tricks a signed-in visitor’s browser into submitting a form. Sites defend with a token field, SameSite cookies or a custom header; this check can only see the token field.',
          impact: 'If no other defence exists, another website could make a signed-in visitor perform the form’s action.',
          verify: 'Check how the server protects state-changing requests (SameSite=Lax/Strict cookies, token headers, origin checks). With permission, replay the request from another origin in a test account.',
          fix: 'Add per-session CSRF tokens (or rely on SameSite cookies plus Origin checks) for every state-changing request.',
          refs: [OWASP_CS + 'Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html'],
        })
      );
    }
    const uploads = forms.filter((f) => f.hasFile);
    if (uploads.length) {
      out.push(
        finding({
          id: 'file-upload-form',
          owasp: 'A04',
          theme: 'forms',
          title: 'A file upload form is present',
          severity: 'info',
          status: 'manual',
          resource: uploads[0].action,
          evidence: uploads.length + ' form(s) accept file uploads.',
          why: 'Uploads are a common source of serious problems when the server does not check file type, size and storage location.',
          impact: 'Depends entirely on server-side checks, which DevForge cannot see.',
          verify: 'With permission, review server-side validation: allowed types, size limits, random file names, and that uploads are not served as executable content.',
          fix: 'Validate type and size on the server, store uploads outside the web root or on a separate domain, and serve them with nosniff.',
          refs: [OWASP_CS + 'File_Upload_Cheat_Sheet.html'],
        })
      );
    }

    const scripts = facts.scripts || [];
    const thirdPartyNoSri = scripts.filter((s) => s.thirdParty && !s.integrity);
    if (thirdPartyNoSri.length) {
      out.push(
        finding({
          id: 'sri-missing',
          owasp: 'A08',
          theme: 'third-party',
          title: 'Third-party scripts are loaded without Subresource Integrity',
          severity: 'low',
          resource: thirdPartyNoSri[0].src,
          evidence: thirdPartyNoSri.length + ' script(s) from other sites, for example ' + thirdPartyNoSri[0].src,
          why: 'If the other site is hacked, its script runs on your page with full access. An integrity hash makes the browser refuse a changed file.',
          impact: 'A compromised third-party host could run arbitrary script in your visitors’ browsers.',
          verify: 'View the page source and look for integrity="sha384-…" on <script> tags from CDNs.',
          fix: 'Add integrity and crossorigin="anonymous" to scripts served from a CDN, or host a copy yourself. Scripts that change without notice (analytics, tag managers) cannot use it.',
          details: thirdPartyNoSri.slice(0, 20).map((s) => s.src).join('\n'),
          refs: [MDN + 'Security/Subresource_Integrity'],
          effort: 'moderate',
        })
      );
    }
    const hosts = [...new Set(scripts.filter((s) => s.thirdParty).map((s) => s.host))];
    if (hosts.length >= 8) {
      out.push(
        finding({
          id: 'many-third-party',
          owasp: 'A08',
          theme: 'third-party',
          title: 'Scripts come from many different sites',
          severity: 'info',
          status: 'info',
          confidence: 'medium',
          evidence: hosts.length + ' hosts: ' + hosts.slice(0, 8).join(', ') + (hosts.length > 8 ? ', …' : ''),
          why: 'Every third-party script is code you do not control that runs with the same access as your own.',
          impact: 'Each additional host adds supply-chain exposure.',
          verify: 'Review the list and confirm each service is still needed.',
          fix: 'Remove services you no longer use and review the rest.',
        })
      );
    }

    const openFrames = (facts.iframes || []).filter((f) => f.thirdParty && !f.sandbox);
    if (openFrames.length) {
      out.push(
        finding({
          id: 'iframe-sandbox',
          owasp: 'A05',
          theme: 'third-party',
          title: 'Embedded third-party frames have no sandbox',
          severity: 'info',
          status: 'info',
          resource: openFrames[0].src,
          evidence: openFrames.length + ' frame(s), for example ' + openFrames[0].src,
          why: 'The sandbox attribute limits what an embedded page can do. Some widgets (payments, video) need extra permissions, so check each one.',
          impact: 'An embedded page can navigate the top window or open pop-ups unless restricted.',
          verify: 'Check what each embed needs.',
          fix: 'Add sandbox with only the permissions the embed needs.',
          example: '<iframe src="…" sandbox="allow-scripts allow-same-origin"></iframe>',
          refs: [MDN + 'HTML/Element/iframe#sandbox'],
        })
      );
    }

    if (facts.inlineHandlers > 0) {
      out.push(
        finding({
          id: 'inline-handlers',
          owasp: 'A05',
          theme: 'code',
          title: 'Inline event handlers prevent a strict policy',
          severity: 'info',
          status: 'info',
          evidence: facts.inlineHandlers + ' attribute(s) such as onclick="…".',
          why: 'A strict Content-Security-Policy has to block inline code, so these handlers would stop working once you add one.',
          impact: 'Makes adopting a strong CSP harder.',
          verify: 'Search the markup for on* attributes.',
          fix: 'Attach handlers with addEventListener in a script file.',
        })
      );
    }
    if (facts.javascriptUrls > 0) {
      out.push(
        finding({
          id: 'javascript-urls',
          owasp: 'A03',
          theme: 'code',
          title: 'Links or forms use javascript: addresses',
          severity: 'info',
          status: 'info',
          evidence: facts.javascriptUrls + ' element(s).',
          // eslint-disable-next-line no-script-url -- a label for the finding, not a URL that is used
          why: 'javascript: addresses are blocked by a strict Content-Security-Policy and are a common place for injected code.',
          impact: 'Makes adopting a strong CSP harder.',
          verify: 'Search the markup for href="javascript:…".',
          fix: 'Use a button with an event listener instead.',
        })
      );
    }
    if ((facts.sinks || []).length) {
      out.push(
        finding({
          id: 'dom-sinks',
          owasp: 'A03',
          theme: 'code',
          title: 'Inline scripts use risky DOM functions',
          severity: 'info',
          status: 'potential',
          confidence: 'low',
          evidence: facts.sinks.join(', '),
          why: 'Functions such as innerHTML are safe with trusted text but cause cross-site scripting when they receive user input. This only shows the names appear in the code, not that anything is exploitable.',
          impact: 'If any of these receive attacker-controlled data, script could run in visitors’ browsers (DOM-based XSS).',
          verify: 'Trace where the data passed to these functions comes from. Safe if it is constant or sanitised.',
          fix: 'Use textContent, or sanitise HTML before inserting it.',
          refs: [OWASP_CS + 'DOM_based_XSS_Prevention_Cheat_Sheet.html'],
        })
      );
    }

    // Parameters from the current address that appear in the page.
    for (const r of facts.reflected || []) {
      out.push(
        finding({
          id: 'param-reflection-' + r.name,
          owasp: 'A03',
          theme: 'code',
          title: 'A URL parameter is echoed back in the page',
          severity: r.context === 'attribute' ? 'low' : 'medium',
          status: 'potential',
          confidence: 'low',
          resource: pageUrl,
          evidence: 'The value of the "' + r.name + '" parameter appears in the page ' + (r.context === 'script' ? 'inside a script' : r.context === 'attribute-active' ? 'inside an event-handler or URL attribute' : 'inside an HTML attribute') + '. Values are not shown.',
          why: 'When a page repeats a parameter, the server or script must encode it correctly. Without encoding, the parameter becomes a way to inject script (reflected XSS). Echoing alone is normal and not a vulnerability.',
          impact: 'If the value is not encoded for its context, an attacker could craft a link that runs script in a visitor’s browser.',
          verify: 'With permission, change the parameter to a harmless marker such as devforge"test and see whether the page shows it escaped (&quot;) or breaks out of its context. DevForge does not send test payloads.',
          fix: 'Encode output for its context (HTML text, attribute, script, URL) with your framework’s escaping, and add a Content-Security-Policy.',
          refs: [OWASP_CS + 'Cross_Site_Scripting_Prevention_Cheat_Sheet.html'],
        })
      );
    }

    const links = facts.links || [];
    const redirectish = links.filter((l) => (l.params || []).some((p) => REDIRECT_PARAM.test(p.n) && p.k === 'url'));
    if (redirectish.length) {
      out.push(
        finding({
          id: 'open-redirect-indicator',
          owasp: 'A01',
          theme: 'code',
          title: 'Links pass a full web address in a redirect-style parameter',
          severity: 'low',
          status: 'manual',
          confidence: 'low',
          resource: redirectish[0].path,
          evidence: redirectish.length + ' link(s), for example ' + redirectish[0].path + ' with the parameter ' + redirectish[0].params.find((p) => REDIRECT_PARAM.test(p.n)).n + '. Values are not shown.',
          why: 'If the site follows such a parameter without checking it, attackers can build links on your domain that send visitors to a malicious site (open redirect), which makes phishing more convincing.',
          impact: 'Phishing and token theft through trusted-looking links, if the redirect is not restricted.',
          verify: 'With permission, change the parameter to an external address you control and see whether the site redirects without a warning or an allow-list check.',
          fix: 'Only redirect to relative paths or to addresses on an allow-list, and reject everything else.',
          refs: [OWASP_CS + 'Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html'],
        })
      );
    }
    const sensitiveUrl = links.flatMap((l) => (l.params || []).filter((p) => looksSecret(p.n) && p.k !== 'empty').map((p) => ({ path: l.path, name: p.n })));
    if (sensitiveUrl.length) {
      out.push(
        finding({
          id: 'sensitive-url-params',
          owasp: 'A02',
          theme: 'exposure',
          title: 'Links carry token-like values in the address',
          severity: 'medium',
          resource: sensitiveUrl[0].path,
          evidence: 'Parameter name(s): ' + [...new Set(sensitiveUrl.map((s) => s.name))].slice(0, 8).join(', ') + ' on ' + sensitiveUrl.length + ' link(s). Values are not shown.',
          why: 'Web addresses end up in browser history, server logs and Referer headers. Tokens placed in them leak to places that were never meant to see them.',
          impact: 'Anyone who can read logs, history or a referring request may reuse the token.',
          verify: 'Check whether these values are session or access tokens and whether they are single-use.',
          fix: 'Send tokens in headers or cookies instead of the address, or make them short-lived and single-use.',
          refs: [OWASP_CS + 'Session_Management_Cheat_Sheet.html'],
        })
      );
    }
    const idish = links.filter((l) => l.idPath || (l.params || []).some((p) => ID_PARAM.test(p.n) && p.k === 'number'));
    if (idish.length) {
      out.push(
        finding({
          id: 'idor-surface',
          owasp: 'A01',
          theme: 'access-control',
          title: 'Addresses use sequential-looking IDs (possible IDOR surface)',
          severity: 'info',
          status: 'manual',
          confidence: 'low',
          resource: idish[0].path,
          evidence: idish.length + ' link(s) contain numeric IDs, for example ' + idish[0].path + '. Values are not shown.',
          why: 'Insecure direct object references (IDOR) happen when changing an ID in the address shows another user’s data. Numeric IDs are only a hint: whether data is protected is decided on the server.',
          impact: 'If the server does not check ownership, other users’ records could be read or changed.',
          verify: 'Needs two accounts that you own. Sign in as user A, copy a record address, then open it as user B. DevForge never tests this, because it would involve other people’s data.',
          fix: 'Check authorisation on the server for every object access, and prefer unguessable identifiers in addition to (not instead of) access checks.',
          refs: [OWASP_CS + 'Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html'],
        })
      );
    }

    if ((facts.suspiciousComments || []).length) {
      out.push(
        finding({
          id: 'html-comments',
          owasp: 'A05',
          theme: 'disclosure',
          title: 'HTML comments mention sensitive-sounding words',
          severity: 'info',
          status: 'potential',
          confidence: 'low',
          evidence: facts.suspiciousComments.length + ' comment(s) contain: ' + [...new Set(facts.suspiciousComments)].join(', ') + '. Comment text is not shown.',
          why: 'Developers sometimes leave notes, internal paths or credentials in comments that every visitor can read.',
          impact: 'Can reveal internal details that help an attacker.',
          verify: 'View the page source and read the comments.',
          fix: 'Strip comments from production HTML.',
        })
      );
    }
    if (facts.generator && /\d+\.\d+/.test(facts.generator)) {
      out.push(
        finding({
          id: 'generator-version',
          owasp: 'A06',
          theme: 'disclosure',
          title: 'The page announces its generator and version',
          severity: 'info',
          status: 'info',
          evidence: 'meta generator: ' + facts.generator,
          why: 'Version numbers help attackers look up known weaknesses.',
          impact: 'Makes targeted attacks easier if the version is outdated.',
          verify: 'Check whether this version is current and still supported.',
          fix: 'Remove the generator tag and keep the software updated.',
        })
      );
    }

    for (const leak of Probe.findErrorLeaks(facts.html || '')) {
      out.push(
        finding({
          id: 'error-output-page',
          owasp: 'A05',
          theme: 'disclosure',
          title: 'The page contains ' + leak.label,
          severity: 'medium',
          status: 'confirmed',
          confidence: 'medium',
          resource: pageUrl,
          evidence: 'The page text matches the pattern for ' + leak.label + '. The text is not shown.',
          why: 'Error output and debug pages reveal internal paths, library versions and sometimes data.',
          impact: 'Gives an attacker details about the technology and structure of the application.',
          verify: 'View the page source and read the matching text.',
          fix: 'Turn off debug mode in production and show a generic error page.',
          refs: [OWASP_CS + 'Error_Handling_Cheat_Sheet.html'],
        })
      );
      break;
    }

    return out;
  }

  /* ---------- cookies ---------- */

  /*
   * cookies: [{ name, secure, httpOnly, sameSite, session, days, hostOnly }]
   * `exact` is true when the list came from chrome.cookies (all flags known) and false when it came
   * from cookieStore (script-visible cookies only; httpOnly cookies are absent by definition).
   */
  function analyzeCookies(cookies, { https = false, exact = false } = {}) {
    const out = [];
    const list = cookies || [];
    const sessionish = list.filter((c) => looksSecret(c.name));
    const names = (arr) => evidenceList(arr.map((c) => c.name), 8);
    const base = { owasp: 'A07', theme: 'cookies', refs: [MDN + 'Web/HTTP/Cookies#restrict_access_to_cookies'] };

    if (exact) {
      const noHttpOnly = sessionish.filter((c) => c.httpOnly === false);
      if (noHttpOnly.length) {
        out.push(
          finding({
            ...base,
            id: 'cookie-httponly-missing',
            title: 'Session-like cookies are readable by scripts (no HttpOnly)',
            severity: 'medium',
            status: 'confirmed',
            confidence: 'medium',
            evidence: 'Cookie name(s): ' + names(noHttpOnly) + '. The HttpOnly flag is off. Values are not read.',
            why: 'Cookies without HttpOnly can be stolen by any script that runs on the page, for example through an XSS bug. The cookie names suggest these hold a session or token (a guess from the names).',
            impact: 'A cross-site scripting bug could be used to steal the session and take over the account.',
            verify: 'DevTools → Application → Cookies: the HttpOnly column shows the flag. Confirm which cookie is the real session cookie.',
            fix: 'Set the HttpOnly flag on cookies that only the server needs.',
            example: 'Set-Cookie: session=…; HttpOnly; Secure; SameSite=Lax',
            effort: 'quick',
          })
        );
      }
      const samesiteNone = sessionish.filter((c) => c.sameSite === 'no_restriction');
      if (samesiteNone.length) {
        out.push(
          finding({
            ...base,
            owasp: 'A01',
            id: 'cookie-samesite-none',
            title: 'Session-like cookies are sent on cross-site requests (SameSite=None)',
            severity: 'low',
            status: 'potential',
            confidence: 'medium',
            evidence: 'Cookie name(s): ' + names(samesiteNone) + '.',
            why: 'SameSite=None is needed for some embeds and single sign-on, but it removes the browser’s built-in protection against cross-site request forgery.',
            impact: 'Cross-site request forgery protections have to come from tokens instead.',
            verify: 'Check whether the cookie really has to be sent in cross-site contexts.',
            fix: 'Use SameSite=Lax (or Strict) unless cross-site use is required.',
          })
        );
      }
      const longLived = sessionish.filter((c) => !c.session && typeof c.days === 'number' && c.days > 30);
      if (longLived.length) {
        out.push(
          finding({
            ...base,
            id: 'cookie-long-lived',
            title: 'Session-like cookies live for a long time',
            severity: 'low',
            status: 'potential',
            confidence: 'low',
            evidence: 'Cookie name(s): ' + names(longLived) + ' (more than 30 days).',
            why: 'Long-lived session cookies stay valid if a device is lost or a token is stolen.',
            impact: 'A stolen cookie stays usable for a long time.',
            verify: 'Check whether this is a "remember me" cookie, which is expected to last.',
            fix: 'Use short sessions with sliding expiry for the main session and keep "remember me" tokens separate and revocable.',
          })
        );
      }
      const broad = sessionish.filter((c) => c.hostOnly === false);
      if (broad.length) {
        out.push(
          finding({
            ...base,
            id: 'cookie-broad-domain',
            title: 'Session-like cookies are shared with all subdomains',
            severity: 'low',
            status: 'potential',
            confidence: 'low',
            evidence: 'Cookie name(s): ' + names(broad) + ' (a Domain attribute is set).',
            why: 'A cookie with a Domain attribute is sent to every subdomain, so a weaker or compromised subdomain can read or overwrite it.',
            impact: 'A vulnerable subdomain could be used to attack sessions on the main site.',
            verify: 'Check whether the cookie really has to be shared across subdomains.',
            fix: 'Omit the Domain attribute so the cookie is limited to the exact host, or use the __Host- prefix.',
          })
        );
      }
    } else if (sessionish.length) {
      out.push(
        finding({
          ...base,
          id: 'cookie-script-readable',
          title: 'Session-like cookies can be read by scripts',
          severity: 'medium',
          status: 'potential',
          confidence: 'medium',
          evidence: 'Cookie name(s): ' + names(sessionish) + '. Values are not shown.',
          why: 'Cookies without the HttpOnly flag can be stolen by any script that runs on the page, for example through an XSS bug. The names suggest these hold a session or token.',
          impact: 'A cross-site scripting bug could be used to steal the session.',
          verify: 'Scripts can only see cookies that are not HttpOnly, so being listed here is itself the evidence. The "session-like" label is a guess from the name.',
          fix: 'Set the HttpOnly flag on cookies that only the server needs.',
          example: 'Set-Cookie: session=…; HttpOnly; Secure; SameSite=Lax',
          effort: 'quick',
        })
      );
    }
    const noSecure = list.filter((c) => https && c.secure === false);
    if (noSecure.length) {
      out.push(
        finding({
          ...base,
          owasp: 'A02',
          id: 'cookie-no-secure',
          title: 'Cookies are missing the Secure flag',
          severity: sessionish.some((c) => c.secure === false) ? 'medium' : 'low',
          status: 'confirmed',
          evidence: 'Cookie name(s): ' + names(noSecure),
          why: 'Without Secure, the browser can also send the cookie over plain HTTP, where it can be read.',
          impact: 'A cookie sent over an unencrypted connection can be captured on the network.',
          verify: 'DevTools → Application → Cookies: the Secure column shows the flag.',
          fix: 'Add the Secure flag when setting the cookie.',
          effort: 'quick',
        })
      );
    }
    return out;
  }

  /* Names of web-storage keys that look like credentials. Values are never read. */
  function analyzeStorage(facts) {
    const hits = [
      ...(facts.localKeys || []).filter(looksSecret).map((k) => 'localStorage.' + k),
      ...(facts.sessionKeys || []).filter(looksSecret).map((k) => 'sessionStorage.' + k),
    ];
    if (!hits.length) return [];
    return [
      finding({
        id: 'storage-token',
        owasp: 'A02',
        theme: 'cookies',
        title: 'Tokens or credentials may be kept in web storage',
        severity: 'low',
        status: 'potential',
        confidence: 'low',
        evidence: 'Key name(s): ' + evidenceList(hits, 10) + '. Values are not shown.',
        why: 'Anything in localStorage or sessionStorage can be read by every script on the page, so an XSS bug exposes it. HttpOnly cookies are safer for session tokens.',
        impact: 'A cross-site scripting bug could be used to steal these tokens.',
        verify: 'Check what the values are (without copying them) and how long they stay valid.',
        fix: 'Keep session tokens in HttpOnly, Secure cookies where you can; otherwise keep their lifetime short.',
        refs: [OWASP_CS + 'HTML5_Security_Cheat_Sheet.html#local-storage'],
      }),
    ];
  }

  /* ---------- observed traffic (Network tab capture) ---------- */

  const plain = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname;
    } catch (_) {
      return String(u).split(/[?#]/)[0];
    }
  };
  const lineOf = (e) => (e.method || 'GET') + ' ' + plain(e.url) + (e.status ? ' (' + e.status + ')' : '');

  /*
   * entries: summary rows from the Network capture ({kind, method, url, status, reqHeaders,
   * resHeaders}). Header values and bodies are never copied into evidence.
   */
  function analyzeTraffic(entries, { pageUrl = '' } = {}) {
    const out = [];
    const list = (entries || []).filter((e) => e && e.url);
    let pageOrigin = '';
    try {
      pageOrigin = new URL(pageUrl).origin;
    } catch (_) {
      /* no page address: cross-origin checks are skipped */
    }
    const pageHttps = /^https:/i.test(pageUrl);
    const base = { theme: 'traffic', owasp: 'A02' };

    const insecure = list.filter((e) => pageHttps && /^(http|ws):/i.test(e.url) && !Safe.isPrivateHost(safeHost(e.url)));
    if (insecure.length) {
      out.push(
        finding({
          ...base,
          id: 'traffic-insecure-requests',
          title: 'Requests were sent without encryption from an HTTPS page',
          severity: insecure.some((e) => /^ws:/i.test(e.url) || e.method !== 'GET') ? 'high' : 'medium',
          resource: plain(insecure[0].url),
          evidence: insecure.length + ' captured request(s): ' + evidenceList(insecure.map(lineOf), 4),
          why: 'The page made network calls over http:// or ws://. Anyone on the network can read or alter them.',
          impact: 'Data in those requests and responses can be read or modified in transit.',
          verify: 'Open the Network tab and filter for the listed addresses.',
          fix: 'Use https:// and wss:// for every request.',
          effort: 'quick',
        })
      );
    }
    const authOverHttp = list.filter((e) => /^http:/i.test(e.url) && e.reqHeaders && Object.keys(e.reqHeaders).some((k) => /^(authorization|x-api-key|x-auth-token)$/i.test(k)) && !Safe.isPrivateHost(safeHost(e.url)));
    if (authOverHttp.length) {
      out.push(
        finding({
          ...base,
          id: 'traffic-credentials-over-http',
          title: 'Credentials were sent in a request header over plain HTTP',
          severity: 'high',
          resource: plain(authOverHttp[0].url),
          evidence: authOverHttp.length + ' captured request(s) carried an authorization-style header over http://: ' + evidenceList(authOverHttp.map(lineOf), 3) + '. Header values are not shown.',
          why: 'Authorization headers sent over HTTP can be read by anyone on the network path.',
          impact: 'Tokens and API keys can be captured and reused.',
          verify: 'Open the Network tab, select the request and look at the request headers (do not copy the values).',
          fix: 'Serve the API over HTTPS only and redirect HTTP.',
          effort: 'quick',
        })
      );
    }
    const sensitive = [];
    for (const e of list) {
      let params;
      try {
        params = [...new URL(e.url).searchParams];
      } catch (_) {
        continue;
      }
      const names = params.filter(([k, v]) => v && looksSecret(k)).map(([k]) => k);
      if (names.length) sensitive.push({ e, names });
    }
    if (sensitive.length) {
      out.push(
        finding({
          ...base,
          id: 'traffic-sensitive-url',
          title: 'Requests carry token-like values in the address',
          severity: 'medium',
          resource: plain(sensitive[0].e.url),
          evidence: sensitive.length + ' captured request(s), for example ' + lineOf(sensitive[0].e) + ' with the parameter ' + sensitive[0].names[0] + '. Values are not shown.',
          why: 'Web addresses are stored in logs and history and sent in Referer headers. Tokens placed in them leak.',
          impact: 'Anyone who can read logs, history or a referring request may reuse the token.',
          verify: 'Open the Network tab and look at the request address (redaction is on by default).',
          fix: 'Send tokens in headers or the request body instead of the address.',
        })
      );
    }
    const withCreds = list.filter((e) => {
      try {
        const u = new URL(e.url);
        return u.username || u.password;
      } catch (_) {
        return false;
      }
    });
    if (withCreds.length) {
      out.push(
        finding({
          ...base,
          id: 'traffic-url-credentials',
          title: 'A request address contains a username or password',
          severity: 'high',
          resource: plain(withCreds[0].url),
          evidence: withCreds.length + ' captured request(s) include credentials in the address. Values are not shown.',
          why: 'Credentials in addresses end up in logs and history.',
          impact: 'The credentials can be read by anyone who sees the address.',
          verify: 'Open the Network tab and look at the address.',
          fix: 'Use an Authorization header or a session instead of credentials in the address.',
        })
      );
    }
    // CORS seen on real responses.
    const cors = list.filter((e) => e.resHeaders && lowerKeys(e.resHeaders)['access-control-allow-origin'] === '*' && /json|api|graphql/i.test(e.url + ' ' + (lowerKeys(e.resHeaders)['content-type'] || '')));
    if (cors.length) {
      out.push(
        finding({
          ...base,
          owasp: 'A05',
          theme: 'cors',
          id: 'traffic-cors-open',
          title: 'API responses allow any origin to read them',
          severity: 'info',
          status: 'manual',
          confidence: 'medium',
          resource: plain(cors[0].url),
          evidence: cors.length + ' captured response(s) had Access-Control-Allow-Origin: *, for example ' + lineOf(cors[0]) + '.',
          why: 'A wildcard is fine for public data. It is a problem if the endpoint returns anything user-specific and the server also accepts credentials from other origins.',
          impact: 'Other websites can read these responses from a visitor’s browser if no credentials are needed.',
          verify: 'Check whether each listed endpoint returns only public data.',
          fix: 'Restrict Access-Control-Allow-Origin to the origins that need it.',
          refs: [MDN + 'HTTP/CORS'],
        })
      );
    }
    const reflective = list.filter((e) => {
      const h = lowerKeys(e.resHeaders || {});
      let o;
      try {
        o = new URL(e.url).origin;
      } catch (_) {
        return false;
      }
      return o !== pageOrigin && h['access-control-allow-origin'] === pageOrigin && String(h['access-control-allow-credentials']).toLowerCase() === 'true';
    });
    if (reflective.length) {
      out.push(
        finding({
          ...base,
          owasp: 'A05',
          theme: 'cors',
          id: 'traffic-cors-credentials',
          title: 'A cross-origin API allows this page’s origin with credentials',
          severity: 'info',
          status: 'manual',
          confidence: 'low',
          resource: plain(reflective[0].url),
          evidence: reflective.length + ' captured response(s) allow the page origin with credentials, for example ' + lineOf(reflective[0]) + '.',
          why: 'This is how authenticated cross-origin APIs normally work. It becomes a problem if the server reflects any origin it receives.',
          impact: 'If the origin is reflected rather than allow-listed, other websites could read signed-in responses.',
          verify: 'With permission, send a request with a different Origin header (curl) and see whether it is reflected too. DevForge cannot set that header.',
          fix: 'Allow-list origins on the server instead of echoing the request’s Origin.',
          refs: [MDN + 'HTTP/CORS'],
        })
      );
    }
    const errors = list.filter((e) => e.status >= 500);
    if (errors.length) {
      out.push(
        finding({
          ...base,
          owasp: 'A05',
          theme: 'disclosure',
          id: 'traffic-server-errors',
          title: 'Server errors were observed',
          severity: 'info',
          status: 'info',
          resource: plain(errors[0].url),
          evidence: errors.length + ' captured response(s) with a 5xx status: ' + evidenceList(errors.map(lineOf), 4),
          why: 'Server errors can expose stack traces or indicate input handling problems worth investigating.',
          impact: 'Error pages sometimes reveal internals; repeated errors can point at unhandled input.',
          verify: 'Open the responses in the Network tab and read the bodies for stack traces.',
          fix: 'Fix the cause and make sure production error pages are generic.',
        })
      );
    }
    return out;
  }
  const safeHost = (url) => {
    try {
      return new URL(url).hostname;
    } catch (_) {
      return '';
    }
  };

  /* ---------- active and content checks ---------- */

  /*
   * results: [{ probe: <probe id>, path, res }] where res is {status, type, text, redirected}.
   * The raw text is only inspected here; findings carry the probe's fixed evidence sentence.
   */
  function analyzeProbes(results, baseline) {
    const out = [];
    for (const r of results || []) {
      const probe = Probe.PROBES.find((p) => p.id === r.probe);
      if (!probe) continue;
      const evidence = Probe.runProbe(probe, r.res, { baseline });
      if (!evidence) continue;
      out.push(
        finding({
          id: 'exposed-' + probe.id,
          owasp: probe.category,
          theme: probe.theme,
          title: probe.title,
          severity: probe.severity,
          status: probe.severity === 'info' ? 'info' : 'confirmed',
          confidence: ['admin-login', 'werkzeug-console', 'laravel-ignition'].includes(probe.id) ? 'medium' : 'high',
          resource: r.path,
          evidence: evidence + ' (HTTP ' + r.res.status + ', ' + String(r.res.type || 'unknown type').split(';')[0] + ')',
          why: probe.why,
          impact: probe.impact,
          verify: probe.verify,
          fix: probe.fix,
          example: probe.example,
          effort: 'quick',
        })
      );
    }
    return out;
  }

  /* Error output on the "this path cannot exist" request. */
  function analyzeBaseline(res, path) {
    if (!res || typeof res.text !== 'string') return [];
    const leaks = Probe.findErrorLeaks(res.text);
    if (!leaks.length) return [];
    return [
      finding({
        id: 'error-output-404',
        owasp: 'A05',
        theme: 'disclosure',
        title: 'Error pages reveal ' + leaks[0].label,
        severity: 'medium',
        confidence: 'medium',
        resource: path,
        evidence: 'A request for a path that does not exist returned ' + leaks[0].label + ' (HTTP ' + res.status + '). The text is not shown.',
        why: 'Error pages that show stack traces, file paths or database messages give attackers details about the technology and structure of the application.',
        impact: 'Helps an attacker choose attacks and may reveal internal paths or queries.',
        verify: 'Request a path that does not exist (for example /does-not-exist-123) and read the page.',
        fix: 'Turn off debug mode in production and return a generic error page.',
        refs: [OWASP_CS + 'Error_Handling_Cheat_Sheet.html'],
      }),
    ];
  }

  function analyzeRobots(result) {
    if (!result || !result.found) return [];
    const r = Probe.parseRobots(result.text);
    if (!r.interesting.length) return [];
    return [
      finding({
        id: 'robots-interesting',
        owasp: 'A05',
        theme: 'disclosure',
        title: 'robots.txt lists paths that sound sensitive',
        severity: 'info',
        status: 'info',
        resource: '/robots.txt',
        evidence: 'Disallowed path(s): ' + evidenceList(r.interesting, 8) + '.',
        why: 'robots.txt asks search engines to stay away, but it is public. Listing a sensitive path there announces that it exists.',
        impact: 'Points people to areas that need real access control, not just a request to crawlers.',
        verify: 'Check that each listed path is protected by authentication and not just hidden.',
        fix: 'Protect sensitive paths with authentication; do not rely on robots.txt for secrecy.',
      }),
    ];
  }

  function parseSecurityTxt(text) {
    const fields = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z-]+)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      (fields[key] = fields[key] || []).push(m[2]);
    }
    return fields;
  }

  function analyzeSecurityTxt(result) {
    if (!result || result.status === 'skipped') return [];
    const base = { owasp: 'A04', theme: 'disclosure', resource: '/.well-known/security.txt', refs: ['https://www.rfc-editor.org/rfc/rfc9116'] };
    if (!result.found) {
      return [
        finding({
          ...base,
          id: 'security-txt-missing',
          title: 'No security.txt file',
          severity: 'info',
          status: 'info',
          evidence: '/.well-known/security.txt ' + (result.status ? 'returned HTTP ' + result.status : 'could not be read') + '.',
          why: 'A security.txt file tells researchers where to send a vulnerability report. Without it, people who find a problem may not know whom to contact.',
          impact: 'Reports may go unreported or reach the wrong person.',
          verify: 'Open /.well-known/security.txt in a browser.',
          fix: 'Publish /.well-known/security.txt with a Contact line and an Expires date (securitytxt.org can generate one).',
          example: 'Contact: mailto:security@example.com\nExpires: 2027-01-01T00:00:00Z\nPreferred-Languages: en',
          effort: 'quick',
        }),
      ];
    }
    const f = parseSecurityTxt(result.text);
    const out = [];
    if (!f.contact) {
      out.push(
        finding({
          ...base,
          id: 'security-txt-no-contact',
          title: 'security.txt has no Contact field',
          severity: 'low',
          evidence: 'The file was found but contains no Contact: line.',
          why: 'Contact is the one field RFC 9116 requires, so reporters cannot reach you from this file.',
          impact: 'Reporters cannot reach you from this file.',
          verify: 'Read the file.',
          fix: 'Add a line such as Contact: mailto:security@example.com.',
          effort: 'quick',
        })
      );
    }
    const expires = f.expires && Date.parse(f.expires[0]);
    if (!f.expires) {
      out.push(
        finding({
          ...base,
          id: 'security-txt-no-expires',
          title: 'security.txt has no Expires field',
          severity: 'low',
          evidence: 'The file was found but contains no Expires: line.',
          why: 'Expires is required so readers know whether the contact details are still maintained.',
          impact: 'Readers cannot tell whether the contact is still valid.',
          verify: 'Read the file.',
          fix: 'Add Expires: with a date less than a year ahead.',
          effort: 'quick',
        })
      );
    } else if (!Number.isNaN(expires) && expires < Date.now()) {
      out.push(
        finding({
          ...base,
          id: 'security-txt-expired',
          title: 'security.txt has expired',
          severity: 'low',
          evidence: 'Expires: ' + f.expires[0],
          why: 'An expired file signals that the contact details may be out of date.',
          impact: 'Reporters may not trust or use the contact.',
          verify: 'Read the Expires line.',
          fix: 'Check the contact details and set a new Expires date.',
          effort: 'quick',
        })
      );
    }
    return out;
  }

  /*
   * scripts: { items: [{ url, text, map: {url, status, exposed} }], inline: [{ label, text }],
   *            urls: [every script address on the page] }
   * Script text is scanned and then dropped; findings carry masked values only.
   */
  function analyzeScripts(scripts) {
    const out = [];
    if (!scripts) return out;
    const hits = [];
    for (const s of scripts.items || []) hits.push(...Probe.scanSecrets(s.text, plain(s.url)));
    for (const s of scripts.inline || []) hits.push(...Probe.scanSecrets(s.text, s.label));

    const byType = new Map();
    for (const hit of hits) {
      const key = hit.type;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(hit);
    }
    for (const [type, group] of byType) {
      const first = group[0];
      const severity = group.some((g) => g.severity === 'high') ? 'high' : group.some((g) => g.severity === 'medium') ? 'medium' : 'low';
      out.push(
        finding({
          id: 'secret-' + type,
          owasp: 'A02',
          theme: 'exposure',
          title: 'Possible ' + first.label + ' in browser-accessible code',
          severity,
          status: 'potential',
          confidence: group.some((g) => g.confidence === 'high') ? 'high' : first.confidence,
          resource: first.where,
          evidence: group.length + ' match(es): ' + evidenceList(group.map((g) => (g.name ? g.name + ' ' : '') + g.masked + ' in ' + g.where), 4) + '. Full values are not shown or kept.',
          why: 'Everything delivered to the browser is visible to every visitor. Credentials that belong on the server are not protected there. ' + (first.note || ''),
          impact: 'If the value is live and privileged, someone could use it to access the service it belongs to. DevForge does not test whether a credential works.',
          verify: 'Open the file, locate the value and identify what it is for. Public identifiers meant for browsers (for example restricted keys) are fine; private keys and passwords are not. Check with the provider whether the key is active.',
          fix: 'If it is a private credential: revoke it, create a new one, keep it on the server and use a backend endpoint instead.',
          refs: [OWASP_CS + 'Secrets_Management_Cheat_Sheet.html'],
        })
      );
    }

    const maps = (scripts.items || []).filter((s) => s.map && s.map.exposed);
    if (maps.length) {
      out.push(
        finding({
          id: 'sourcemap-exposed',
          owasp: 'A05',
          theme: 'exposure',
          title: 'Source maps are publicly readable',
          severity: 'low',
          confidence: 'high',
          resource: plain(maps[0].map.url),
          evidence: maps.length + ' source map(s) returned HTTP 200, for example ' + plain(maps[0].map.url) + '. Only the first bytes were read.',
          why: 'Source maps let anyone rebuild the original, readable source code from the minified files, including comments and internal names.',
          impact: 'Makes it easier to find bugs, hidden endpoints and secrets in the original code.',
          verify: 'Open one map address in a browser and look at the "sources" list.',
          fix: 'Do not deploy .map files to production, or serve them only to authenticated developers.',
          example: 'webpack:  devtool: false   (or "hidden-source-map" and upload maps to your error tracker only)',
          effort: 'quick',
        })
      );
    }

    for (const lib of Probe.detectLibraries(scripts.urls || [])) {
      out.push(
        finding({
          id: 'vulnerable-library-' + lib.name.toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + lib.version,
          owasp: 'A06',
          theme: 'dependencies',
          title: lib.name + ' ' + lib.version + ' has known security advisories',
          severity: lib.severity,
          status: 'potential',
          confidence: 'low',
          resource: lib.url,
          evidence: 'The file name or path suggests ' + lib.name + ' ' + lib.version + '. ' + lib.advisories.join(' '),
          why: 'Old library versions have publicly documented weaknesses. The version here is read from the file name, so it can be wrong (files can be patched or renamed).',
          impact: 'If the version is real and the vulnerable feature is used, attackers can use public exploits against the page.',
          verify: 'Open the file and check the version comment at the top, or run the library’s version check in the console. Then check whether your code uses the affected feature.',
          fix: 'Update to a supported release and remove unused libraries.',
          effort: 'moderate',
        })
      );
    }
    for (const risky of Probe.riskyHosts(scripts.urls || [])) {
      out.push(
        finding({
          id: 'risky-host-' + risky.host.replace(/[^a-z0-9]+/gi, '-'),
          owasp: 'A08',
          theme: 'third-party',
          title: 'A script is loaded from ' + risky.host,
          severity: risky.severity,
          status: 'potential',
          confidence: 'medium',
          resource: risky.host,
          evidence: 'At least one script on the page is served from ' + risky.host + '.',
          why: risky.text,
          impact: 'The host could deliver malicious code to every visitor.',
          verify: 'Search the page source for the host name.',
          fix: 'Remove the script or replace it with a self-hosted copy or a trusted mirror.',
          effort: 'quick',
        })
      );
    }
    return out;
  }

  return {
    SEVERITIES,
    STATUSES,
    RANK,
    OWASP,
    LEVELS,
    HARD_MAX_REQUESTS,
    HARD_MIN_DELAY_MS,
    finding,
    scanBudget,
    planScan,
    SCRIPT_LIMIT,
    classifyTarget,
    isLocalHost,
    parseCsp,
    analyzeCsp,
    analyzeHeaders,
    analyzeFacts,
    analyzeCookies,
    analyzeStorage,
    analyzeTraffic,
    analyzeProbes,
    analyzeBaseline,
    analyzeRobots,
    parseSecurityTxt,
    analyzeSecurityTxt,
    analyzeScripts,
  };
})();
if (typeof module !== 'undefined') module.exports = DFSecScan;
