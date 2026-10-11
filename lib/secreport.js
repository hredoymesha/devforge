/*
 * Report assembly for the Security tab: findings from lib/secscan.js are de-duplicated, linked into
 * potential attack paths, turned into a prioritised remediation plan and rendered as Markdown or a
 * disclosure message. Pure functions, testable in Node. Nothing here touches the network.
 *
 * Honesty rules baked in:
 *  - Attack paths are always "potential": they describe what could follow if unverified conditions
 *    hold, and every path lists those conditions.
 *  - Coverage says what was checked, skipped, failed and cannot be tested from a browser extension.
 *  - There is deliberately no numeric score or grade.
 *  - Every string leaving buildReport passes through `scrub`, a last line of defence against a
 *    credential-shaped value slipping into evidence.
 */
const DFSecReport = (() => {
  const Scan = typeof DFSecScan !== 'undefined' ? DFSecScan : require('./secscan.js');
  const Probe = typeof DFSecProbe !== 'undefined' ? DFSecProbe : require('./secprobe.js');
  const { SEVERITIES } = Scan;

  const SEV_RANK = { high: 0, medium: 1, low: 2, info: 3 };
  const STATUS_RANK = { confirmed: 0, potential: 1, manual: 2, info: 3 };
  const CONF_RANK = { high: 0, medium: 1, low: 2 };
  const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
  const STATUS_LABEL = { confirmed: 'Confirmed', potential: 'Potential', manual: 'Needs manual verification', info: 'Informational' };
  const STATUS_HELP = {
    confirmed: 'The condition was directly observed (for example a header is missing or a file is readable). It does not mean the weakness can be exploited.',
    potential: 'A pattern points at a possible problem. The conditions needed for it to matter have not been verified.',
    manual: 'This cannot be judged from the browser. A person has to check it; the finding says how.',
    info: 'Good to know, but not a weakness by itself.',
  };

  /* ---------- secret scrubbing ---------- */

  const SCRUB = [
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    /\bsk_live_[0-9a-zA-Z]{20,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  ];
  const scrub = (s) => SCRUB.reduce((t, re) => t.replace(re, (m) => (/^(Bearer|Basic)/.test(m) ? m.split(/\s/)[0] + ' [redacted]' : '[redacted]')), String(s));
  function scrubDeep(v) {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(scrubDeep);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
    return v;
  }

  /* ---------- attack paths ---------- */

  const idIs = (...ids) => (f) => ids.includes(f.id);
  const idStarts = (...prefixes) => (f) => prefixes.some((p) => f.id.startsWith(p));
  const anyOf = (...fns) => (f) => fns.some((fn) => fn(f));

  const GROUPS = {
    weakCsp: idIs('csp-missing', 'csp-no-script-src', 'csp-unsafe-inline', 'csp-broad-source'),
    injectionHint: anyOf(
      idIs('dom-sinks'),
      idStarts('param-reflection-'),
      idStarts('vulnerable-library-jquery', 'vulnerable-library-bootstrap', 'vulnerable-library-angularjs')
    ),
    sessionReadable: idIs('cookie-script-readable', 'cookie-httponly-missing', 'storage-token'),
    weakTransport: anyOf(
      (f) => f.id === 'no-https' && f.status !== 'info',
      idIs('hsts-missing', 'mixed-active', 'traffic-insecure-requests')
    ),
    cookieOverHttp: idIs('cookie-no-secure', 'password-form-http', 'traffic-credentials-over-http'),
    sourceExposed: anyOf(
      idIs('sourcemap-exposed', 'exposed-git-head', 'exposed-git-config', 'exposed-svn-entries', 'exposed-hg-hgrc', 'exposed-dir-git'),
      idStarts('exposed-zip-')
    ),
    secretFound: anyOf(
      idStarts('secret-'),
      idIs('exposed-env-file', 'exposed-env-local', 'exposed-env-production', 'exposed-env-backup', 'exposed-npmrc', 'exposed-private-key'),
      idStarts('exposed-wp-config', 'exposed-config-bak', 'exposed-sql-')
    ),
    supplyChain: anyOf(idIs('sri-missing'), idStarts('risky-host-')),
    adminExposed: idIs('exposed-phpmyadmin', 'exposed-adminer', 'exposed-wp-login', 'exposed-admin-login', 'exposed-tomcat-manager'),
    weakSession: anyOf(idIs('cookie-no-secure', 'cookie-httponly-missing', 'cookie-script-readable', 'cookie-samesite-none'), (f) => f.id === 'hsts-missing'),
    framing: idIs('clickjacking'),
    stateForms: idIs('csrf-token-missing'),
  };

  const PATHS = [
    {
      id: 'xss-session-takeover',
      title: 'Injected script could take over a signed-in session',
      needs: ['weakCsp', 'injectionHint', 'sessionReadable'],
      summary: 'A script-injection flaw, if one exists, would run without a policy to contain it and could read the session credentials that scripts can access.',
      steps: [
        'An attacker finds an input that reaches a risky DOM function, an unencoded reflection, or a vulnerable library feature.',
        'The page has no effective Content-Security-Policy, so the injected script runs.',
        'The script reads a session cookie or stored token that is not protected from scripts.',
        'The attacker uses the token to act as the visitor.',
      ],
      conditions: [
        'Attacker-controlled data actually reaches the risky function, reflection or library feature.',
        'The named cookie or storage key really is the session credential.',
      ],
      impact: 'Account takeover of visitors who open an attacker-crafted link or view attacker-supplied content.',
      breaks: ['Encode output and avoid risky DOM functions', 'Add an enforced Content-Security-Policy', 'Set HttpOnly on session cookies / avoid storing tokens in web storage'],
    },
    {
      id: 'xss-unrestricted',
      title: 'A script-injection flaw would not be contained',
      needs: ['weakCsp', 'injectionHint'],
      unless: ['xss-session-takeover'],
      summary: 'Indicators of risky code exist and nothing limits what injected script could do.',
      steps: [
        'An attacker finds an input that reaches a risky DOM function, an unencoded reflection, or a vulnerable library feature.',
        'The page has no effective Content-Security-Policy, so the injected script runs with full access to the page.',
      ],
      conditions: ['Attacker-controlled data actually reaches the risky function, reflection or library feature.'],
      impact: 'Script running in the visitor’s browser on this site: page content, forms and anything stored for scripts is in reach.',
      breaks: ['Encode output and avoid risky DOM functions', 'Add an enforced Content-Security-Policy', 'Update vulnerable libraries'],
    },
    {
      id: 'network-interception',
      title: 'Credentials could be intercepted on the network',
      needs: ['weakTransport', 'cookieOverHttp'],
      summary: 'Part of the traffic is not protected by HTTPS, and sensitive values travel in it.',
      steps: [
        'A visitor connects from a hostile network (public Wi-Fi).',
        'The connection starts, or part of it runs, over plain HTTP.',
        'The attacker reads the password, cookie or token and reuses it.',
      ],
      conditions: ['The unencrypted request is actually reachable by visitors (not only in development).', 'The listed cookie or credential is a real secret.'],
      impact: 'Session hijacking or stolen passwords for visitors on the same network.',
      breaks: ['Serve everything over HTTPS and redirect HTTP', 'Send HSTS', 'Mark cookies Secure'],
    },
    {
      id: 'source-to-credentials',
      title: 'Exposed source could lead to working credentials',
      needs: ['sourceExposed', 'secretFound'],
      summary: 'Readable source or build files, combined with credential-like values, could give an attacker access to backend services.',
      steps: [
        'The attacker downloads the exposed source, repository data or configuration.',
        'They search it for credentials, API keys and internal addresses.',
        'If a credential is still valid, they use it against the service it belongs to.',
      ],
      conditions: ['The credential-like value is real and still active (DevForge never tests this).'],
      impact: 'Access to databases, cloud accounts or third-party services, depending on what the credential unlocks.',
      breaks: ['Remove source maps, repository data and configuration files from the web root', 'Rotate every exposed credential', 'Keep secrets on the server'],
    },
    {
      id: 'supply-chain-takeover',
      title: 'A compromised third-party script could control the page',
      needs: ['supplyChain', 'weakCsp'],
      summary: 'Third-party code runs with full page access and nothing limits or verifies it.',
      steps: [
        'A third-party host that the page loads script from is compromised, or changes hands.',
        'The script is served modified. No integrity hash or policy stops it.',
        'The modified script runs in every visitor’s browser.',
      ],
      conditions: ['The third party is actually compromised: this path is a risk, not an incident.'],
      impact: 'Skimming of form data, session theft and redirects for all visitors, at once.',
      breaks: ['Add Subresource Integrity or self-host scripts', 'Remove unused or risky hosts', 'Add a Content-Security-Policy that lists allowed script hosts'],
    },
    {
      id: 'clickjacking-action',
      title: 'A visitor could be tricked into submitting a form',
      needs: ['framing', 'stateForms'],
      summary: 'The page can be embedded by other sites and has forms that change data without an obvious anti-forgery token.',
      steps: [
        'The attacker builds a page that loads this site in a transparent frame.',
        'The visitor, signed in here, is persuaded to click what they believe is a harmless button.',
        'The click lands on a button in the framed page and submits the form.',
      ],
      conditions: ['The form changes something meaningful.', 'No other defence exists (for example confirmation steps).'],
      impact: 'Unwanted actions performed as the visitor.',
      breaks: ['Send frame-ancestors / X-Frame-Options', 'Add anti-forgery tokens and SameSite cookies'],
    },
    {
      id: 'admin-takeover',
      title: 'An exposed admin area is guarded by weak session protections',
      needs: ['adminExposed', 'weakSession'],
      summary: 'Administration interfaces are reachable from the internet, and session cookies are not well protected.',
      steps: [
        'The attacker finds the reachable admin interface.',
        'They steal or guess an administrator session by exploiting the weak cookie or transport protections.',
        'They use the admin interface to change the site.',
      ],
      conditions: ['The interface is really in use.', 'A way to obtain a session exists (XSS, network position or weak credentials).'],
      impact: 'Control of the application or its data.',
      breaks: ['Restrict admin interfaces by network or VPN', 'Require multi-factor authentication', 'Harden session cookies'],
    },
  ];

  const SEV_ORDER = ['info', 'low', 'medium', 'high'];
  const maxSeverity = (list) => SEV_ORDER[Math.max(...list.map((f) => SEV_ORDER.indexOf(f.severity)))];

  function correlate(findings) {
    const paths = [];
    const matched = (g) => findings.filter(GROUPS[g]);
    for (const def of PATHS) {
      const parts = def.needs.map(matched);
      if (parts.some((p) => !p.length)) continue;
      if ((def.unless || []).some((id) => paths.some((p) => p.id === id))) continue;
      const evidence = [...new Map(parts.flat().map((f) => [f.id, f])).values()];
      const allConfirmed = evidence.every((f) => f.status === 'confirmed');
      paths.push({
        id: def.id,
        title: def.title,
        status: 'potential',
        // The impact if the conditions held, not a statement that they do.
        severity: maxSeverity(evidence) === 'info' ? 'low' : maxSeverity(evidence),
        confidence: allConfirmed ? 'medium' : 'low',
        summary: def.summary,
        steps: def.steps,
        conditions: def.conditions,
        impact: def.impact,
        breaks: def.breaks,
        findingIds: evidence.map((f) => f.id),
        evidence: evidence.map((f) => ({ id: f.id, title: f.title, status: f.status })),
        note: 'Inferred from the findings listed. It is a potential path: the conditions above were not verified.',
      });
    }
    // Findings that appear in a path point at each other.
    for (const f of findings) {
      const rel = new Set();
      for (const p of paths) if (p.findingIds.includes(f.id)) p.findingIds.forEach((id) => id !== f.id && rel.add(id));
      f.related = [...rel];
    }
    return paths;
  }

  /* ---------- remediation plan ---------- */

  const THEME_TITLES = {
    exposure: 'Remove exposed files and secrets',
    transport: 'Use HTTPS everywhere',
    headers: 'Add the missing security headers',
    cookies: 'Harden cookies and stored tokens',
    forms: 'Protect forms and sign-in',
    code: 'Review client-side code patterns',
    dependencies: 'Update vulnerable libraries',
    'third-party': 'Reduce and lock down third-party code',
    admin: 'Restrict administrative interfaces',
    cors: 'Review cross-origin access',
    traffic: 'Fix insecure requests the page makes',
    disclosure: 'Reduce information disclosure and publish a security contact',
    'access-control': 'Verify access control',
    misc: 'Other items',
  };
  const THEME_ORDER = Object.keys(THEME_TITLES);
  const EFFORT_RANK = { quick: 0, moderate: 1, involved: 2 };

  function buildPlan(findings) {
    const bucket = (f) => (f.severity === 'high' && f.status !== 'info' ? 1 : f.severity === 'medium' && f.status !== 'info' ? 2 : 3);
    const groups = new Map();
    for (const f of findings) {
      const priority = bucket(f);
      const key = priority + ':' + f.theme;
      if (!groups.has(key)) groups.set(key, { priority, theme: f.theme, findings: [] });
      groups.get(key).findings.push(f);
    }
    const items = [...groups.values()].map((g) => {
      const actions = [...new Set(g.findings.map((f) => f.fix).filter(Boolean))];
      const examples = [...new Set(g.findings.map((f) => f.example).filter(Boolean))];
      const effort = g.findings.reduce((e, f) => (EFFORT_RANK[f.effort] > EFFORT_RANK[e] ? f.effort : e), 'quick');
      return {
        priority: g.priority,
        title: THEME_TITLES[g.theme] || THEME_TITLES.misc,
        theme: g.theme,
        effort,
        findingIds: g.findings.map((f) => f.id),
        actions,
        examples,
      };
    });
    items.sort((a, b) => a.priority - b.priority || THEME_ORDER.indexOf(a.theme) - THEME_ORDER.indexOf(b.theme));
    const quickWins = findings
      .filter((f) => f.effort === 'quick' && f.severity !== 'info' && f.status !== 'manual')
      .map((f) => f.id);
    return {
      priorities: {
        1: 'Fix first: high severity items that were confirmed or look possible.',
        2: 'Fix soon: medium severity items.',
        3: 'Harden when convenient: low severity, informational and manual-review items.',
      },
      items,
      quickWins,
    };
  }

  /* ---------- coverage ---------- */

  const LEVEL_RANK = { passive: 0, standard: 1, advanced: 2 };
  const CHECKS = [
    { id: 'headers', title: 'Response headers and Content-Security-Policy', level: 'passive' },
    { id: 'page', title: 'Page contents: forms, scripts, frames, links, mixed content', level: 'passive' },
    { id: 'cookies', title: 'Cookies and web-storage key names', level: 'passive' },
    { id: 'traffic', title: 'Observed requests (Network capture)', level: 'passive' },
    { id: 'security-txt', title: 'security.txt contact file', level: 'passive' },
    { id: 'libraries', title: 'Libraries and risky script hosts (from script addresses)', level: 'passive' },
    { id: 'baseline', title: 'Error page behaviour for a path that cannot exist', level: 'standard' },
    { id: 'robots', title: 'robots.txt', level: 'standard' },
    { id: 'probes', title: 'Well-known sensitive files and admin paths', level: 'standard' },
    { id: 'scripts', title: 'Secrets in the page’s own JavaScript and source maps', level: 'standard' },
    { id: 'cookie-flags', title: 'Exact cookie flags (HttpOnly, SameSite) via the optional cookies permission', level: 'optional' },
  ];

  const NOT_TESTABLE = [
    { id: 'tls', title: 'TLS certificate, protocol versions and ciphers', reason: 'Chrome does not expose connection security details to extensions.', how: 'Use an external tester such as SSL Labs (ssllabs.com/ssltest) or testssl.sh. DevForge does not send your site name to third parties for you.' },
    { id: 'injection', title: 'SQL, command and template injection', reason: 'Finding them means sending crafted inputs to the server and judging the replies. DevForge never sends attack payloads.', how: 'Review server code for parameterised queries, or run an authorised scanner such as OWASP ZAP against a test copy.' },
    { id: 'xss-exec', title: 'Whether reflected or stored XSS actually executes', reason: 'Needs test payloads. DevForge reports indicators only.', how: 'With permission, test with a harmless marker in a test environment and check the output encoding.' },
    { id: 'access-control', title: 'Broken access control and IDOR', reason: 'Needs two real accounts and would touch other users’ data.', how: 'Test with two accounts you own: open user A’s record address as user B.' },
    { id: 'auth', title: 'Authentication strength (password policy, MFA, lockout, reset flow)', reason: 'Requires interacting with accounts; credential guessing is out of scope.', how: 'Review the policy and test the flows manually with test accounts.' },
    { id: 'cors-reflection', title: 'CORS origin reflection', reason: 'Extensions cannot set the Origin request header.', how: 'curl -I -H "Origin: https://example.org" https://your-site/api/…' },
    { id: 'rate-limit', title: 'Rate limiting and brute-force protection', reason: 'Needs bursts of requests, which DevForge never sends.', how: 'Test on a staging copy with a load tool, with permission.' },
    { id: 'infra', title: 'Other subdomains, DNS and email security (SPF, DKIM, DMARC)', reason: 'Outside the scanned origin and not observable from a page.', how: 'Use DNS lookup tools and your mail provider’s checker.' },
    { id: 'server-software', title: 'Outdated server software and operating-system patches', reason: 'Only visible when a server announces its version.', how: 'Check patch levels on the server.' },
    { id: 'logic', title: 'Business-logic flaws', reason: 'Depend on how the application is meant to work.', how: 'Threat-model the main workflows and test them with test accounts.' },
  ];

  function buildCoverage(level, checks) {
    const rows = CHECKS.map((c) => {
      const got = (checks || {})[c.id];
      let state;
      let reason;
      if (got) ({ state, reason = '' } = got);
      else if (c.level !== 'optional' && LEVEL_RANK[c.level] > LEVEL_RANK[level]) {
        state = 'skipped';
        reason = 'Not part of the ' + level + ' level. Choose a deeper level to include it.';
      } else {
        state = 'skipped';
        reason = c.level === 'optional' ? 'Permission not granted.' : 'Not run.';
      }
      return { id: c.id, title: c.title, level: c.level, state, reason, requests: (got && got.requests) || 0 };
    });
    return { checks: rows, notTestable: NOT_TESTABLE };
  }

  /* ---------- the report ---------- */

  const hostOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch (_) {
      return '';
    }
  };

  const LIMITATIONS = [
    'Only the scanned origin is checked. Other pages beyond the ones the page links to, subdomains, APIs behind authentication and server internals are not examined.',
    'Response headers come from requests made without cookies, so they show what an anonymous visitor receives. They can differ for signed-in users or behind a CDN.',
    'Without the optional cookies permission, only cookies that scripts can read are visible. HttpOnly cookies and Set-Cookie headers are hidden from extensions.',
    'TLS configuration cannot be inspected from a Chrome extension.',
    'Pattern-based and library-version findings are indicators for a person to review, not confirmed vulnerabilities. Credential-like values are never tested to see whether they work.',
    'Server-side vulnerabilities (injection, broken access control, weak authentication) need controlled testing that DevForge does not perform.',
    'A report with few findings does not show that a site is secure; it shows what these checks could see.',
  ];

  // A short random id that links a report to sealed technical data. It carries no information.
  const randomId = () => {
    const c = globalThis.crypto;
    return c && c.randomUUID ? c.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  };

  const countBy = (list, key, values) => Object.fromEntries(values.map((v) => [v, list.filter((f) => f[key] === v).length]));

  /*
   * input: {
   *   url, startedAt, finishedAt, level, budget, requestLog,
   *   facts, headers, securityTxt, robots, baseline: {path, res}, probes: [{probe, path, res}],
   *   scripts, cookies: {exact, list}, traffic: {entries} | null, checks
   * }
   */
  function buildReport(input) {
    const level = Scan.LEVELS[input.level] ? input.level : 'passive';
    const facts = { ...input.facts, isLocal: Scan.isLocalHost(hostOf(input.url)) };
    const https = facts.protocol === 'https:';
    const found = [];
    const notes = [];
    const page = (input.url || '').split(/[?#]/)[0];

    const hd = input.headers;
    if (hd && hd.ok) {
      found.push(...Scan.analyzeHeaders(hd.headers, { https, hasPasswordForm: (facts.forms || []).some((f) => f.hasPassword), resource: page }));
      if (facts.cspMeta) notes.push('The page also sets a CSP through a <meta> tag, which is not covered by the header checks.');
      if (hd.status >= 400) notes.push('The page address answered with HTTP ' + hd.status + ' to a request without cookies, so the headers may differ from what signed-in visitors get.');
      if (hd.redirectedAway) notes.push('The request was redirected; the headers shown are from the final response.');
    } else {
      notes.push('Response headers could not be read' + (hd && hd.error ? ' (' + hd.error + ')' : '') + ', so header checks were skipped.');
    }
    found.push(...Scan.analyzeFacts(facts), ...Scan.analyzeStorage(facts));

    const ck = input.cookies || { exact: false, list: facts.cookies || [] };
    found.push(...Scan.analyzeCookies(ck.list, { https, exact: !!ck.exact }));

    if (input.traffic && input.traffic.entries) found.push(...Scan.analyzeTraffic(input.traffic.entries, { pageUrl: input.url }));
    found.push(...Scan.analyzeSecurityTxt(input.securityTxt));
    found.push(...Scan.analyzeRobots(input.robots));
    if (input.baseline) found.push(...Scan.analyzeBaseline(input.baseline.res, input.baseline.path));
    found.push(...Scan.analyzeProbes(input.probes, input.baseline ? Probe.baselineOf(input.baseline.res) : null));
    const scripts = input.scripts || { urls: (facts.scripts || []).map((s) => s.src), items: [], inline: facts.inlineScripts || [] };
    if (!scripts.urls) scripts.urls = (facts.scripts || []).map((s) => s.src);
    found.push(...Scan.analyzeScripts(scripts));

    // One finding per id and resource.
    const unique = [...new Map(found.map((f) => [f.id + '|' + f.resource, f])).values()];
    unique.sort(
      (a, b) =>
        SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        CONF_RANK[a.confidence] - CONF_RANK[b.confidence] ||
        a.title.localeCompare(b.title)
    );
    const attackPaths = correlate(unique);
    const plan = buildPlan(unique);
    const log = input.requestLog || [];
    const started = Date.parse(input.startedAt) || Date.now();
    const finished = Date.parse(input.finishedAt) || Date.now();

    const report = {
      tool: 'DevForge Security Checker',
      version: 2,
      id: input.id || randomId(),
      target: page,
      level,
      scannedAt: input.startedAt || new Date().toISOString(),
      durationMs: Math.max(finished - started, 0),
      budget: input.budget || null,
      requestsMade: log.length,
      requestLog: log.slice(0, 250),
      counts: countBy(unique, 'severity', SEVERITIES),
      countsByStatus: countBy(unique, 'status', Scan.STATUSES),
      findings: unique,
      attackPaths,
      plan,
      coverage: buildCoverage(level, input.checks),
      notes,
      limitations: LIMITATIONS,
      legend: STATUS_HELP,
    };
    return scrubDeep(report);
  }

  /* ---------- technical diagnostics (Owner mode) ---------- */

  const pathOnly = (u) => {
    try {
      const x = new URL(u, 'http://x');
      return x.pathname;
    } catch (_) {
      return String(u).split(/[?#]/)[0];
    }
  };

  /*
   * Detailed evidence about HOW a scan ran and what the target answered, for the person who is
   * authorised to see it. It never includes what the report must not: no cookie, storage or token
   * values, no secret values, no response bodies (only sizes, types and a content fingerprint), and
   * no query strings. It is kept apart from the report and is sealed with the Owner passphrase.
   */
  function buildTechnical({ report, facts, headers, baseline, probeLog, scripts, cookies, traffic, timings, environment }) {
    const cookieList = (cookies && cookies.exact ? cookies.list : (facts && facts.cookies) || []).map((c) => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, session: c.session, hostOnly: c.hostOnly }));
    const policy = headers && headers.ok && headers.headers ? headers.headers['content-security-policy'] || headers.headers['Content-Security-Policy'] : null;
    const base = baseline && baseline.res ? Probe.baselineOf(baseline.res) : null;
    const t = {
      generatedAt: new Date().toISOString(),
      reportId: report.id,
      target: report.target,
      level: report.level,
      budget: report.budget,
      durationMs: report.durationMs,
      environment: environment || {},
      responseHeaders: headers && headers.ok ? headers.headers : null,
      headerRequest: headers && headers.ok ? { status: headers.status, method: headers.method } : { error: (headers && headers.error) || 'not collected' },
      contentSecurityPolicy: policy ? Object.entries(Scan.parseCsp(policy)).map(([d, v]) => d + ' ' + v.join(' ')) : null,
      checks: report.coverage.checks.map((c) => ({ id: c.id, state: c.state, reason: c.reason, requests: c.requests, ms: (timings || {})[c.id] })),
      requests: report.requestLog,
      baseline: base ? { status: base.status, type: base.type, fingerprint: base.sig } : null,
      probes: (probeLog || []).map((p) => ({ id: p.id, path: p.path, status: p.status, type: String(p.type || '').split(';')[0], bytes: p.bytes, error: p.error, matched: report.findings.some((f) => f.id === 'exposed-' + p.id) })),
      scripts: ((scripts && scripts.items) || []).map((s) => ({ path: pathOnly(s.url), bytes: (s.text || '').length, fingerprint: Probe.fingerprint(s.text || ''), sourceMap: s.map ? { status: s.map.status, exposed: s.map.exposed } : null })),
      scriptAddresses: ((scripts && scripts.urls) || []).map(pathOnlyKeepHost),
      cookies: cookieList,
      traffic: traffic && traffic.entries ? { count: traffic.entries.length, samples: traffic.entries.slice(0, 50).map((e) => ({ method: e.method, url: pathOnlyKeepHost(e.url), status: e.status })) } : null,
      limits: { hardMaxRequests: Scan.HARD_MAX_REQUESTS, hardMinDelayMs: Scan.HARD_MIN_DELAY_MS, note: 'Owner mode does not change these limits or the authorisation requirements.' },
    };
    return scrubDeep(t);
  }
  const pathOnlyKeepHost = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname;
    } catch (_) {
      return String(u).split(/[?#]/)[0];
    }
  };

  /* ---------- loading a saved report ---------- */

  const httpsOnly = (list) => (Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u)).slice(0, 8);
  const strs = (list, max = 40) => (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string').slice(0, max).map((x) => x.slice(0, 600));
  const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

  /*
   * A report saved in Workspace is data from storage, not code, but it is still not trusted: it is
   * rebuilt field by field, unknown values fall back to the least alarming option, links must be
   * https, counts and the plan are recomputed, and the fixed texts (limitations, what cannot be
   * tested) come from this file. Returns null when it is not a version 2 report.
   */
  function validateReport(r) {
    if (!r || typeof r !== 'object' || r.version !== 2 || !Array.isArray(r.findings) || typeof r.target !== 'string') return null;
    try {
      new URL(r.target);
    } catch (_) {
      return null;
    }
    const text = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
    const level = Scan.LEVELS[r.level] ? r.level : 'passive';
    const findings = r.findings
      .slice(0, 500)
      .filter((f) => f && typeof f.id === 'string' && typeof f.title === 'string')
      .map((f) => {
        const status = oneOf(f.status, Scan.STATUSES, 'info');
        return {
          id: text(f.id, 120),
          title: text(f.title, 300),
          resource: text(f.resource, 500),
          owasp: oneOf(f.owasp, Object.keys(Scan.OWASP), 'A05'),
          category: Scan.OWASP[f.owasp] || Scan.OWASP.A05,
          theme: text(f.theme, 40) || 'misc',
          severity: status === 'info' ? 'info' : oneOf(f.severity, SEVERITIES, 'info'),
          confidence: oneOf(f.confidence, ['high', 'medium', 'low'], 'low'),
          status,
          effort: oneOf(f.effort, ['quick', 'moderate', 'involved'], 'moderate'),
          evidence: text(f.evidence),
          why: text(f.why),
          impact: text(f.impact),
          verify: text(f.verify),
          fix: text(f.fix),
          example: f.example ? text(f.example, 2000) : undefined,
          details: f.details ? text(f.details, 4000) : undefined,
          refs: httpsOnly(f.refs),
          related: strs(f.related, 20),
        };
      });
    const ids = new Set(findings.map((f) => f.id));
    findings.forEach((f) => (f.related = f.related.filter((id) => ids.has(id))));
    const attackPaths = (Array.isArray(r.attackPaths) ? r.attackPaths : []).slice(0, 20).filter((p) => p && typeof p.id === 'string' && typeof p.title === 'string').map((p) => ({
      id: text(p.id, 80),
      title: text(p.title, 300),
      status: 'potential',
      severity: oneOf(p.severity, SEVERITIES, 'low'),
      confidence: oneOf(p.confidence, ['high', 'medium', 'low'], 'low'),
      summary: text(p.summary),
      steps: strs(p.steps),
      conditions: strs(p.conditions),
      impact: text(p.impact),
      breaks: strs(p.breaks),
      findingIds: strs(p.findingIds, 20).filter((id) => ids.has(id)),
      evidence: (Array.isArray(p.evidence) ? p.evidence : []).slice(0, 20).filter((e) => e && ids.has(e.id)).map((e) => ({ id: e.id, title: text(e.title, 300), status: oneOf(e.status, Scan.STATUSES, 'info') })),
      note: text(p.note),
    }));
    const states = ['done', 'running', 'pending', 'skipped', 'failed', 'partial'];
    const checks = (r.coverage && Array.isArray(r.coverage.checks) ? r.coverage.checks : []).slice(0, 30).filter((c) => c && typeof c.id === 'string').map((c) => ({
      id: text(c.id, 40),
      title: text(c.title, 300),
      level: oneOf(c.level, ['passive', 'standard', 'advanced', 'optional'], 'passive'),
      state: oneOf(c.state, states, 'skipped'),
      reason: text(c.reason, 600),
      requests: Number.isFinite(c.requests) ? Math.max(0, Math.min(c.requests, 1000)) : 0,
    }));
    const log = (Array.isArray(r.requestLog) ? r.requestLog : []).slice(0, 250).map((e) => ({
      method: oneOf(e && e.method, ['GET', 'HEAD'], 'GET'),
      path: text(e && e.path, 300),
      status: e && (typeof e.status === 'number' || typeof e.status === 'string') ? String(e.status).slice(0, 60) : '',
      note: text(e && e.note, 200),
      purpose: text(e && e.purpose, 80),
    }));
    return scrubDeep({
      tool: 'DevForge Security Checker',
      version: 2,
      id: typeof r.id === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(r.id) ? r.id : undefined,
      target: r.target.split(/[?#]/)[0].slice(0, 500),
      level,
      scannedAt: text(r.scannedAt, 40) || new Date(0).toISOString(),
      durationMs: Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : 0,
      budget: r.budget && Number.isFinite(r.budget.maxRequests) ? { level, maxRequests: r.budget.maxRequests, delayMs: Number(r.budget.delayMs) || 0 } : null,
      requestsMade: log.length,
      requestLog: log,
      counts: countBy(findings, 'severity', SEVERITIES),
      countsByStatus: countBy(findings, 'status', Scan.STATUSES),
      findings,
      attackPaths,
      plan: buildPlan(findings),
      coverage: { checks, notTestable: NOT_TESTABLE },
      notes: strs(r.notes, 10),
      limitations: LIMITATIONS,
      legend: STATUS_HELP,
    });
  }

  /* ---------- Markdown ---------- */

  const mdLine = (s) => String(s).replace(/\r?\n/g, ' ');
  const code = (s) => '```\n' + String(s).replace(/```/g, "'''") + '\n```';

  /* One finding as Markdown. `h` is the heading marker so it works inside a report or on its own. */
  function findingBlock(f, h = '#') {
    const L = [h + ' ' + f.title, ''];
    L.push(
      '**Severity:** ' + SEV_LABEL[f.severity] + ' · **Confidence:** ' + f.confidence + ' · **Status:** ' + STATUS_LABEL[f.status] + ' · **Category:** ' + f.category + (f.resource ? ' · **Affected:** `' + f.resource + '`' : ''),
      ''
    );
    L.push('**Evidence:** ' + mdLine(f.evidence), '');
    L.push('**What it means:** ' + mdLine(f.why), '');
    if (f.impact) L.push('**Possible impact:** ' + mdLine(f.impact), '');
    if (f.verify) L.push('**How to verify safely:** ' + mdLine(f.verify), '');
    L.push('**How to fix:** ' + mdLine(f.fix), '');
    if (f.example) L.push(code(f.example), '');
    if (f.details) L.push(code(f.details), '');
    if (f.related && f.related.length) L.push('Related findings: ' + f.related.join(', '), '');
    if (f.refs && f.refs.length) L.push('References: ' + f.refs.join(', '), '');
    return L.join('\n');
  }

  function toMarkdown(report) {
    const L = [];
    L.push('# Website security check', '');
    L.push('| | |', '| --- | --- |');
    L.push('| Target | ' + report.target + ' |');
    L.push('| Scanned | ' + report.scannedAt + ' |');
    L.push('| Level | ' + (Scan.LEVELS[report.level] || {}).label + ' |');
    L.push('| Requests made | ' + report.requestsMade + ' (all to the target origin, GET/HEAD only, no cookies) |');
    L.push('| Tool | ' + report.tool + ' |');
    L.push(
      '| Findings | ' + SEVERITIES.map((s) => report.counts[s] + ' ' + s).join(', ') + ' (' + Scan.STATUSES.map((s) => report.countsByStatus[s] + ' ' + STATUS_LABEL[s].toLowerCase()).join(', ') + ') |',
      ''
    );
    L.push(
      'This report lists configuration gaps and indicators found without attack traffic. Severity (how bad it would be) and confidence (how sure the evidence is) are separate. Nothing here is a confirmed exploit unless it says so, and there is no overall score because a number would claim more precision than the checks have.',
      ''
    );
    for (const n of report.notes) L.push('> ' + n, '');

    L.push('## How to read the status', '');
    for (const s of Scan.STATUSES) L.push('- **' + STATUS_LABEL[s] + ':** ' + STATUS_HELP[s]);
    L.push('');

    if (report.plan.items.length) {
      L.push('## Remediation plan', '');
      let current = 0;
      for (const item of report.plan.items) {
        if (item.priority !== current) {
          current = item.priority;
          L.push('### Priority ' + current + ': ' + report.plan.priorities[current].replace(/^[^:]+: /, ''), '');
        }
        L.push('- **' + item.title + '** (' + item.findingIds.length + ' finding(s), effort: ' + item.effort + ')');
        for (const a of item.actions.slice(0, 6)) L.push('  - ' + mdLine(a));
      }
      L.push('');
    }

    if (report.attackPaths.length) {
      L.push('## Potential attack paths', '');
      L.push('These are inferred by combining findings. Each one is **potential**: the conditions listed were not verified.', '');
      for (const p of report.attackPaths) {
        L.push('### ' + p.title, '', '*Potential, impact if the conditions hold: ' + SEV_LABEL[p.severity] + '. Confidence: ' + p.confidence + '.*', '', p.summary, '');
        L.push('How it could unfold:');
        p.steps.forEach((s, i) => L.push(i + 1 + '. ' + s));
        L.push('', 'Conditions to verify:');
        p.conditions.forEach((c) => L.push('- ' + c));
        L.push('', 'Possible impact: ' + p.impact, '', 'Supporting findings: ' + p.evidence.map((e) => e.title + ' (' + e.status + ')').join('; '), '', 'Ways to break the path: ' + p.breaks.join('; '), '');
      }
    }

    L.push('## Findings', '');
    if (!report.findings.length) L.push('No findings from the checks that ran. That does not prove the site is secure.', '');
    for (const f of report.findings) L.push(findingBlock(f, '###'));

    L.push('## Scan coverage', '');
    L.push('| Check | Level | Result | Note |', '| --- | --- | --- | --- |');
    for (const c of report.coverage.checks) L.push('| ' + c.title + ' | ' + c.level + ' | ' + c.state + ' | ' + mdLine(c.reason) + ' |');
    L.push('', '### Not testable from a browser extension', '');
    for (const n of report.coverage.notTestable) L.push('- **' + n.title + ':** ' + n.reason + ' *To check it:* ' + n.how);
    L.push('');

    if (report.requestLog.length) {
      L.push('## Requests made', '', '| Method | Path | Result | Purpose |', '| --- | --- | --- | --- |');
      for (const r of report.requestLog) L.push('| ' + r.method + ' | `' + r.path + '` | ' + (r.status || r.note || '') + ' | ' + (r.purpose || '') + ' |');
      L.push('');
    }
    L.push('## Limitations', '');
    for (const l of report.limitations) L.push('- ' + l);
    L.push('');
    return L.join('\n');
  }

  /* ---------- disclosure message ---------- */

  /*
   * A starting point the user edits before sending. It states only what was observed.
   * opts: { recipient, sender, contact, days, include: [finding ids] }
   */
  function disclosureTemplate(report, opts = {}) {
    const days = opts.days || 90;
    const pick = (f) => (opts.include ? opts.include.includes(f.id) : f.severity !== 'info' && f.status !== 'info');
    const items = report.findings.filter(pick).slice(0, 20);
    const L = [
      'Subject: Security observations for ' + hostOf(report.target),
      '',
      'Hello' + (opts.recipient ? ' ' + opts.recipient : '') + ',',
      '',
      'On ' + report.scannedAt.slice(0, 10) + ' I reviewed ' + report.target + ' and noticed some security configuration points that you may want to look at.',
      '',
      'How I checked: I used a browser extension that reads the page and makes a small number of ordinary GET/HEAD requests to the same site (' + report.requestsMade + ' in total, without cookies or credentials, and without sending test payloads). I did not try to sign in, access other users’ data, change anything, or probe beyond the site itself.',
      '',
    ];
    if (!items.length) L.push('Nothing above informational level was found.');
    items.forEach((f, i) => {
      L.push(i + 1 + '. ' + f.title + ' [' + SEV_LABEL[f.severity] + ', ' + STATUS_LABEL[f.status].toLowerCase() + (f.resource ? ', ' + f.resource : '') + ']');
      L.push('   Evidence: ' + mdLine(f.evidence));
      L.push('   Suggested fix: ' + mdLine(f.fix));
    });
    L.push(
      '',
      'Please treat these as observations to verify, not as confirmed vulnerabilities; some depend on how the server is configured behind what I could see.',
      '',
      'I will keep these details private and will not publish them. If you would like to talk about any point, you can reach me at ' + (opts.contact || '[your contact details]') + '. If I do not hear back I may follow up once; I would not share anything publicly before ' + days + ' days have passed or you have fixed the issues, whichever comes first.',
      '',
      'Kind regards',
      opts.sender || '[your name]'
    );
    return L.join('\n');
  }

  return {
    STATUS_LABEL,
    STATUS_HELP,
    SEV_LABEL,
    CHECKS,
    NOT_TESTABLE,
    LIMITATIONS,
    PATHS,
    scrub,
    scrubDeep,
    correlate,
    buildPlan,
    buildCoverage,
    buildReport,
    buildTechnical,
    validateReport,
    toMarkdown,
    findingBlock,
    disclosureTemplate,
  };
})();
if (typeof module !== 'undefined') module.exports = DFSecReport;
