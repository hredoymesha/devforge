// Security tab: a layered, evidence-based website security assessment for sites you own or have
// permission to test. Scan levels and the confirmation flow live here, collection in
// panel/securityrun.js + agent/security.js, analysis in lib/secscan.js and lib/secreport.js.

const SEC_ACK_KEY = 'secAcknowledged';
const SEC_STATE_LABEL = { done: 'Done', running: 'Running', pending: 'Waiting', skipped: 'Skipped', failed: 'Failed', partial: 'Partial' };
const SEC_STATE_ICON = { done: 'check', running: 'retry', pending: 'skip', skipped: 'skip', failed: 'alert', partial: 'info' };

// In-memory state that survives switching tabs inside the panel (not across panel reloads).
const SEC = {
  view: 'setup', // setup | running | results
  level: 'passive',
  options: { maxRequests: '', delayMs: '' },
  control: null,
  steps: [],
  progress: { used: 0, max: 0 },
  report: null,
  saved: false,
  error: '',
  tab: 'overview',
  filters: { q: '', severity: 'all', status: 'all', category: 'all', sort: 'severity', group: 'none' },
  disclosure: { recipient: '', sender: '', contact: '', days: 90, text: '', include: null },
  owner: { technical: true }, // Owner mode option, used only while Owner mode is unlocked
  repaint: null,
  progressUI: null,
};

/* ---------- confirmation, kept for the browser session only ---------- */

// Stored as { origin: 'confirm' | 'advanced' }. An older build stored a plain list of origins.
async function secAckLevel(origin) {
  const got = (await chrome.storage.session.get(SEC_ACK_KEY))[SEC_ACK_KEY];
  if (Array.isArray(got)) return got.includes(origin) ? 'confirm' : null;
  return (got && got[origin]) || null;
}
async function secSetAck(origin, level) {
  const got = (await chrome.storage.session.get(SEC_ACK_KEY))[SEC_ACK_KEY];
  const map = got && !Array.isArray(got) ? got : {};
  if (level) map[origin] = level;
  else delete map[origin];
  await chrome.storage.session.set({ [SEC_ACK_KEY]: map });
}

/* ---------- small building blocks ---------- */

const SEC_SEV_TEXT = DFSecReport.SEV_LABEL;
const SEC_STATUS_TEXT = DFSecReport.STATUS_LABEL;
const secBadge = (kind, text, title) => h('span', { class: 'sec-badge sec-' + kind, title: title || null }, text);
const secSeverityBadge = (f) => secBadge(f.severity, SEC_SEV_TEXT[f.severity], 'Severity: how bad it would be if the condition is real');
const secStatusBadge = (f) => secBadge('st-' + f.status, SEC_STATUS_TEXT[f.status], DFSecReport.STATUS_HELP[f.status]);
const secConfBadge = (f) => secBadge('conf', 'Confidence: ' + f.confidence, 'Confidence: how sure the evidence is');
const secPlural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

function secCopyButton(text, label = 'Copy') {
  return h('button', { class: 'sec-mini', on: { click: () => copy(text) } }, icon('copy', 13), ' ', label);
}

/* ---------- progress ---------- */

function secInitSteps(level) {
  return DFSecReport.CHECKS.filter((c) => c.level === 'passive' || c.level === 'optional' || level !== 'passive').map((c) => ({
    id: c.id,
    title: c.title,
    state: 'pending',
    reason: '',
  }));
}

function secMakeProgress() {
  const bar = h('progress', { max: 100, value: 0, 'aria-label': 'Scan progress' });
  const count = h('span', { class: 'sec-count-text' }, '');
  const list = h('ol', { class: 'sec-steps' });
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const cancel = h('button', { class: 'danger', on: { click: () => secCancelScan() } }, icon('stop', 14), ' Cancel scan');
  const el = h(
    'div',
    { class: 'card sec-progress' },
    h('b', null, 'Scanning ', mono(SEC.target.host)),
    h('div', { class: 'row' }, bar, count),
    list,
    h('div', { class: 'row' }, cancel),
    live
  );
  const ui = {
    el,
    update() {
      const { used, max } = SEC.progress;
      const finished = SEC.steps.filter((s) => s.state !== 'pending' && s.state !== 'running').length;
      bar.max = SEC.steps.length || 1;
      bar.value = finished;
      count.textContent = finished + ' of ' + SEC.steps.length + ' checks · ' + used + ' of ' + max + ' requests';
      clear(list).append(
        ...SEC.steps.map((s) =>
          h(
            'li',
            { class: 'sec-step sec-step-' + s.state },
            icon(SEC_STATE_ICON[s.state], 14),
            h('span', null, ' ' + s.title),
            h('span', { class: 'sev-info' }, ' ' + SEC_STATE_LABEL[s.state] + (s.reason ? ' · ' + s.reason : ''))
          )
        )
      );
      const running = SEC.steps.find((s) => s.state === 'running');
      live.textContent = running ? 'Running: ' + running.title : '';
    },
  };
  SEC.progressUI = ui;
  ui.update();
  return el;
}

function secCancelScan() {
  if (!SEC.control) return;
  SEC.control.cancelled = true;
  SEC.control.reason = 'The scan was cancelled. Results cover only the checks that finished.';
  call('secCancel').catch(() => {});
  toast('Cancelling…');
}

async function secStartScan(target) {
  SEC.view = 'running';
  SEC.report = null;
  SEC.saved = false;
  SEC.pinned = false;
  SEC.error = '';
  SEC.control = { cancelled: false };
  SEC.target = target;
  SEC.steps = secInitSteps(SEC.level);
  SEC.progress = { used: 0, max: DFSecScan.scanBudget(SEC.level, SEC.options).maxRequests };
  SEC.repaint && SEC.repaint();
  const wantTechnical = DFOwnerSession.isUnlocked() && SEC.owner.technical;
  DFOwnerSession.record({ event: 'scan started', detail: SEC.level + ' on ' + target.host });
  try {
    const { report, technical } = await secRunScan({
      level: SEC.level,
      options: SEC.options,
      target,
      control: SEC.control,
      technical: wantTechnical,
      onStep(id, state, reason) {
        const s = SEC.steps.find((x) => x.id === id);
        if (s) Object.assign(s, { state, reason: reason || s.reason });
        SEC.progressUI && SEC.progressUI.update();
      },
      onProgress(p) {
        SEC.progress = p;
        SEC.progressUI && SEC.progressUI.update();
      },
    });
    SEC.report = report;
    SEC.view = 'results';
    SEC.tab = 'overview';
    SEC.disclosure.text = '';
    SEC.disclosure.include = null;
    DFOwnerSession.record({ event: 'scan finished', detail: report.requestsMade + ' requests, ' + report.findings.length + ' findings' });
    // Sealed with the Owner key. It is stored apart from the report and never exported with it.
    // If Owner mode was locked in the meantime the technical data is simply discarded.
    if (technical && DFOwnerSession.isUnlocked()) {
      try {
        await DFOwnerSession.sealTechnical(report.id, { host: target.host, level: report.level, at: report.scannedAt }, technical);
        SEC.technicalSealed = report.id;
      } catch (e) {
        DFOwnerSession.record({ event: 'sealing failed', detail: e.message });
      }
    }
  } catch (e) {
    DFOwnerSession.record({ event: 'scan failed', detail: e.message });
    SEC.error = e.message;
    SEC.view = 'setup';
  } finally {
    SEC.progressUI = null;
    SEC.repaint && SEC.repaint();
  }
}

/* ---------- setup ---------- */

function secSetupView(target) {
  const root = h('div');
  const levelBox = h('fieldset', { class: 'sec-levels' }, h('legend', null, 'Scan level'));
  const optionsBox = h('div');
  const ackBox = h('div');
  const startBtn = h('button', { class: 'primary', on: { click: () => secStartScan(target) } }, icon('security', 14), ' Start scan');
  const notice = h('div', { class: 'sev-info' });
  let ackConfirm;
  let ackAdvanced;

  const refresh = () => {
    const lv = DFSecScan.LEVELS[SEC.level];
    const needsConfirm = target.kind === 'public';
    const needsAdvanced = target.kind === 'public' && SEC.level === 'advanced';
    const ready = !needsConfirm || (ackConfirm.checked && (!needsAdvanced || ackAdvanced.checked));
    startBtn.disabled = !ready;
    const advancedLabel = ackAdvanced.closest('label');
    if (advancedLabel) advancedLabel.hidden = !needsAdvanced;
    optionsBox.hidden = SEC.level === 'passive';
    const b = DFSecScan.scanBudget(SEC.level, SEC.options);
    notice.textContent = lv.label + ': up to ' + b.maxRequests + ' request' + (b.maxRequests === 1 ? '' : 's') + (b.delayMs ? ', at least ' + b.delayMs + ' ms apart' : '') + '. All to ' + target.origin + ', GET/HEAD only, no cookies sent.';
  };

  for (const key of ['passive', 'standard', 'advanced']) {
    const lv = DFSecScan.LEVELS[key];
    const input = h('input', {
      type: 'radio',
      name: 'sec-level',
      id: 'sec-lv-' + key,
      value: key,
      checked: SEC.level === key,
      on: {
        change: () => {
          SEC.level = key;
          SEC.options = { maxRequests: '', delayMs: '' };
          maxInput.value = '';
          delayInput.value = '';
          maxInput.placeholder = String(lv.maxRequests);
          delayInput.placeholder = String(lv.delayMs);
          refresh();
        },
      },
    });
    levelBox.append(
      h(
        'label',
        { class: 'sec-level', for: 'sec-lv-' + key },
        input,
        h(
          'span',
          { class: 'sec-level-body' },
          h('b', null, lv.label),
          h('span', null, lv.summary)
        )
      )
    );
  }

  const maxInput = h('input', { type: 'number', min: 3, max: DFSecScan.HARD_MAX_REQUESTS, 'aria-label': 'Maximum requests', placeholder: String(DFSecScan.LEVELS[SEC.level].maxRequests), value: SEC.options.maxRequests, on: { input: () => { SEC.options.maxRequests = maxInput.value; refresh(); } } });
  const delayInput = h('input', { type: 'number', min: DFSecScan.HARD_MIN_DELAY_MS, max: 5000, step: 50, 'aria-label': 'Pause between requests in milliseconds', placeholder: String(DFSecScan.LEVELS[SEC.level].delayMs), value: SEC.options.delayMs, on: { input: () => { SEC.options.delayMs = delayInput.value; refresh(); } } });
  optionsBox.append(
    h(
      'details',
      { class: 'card' },
      h('summary', null, 'Request limits'),
      h('p', { class: 'sev-info' }, 'Lower these to be gentler on a fragile server. They cannot be raised above ' + DFSecScan.HARD_MAX_REQUESTS + ' requests or lowered below ' + DFSecScan.HARD_MIN_DELAY_MS + ' ms between requests.'),
      h('div', { class: 'row' }, h('label', null, 'Maximum requests ', maxInput), h('label', null, 'Pause (ms) ', delayInput))
    )
  );

  ackConfirm = h('input', { type: 'checkbox', id: 'sec-ack', on: { change: async () => { await secSetAck(target.origin, ackConfirm.checked ? 'confirm' : null); if (!ackConfirm.checked) ackAdvanced.checked = false; refresh(); } } });
  ackAdvanced = h('input', { type: 'checkbox', id: 'sec-ack-adv', on: { change: async () => { await secSetAck(target.origin, ackAdvanced.checked ? 'advanced' : 'confirm'); refresh(); } } });
  if (target.kind === 'public') {
    ackBox.append(
      h('label', { class: 'sec-ack', for: 'sec-ack' }, ackConfirm, ' I own ' + target.host + ' or have permission to run security checks on it.'),
      h(
        'label',
        { class: 'sec-ack', for: 'sec-ack-adv' },
        ackAdvanced,
        ' I have authorisation for deeper testing and understand that the Advanced level sends many requests that will show up in the site’s logs and may trigger alerts or rate limits.'
      )
    );
    secAckLevel(target.origin).then(async (got) => {
      // A site the owner has authorised (Owner mode unlocked) counts as the ordinary confirmation.
      // The Advanced confirmation is never pre-filled.
      const owned = got ? null : await DFOwnerSession.originAuthorized(target.origin);
      if (owned) {
        await secSetAck(target.origin, 'confirm');
        const grants = (await chrome.storage.session.get('secOwnerGranted')).secOwnerGranted || {};
        grants[target.origin] = true;
        await chrome.storage.session.set({ secOwnerGranted: grants });
        got = 'confirm';
        ackBox.append(h('div', { class: 'sev-info', id: 'sec-owner-auth', role: 'note' }, icon('owner', 14), ' Authorised in Owner mode on ' + new Date(owned.at).toLocaleDateString() + '. Untick the box above to scan without that approval.'));
      }
      ackConfirm.checked = !!got;
      ackAdvanced.checked = got === 'advanced';
      refresh();
    });
  } else {
    ackBox.append(h('div', { class: 'sev-info' }, target.reason));
  }

  const advancedNote = h(
    'div',
    { class: 'card sev-warn', role: 'note' },
    h('b', null, 'About the Advanced level'),
    h(
      'ul',
      null,
      h('li', null, 'Requests a longer list of sensitive paths (backups, configuration files, debug and admin pages) and reads more of the page’s scripts.'),
      h('li', null, 'Every request is a plain GET or HEAD to this site only. It does not log in, guess passwords, send test payloads, crawl, or change anything.'),
      h('li', null, 'Servers with intrusion detection may flag it. Tell whoever runs the site before you start.')
    )
  );
  const toggleAdvancedNote = () => (advancedNote.hidden = SEC.level !== 'advanced');
  levelBox.addEventListener('change', toggleAdvancedNote);

  // Network capture adds observed requests to the assessment.
  const captureOn = typeof net !== 'undefined' && net.captureOn;
  const captureNote = captureOn
    ? h('div', { class: 'sev-ok' }, icon('check', 14), ' Network capture is on: the ' + net.rows.size + ' captured requests will be analysed too.')
    : h(
        'div',
        { class: 'sev-info' },
        icon('info', 14),
        ' Network capture is off. Turn it on in the Network tab and use the site first to include the requests the page makes. ',
        h('button', { class: 'link', on: { click: () => show('network') } }, 'Open Network')
      );

  root.append(levelBox, advancedNote, optionsBox, secCookieCard(target), secOwnerCard(), h('div', { class: 'card' }, captureNote, notice, ackBox, h('div', { class: 'row' }, startBtn)));
  toggleAdvancedNote();
  refresh();
  return root;
}

// Shown only while Owner mode is unlocked. It changes what is recorded, never what is allowed.
function secOwnerCard() {
  if (!DFOwnerSession.isUnlocked()) return '';
  return h(
    'div',
    { class: 'card' },
    h('b', null, icon('owner', 14), ' Owner options'),
    h(
      'label',
      { class: 'sec-ack', for: 'sec-owner-tech' },
      h('input', { type: 'checkbox', id: 'sec-owner-tech', checked: SEC.owner.technical, on: { change: (e) => (SEC.owner.technical = e.target.checked) } }),
      ' Collect technical diagnostics for this scan (sealed in the Owner tab)'
    ),
    h('div', { class: 'sev-info' }, 'Owner mode does not change request limits or the ownership confirmation. ', h('button', { class: 'link', on: { click: () => show('owner') } }, 'Plan a dry run in the Owner tab'))
  );
}

// The cookies permission is optional: it makes cookie checks exact. It is requested only here.
function secCookieCard(target) {
  const box = h('div', { class: 'card' });
  const draw = async () => {
    const on = await secCookiePermissionGranted(target.origin);
    clear(box).append(
      h('b', null, 'Exact cookie flags ', secBadge(on ? 'observed' : 'conf', on ? 'On' : 'Off')),
      h(
        'p',
        { class: 'sev-info' },
        on
          ? 'DevForge can read whether cookies are HttpOnly, Secure and SameSite for ' + target.host + '. Cookie values are never read into the report.'
          : 'Without it, DevForge only sees cookies that scripts can read, so it cannot tell whether session cookies are HttpOnly. Allowing it adds the optional "cookies" permission for ' + target.host + ' only. Values are never read, and you can remove the permission any time.'
      ),
      h(
        'div',
        { class: 'row' },
        on
          ? h('button', { on: { click: async () => { await chrome.permissions.remove({ permissions: [SEC_COOKIE_PERMISSION] }); draw(); } } }, 'Turn off')
          : h('button', { on: { click: async () => { const ok = await secRequestCookiePermission(target.origin); toast(ok ? 'Cookie flag checks enabled' : 'Permission not granted'); draw(); } } }, 'Allow cookie flag checks')
      )
    );
  };
  draw();
  return box;
}

/* ---------- results ---------- */

function secTabs(defs, current, onSelect) {
  const bar = h('div', { class: 'seg sec-tabs', role: 'tablist', 'aria-label': 'Report sections' });
  for (const [id, label, count] of defs) {
    bar.append(
      h(
        'button',
        {
          role: 'tab',
          id: 'sec-tab-' + id,
          'aria-selected': String(id === current),
          tabindex: id === current ? 0 : -1,
          on: { click: () => onSelect(id) },
        },
        label,
        count != null ? h('span', { class: 'sec-tab-count' }, String(count)) : ''
      )
    );
  }
  bar.addEventListener('keydown', (e) => {
    const tabs = [...bar.querySelectorAll('[role=tab]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : null;
    if (next) {
      e.preventDefault();
      next.focus();
      next.click();
    }
  });
  return bar;
}

function secResultsView() {
  const report = SEC.report;
  const root = h('div');
  const body = h('div', { role: 'tabpanel', 'aria-labelledby': 'sec-tab-' + SEC.tab });
  const draw = () => {
    clear(root);
    const defs = [
      ['overview', 'Overview'],
      ['findings', 'Findings', report.findings.length],
      ['paths', 'Attack paths', report.attackPaths.length],
      ['plan', 'Plan'],
      ['coverage', 'Coverage'],
      ['export', 'Export'],
    ];
    root.append(
      h(
        'div',
        { class: 'sec-head' },
        h('div', null, h('b', null, new URL(report.target).host), ' ', h('span', { class: 'sev-info' }, DFSecScan.LEVELS[report.level].label + ' scan · ' + new Date(report.scannedAt).toLocaleString() + (SEC.saved ? ' · saved report' : ''))),
        h('button', { on: { click: () => { SEC.view = 'setup'; SEC.repaint(); } } }, icon('retry', 14), ' New scan')
      ),
      secTabs(defs, SEC.tab, (id) => {
        SEC.tab = id;
        draw();
      }),
      clear(body)
    );
    body.setAttribute('aria-labelledby', 'sec-tab-' + SEC.tab);
    ({ overview: secOverview, findings: secFindings, paths: secPaths, plan: secPlan, coverage: secCoverage, export: secExport })[SEC.tab](body, report);
  };
  SEC.go = (tab, findingId) => {
    SEC.tab = tab;
    SEC.focusFinding = findingId || null;
    draw();
  };
  draw();
  return root;
}

function secOverview(box, report) {
  const c = report.coverage.checks;
  const count = (state) => c.filter((x) => x.state === state).length;
  const tiles = h(
    'div',
    { class: 'sec-counts', role: 'group', 'aria-label': 'Findings by severity' },
    DFSecScan.SEVERITIES.map((s) => h('div', { class: 'sec-count sec-sev-' + s }, h('b', null, report.counts[s]), ' ', SEC_SEV_TEXT[s]))
  );
  const statusTiles = h(
    'div',
    { class: 'sec-statuses', role: 'group', 'aria-label': 'Findings by status' },
    DFSecScan.STATUSES.map((s) => h('div', { title: DFSecReport.STATUS_HELP[s] }, h('b', null, report.countsByStatus[s]), ' ' + SEC_STATUS_TEXT[s]))
  );
  const top = report.findings.filter((f) => f.severity !== 'info').slice(0, 5);
  const gaps = c.filter((x) => ['skipped', 'failed', 'partial'].includes(x.state));
  box.append(
    ...report.notes.map((n) => h('div', { class: 'card sev-warn', role: 'note' }, n)),
    section('Summary', tiles, statusTiles, h('p', { class: 'sev-info' }, 'Severity is how bad a finding would be if it is real. Status says how well the evidence supports it. There is no overall score on purpose: a number would suggest more precision than these checks have.')),
    section(
      'What this scan did',
      kv({
        Target: report.target,
        Level: DFSecScan.LEVELS[report.level].label,
        'Requests made': report.requestsMade + (report.budget ? ' of ' + report.budget.maxRequests + ' allowed' : '') + ' (GET/HEAD, same origin, no cookies)',
        Duration: Math.max(1, Math.round(report.durationMs / 1000)) + ' s',
        Checks: count('done') + ' done, ' + count('partial') + ' partial, ' + count('skipped') + ' skipped, ' + count('failed') + ' failed',
      })
    ),
    top.length
      ? section(
          'Start here',
          h(
            'ol',
            { class: 'sec-top' },
            top.map((f) => h('li', null, secSeverityBadge(f), ' ', secStatusBadge(f), ' ', h('button', { class: 'link', on: { click: () => SEC.go('findings', f.id) } }, f.title)))
          ),
          report.attackPaths.length ? h('div', null, icon('path', 14), ' ', secPlural(report.attackPaths.length, 'potential attack path'), ' inferred from these findings. ', h('button', { class: 'link', on: { click: () => SEC.go('paths') } }, 'See paths')) : ''
        )
      : section('Start here', emptyState('Nothing at medium or high severity', report.findings.length ? 'Only low-severity or informational findings were found.' : 'These checks found nothing to report. That does not prove the site is secure: see what was not covered.')),
    gaps.length
      ? section(
          'Not fully covered',
          h('ul', null, gaps.map((g) => h('li', null, h('b', null, g.title), ' ', h('span', { class: 'sev-info' }, '(' + SEC_STATE_LABEL[g.state].toLowerCase() + ') ' + g.reason)))),
          h('button', { class: 'link', on: { click: () => SEC.go('coverage') } }, 'Open full coverage')
        )
      : ''
  );
}

/* Findings: search, filters, sorting and grouping over the report's list. */
function secFindings(box, report) {
  const F = SEC.filters;
  const list = h('div');
  const categories = [...new Set(report.findings.map((f) => f.category))].sort();
  const sel = (key, label, options) =>
    h('label', { class: 'sec-filter' }, label, h('select', { 'aria-label': label, on: { change: (e) => { F[key] = e.target.value; render(); } } }, options.map(([v, t]) => h('option', { value: v, selected: F[key] === v }, t))));
  const search = h('input', { type: 'search', placeholder: 'Search findings…', 'aria-label': 'Search findings', value: F.q, on: { input: (e) => { F.q = e.target.value; render(); } } });
  const count = h('div', { class: 'sev-info', role: 'status', 'aria-live': 'polite' });

  const matches = (f) => {
    if (F.severity !== 'all' && f.severity !== F.severity) return false;
    if (F.status !== 'all' && f.status !== F.status) return false;
    if (F.category !== 'all' && f.category !== F.category) return false;
    if (F.q) {
      const hay = [f.title, f.evidence, f.why, f.resource, f.category, f.id].join(' ').toLowerCase();
      if (!F.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  };
  const SEV = { high: 0, medium: 1, low: 2, info: 3 };
  const CONF = { high: 0, medium: 1, low: 2 };
  const ST = { confirmed: 0, potential: 1, manual: 2, info: 3 };
  const sorters = {
    severity: (a, b) => SEV[a.severity] - SEV[b.severity] || ST[a.status] - ST[b.status],
    confidence: (a, b) => CONF[a.confidence] - CONF[b.confidence] || SEV[a.severity] - SEV[b.severity],
    category: (a, b) => a.category.localeCompare(b.category) || SEV[a.severity] - SEV[b.severity],
    resource: (a, b) => (a.resource || '~').localeCompare(b.resource || '~') || SEV[a.severity] - SEV[b.severity],
  };
  const groupKey = { none: () => '', category: (f) => f.category, status: (f) => SEC_STATUS_TEXT[f.status], severity: (f) => SEC_SEV_TEXT[f.severity] };

  function render() {
    const shown = report.findings.filter(matches).sort(sorters[F.sort]);
    count.textContent = shown.length + ' of ' + report.findings.length + ' findings shown';
    clear(list);
    if (!shown.length) {
      list.append(
        emptyState(report.findings.length ? 'No findings match these filters' : 'No findings', report.findings.length ? 'Change or clear the filters to see more.' : 'These checks found nothing to report.', report.findings.length ? h('button', { on: { click: () => { Object.assign(F, { q: '', severity: 'all', status: 'all', category: 'all' }); SEC.go('findings'); } } }, 'Clear filters') : null)
      );
      return;
    }
    let lastGroup = null;
    for (const f of shown) {
      const g = groupKey[F.group](f);
      if (g !== lastGroup) {
        lastGroup = g;
        if (g) list.append(h('h3', { class: 'sec-group' }, g));
      }
      list.append(secFindingCard(f, report));
    }
    if (SEC.focusFinding) {
      const card = list.querySelector('[data-fid="' + CSS.escape(SEC.focusFinding) + '"]');
      if (card) {
        card.open = true;
        card.scrollIntoView({ block: 'start' });
        card.querySelector('summary').focus();
      }
      SEC.focusFinding = null;
    }
  }

  // Jumping to a finding that the filters hide clears the filters first.
  if (SEC.focusFinding) {
    const f = report.findings.find((x) => x.id === SEC.focusFinding);
    if (f && !matches(f)) Object.assign(F, { q: '', severity: 'all', status: 'all', category: 'all' });
  }

  box.append(
    h(
      'div',
      { class: 'sec-toolbar' },
      search,
      sel('severity', 'Severity', [['all', 'All severities'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low'], ['info', 'Info']]),
      sel('status', 'Status', [['all', 'All statuses'], ['confirmed', 'Confirmed'], ['potential', 'Potential'], ['manual', 'Needs manual verification'], ['info', 'Informational']]),
      sel('category', 'Category', [['all', 'All categories'], ...categories.map((c) => [c, c])]),
      sel('sort', 'Sort', [['severity', 'Sort: severity'], ['confidence', 'Sort: confidence'], ['category', 'Sort: category'], ['resource', 'Sort: affected resource']]),
      sel('group', 'Group', [['none', 'No grouping'], ['category', 'Group by category'], ['status', 'Group by status'], ['severity', 'Group by severity']])
    ),
    count,
    list
  );
  render();
}

function secFindingCard(f, report) {
  const rel = (f.related || []).map((id) => report.findings.find((x) => x.id === id)).filter(Boolean);
  return h(
    'details',
    { class: 'card sec-finding sec-sev-' + f.severity, 'data-fid': f.id },
    h(
      'summary',
      null,
      secSeverityBadge(f),
      ' ',
      secStatusBadge(f),
      ' ',
      h('b', null, f.title),
      f.resource ? h('div', { class: 'sec-resource' }, mono(f.resource)) : ''
    ),
    h('div', { class: 'sec-meta' }, secConfBadge(f), ' ', secBadge('conf', f.category), ' ', secBadge('conf', 'Fix effort: ' + f.effort)),
    secField('What it means', f.why),
    secField('Evidence', f.evidence),
    f.impact ? secField('Possible impact', f.impact) : '',
    f.verify ? secField('How to verify safely', f.verify) : '',
    secField('How to fix', f.fix),
    f.example ? h('div', null, codeBlock(f.example), secCopyButton(f.example, 'Copy example')) : '',
    f.details ? h('details', null, h('summary', null, 'Technical details'), codeBlock(f.details)) : '',
    rel.length ? h('div', { class: 'sec-related' }, h('b', null, 'Related findings: '), rel.map((r) => [h('button', { class: 'link', on: { click: () => SEC.go('findings', r.id) } }, r.title), ' '])) : '',
    f.refs && f.refs.some((u) => /^https:\/\//.test(u)) ? h('div', { class: 'sev-info' }, 'Learn more: ', f.refs.filter((u) => /^https:\/\//.test(u)).map((url, i) => [i ? ' · ' : '', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, new URL(url).hostname)])) : '',
    h('div', { class: 'row' }, secCopyButton(DFSecReport.findingBlock(f, '##'), 'Copy finding'))
  );
}
const secField = (label, text) => h('p', null, h('b', null, label + '. '), text);

function secPaths(box, report) {
  box.append(
    h('div', { class: 'card sev-warn', role: 'note' }, h('b', null, 'Potential, not confirmed. '), 'Attack paths combine findings to show what could follow if the listed conditions are true. DevForge has not exploited anything and has not verified these conditions.')
  );
  if (!report.attackPaths.length) {
    box.append(emptyState('No attack paths inferred', 'No combination of findings from this scan lines up into a path. That is not proof that none exists.'));
    return;
  }
  for (const p of report.attackPaths) {
    box.append(
      h(
        'section',
        { class: 'card sec-path' },
        h('h3', null, icon('path', 16), ' ', p.title),
        h('div', { class: 'sec-meta' }, secBadge('st-potential', 'Potential'), ' ', secBadge(p.severity, 'Impact if true: ' + SEC_SEV_TEXT[p.severity]), ' ', secBadge('conf', 'Confidence: ' + p.confidence)),
        h('p', null, p.summary),
        h('b', null, 'How it could unfold'),
        h('ol', null, p.steps.map((s) => h('li', null, s))),
        h('b', null, 'Conditions to verify first'),
        h('ul', null, p.conditions.map((s) => h('li', null, s))),
        h('p', null, h('b', null, 'Possible impact. '), p.impact),
        h('p', null, h('b', null, 'Evidence this relies on: '), p.evidence.map((e) => [h('button', { class: 'link', on: { click: () => SEC.go('findings', e.id) } }, e.title), ' (' + e.status + ') '])),
        h('b', null, 'Ways to break the path'),
        h('ul', null, p.breaks.map((s) => h('li', null, s))),
        h('div', { class: 'sev-info' }, p.note)
      )
    );
  }
}

function secPlan(box, report) {
  const plan = report.plan;
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  if (!plan.items.length) {
    box.append(emptyState('Nothing to fix from this scan', 'No findings were reported.'));
    return;
  }
  if (plan.quickWins.length)
    box.append(
      section(
        'Quick wins',
        h('p', { class: 'sev-info' }, 'Small changes with a visible benefit.'),
        h('ul', null, plan.quickWins.map((id) => h('li', null, h('button', { class: 'link', on: { click: () => SEC.go('findings', id) } }, byId.get(id).title))))
      )
    );
  let current = 0;
  for (const item of plan.items) {
    if (item.priority !== current) {
      current = item.priority;
      box.append(h('h3', { class: 'sec-group' }, 'Priority ' + current), h('div', { class: 'sev-info' }, plan.priorities[current]));
    }
    box.append(
      h(
        'section',
        { class: 'card' },
        h('b', null, item.title),
        ' ',
        secBadge('conf', 'Effort: ' + item.effort),
        h('ul', null, item.actions.map((a) => h('li', null, a))),
        item.examples.map((e) => h('div', null, codeBlock(e), secCopyButton(e, 'Copy example'))),
        h('div', { class: 'sev-info' }, 'Covers: ', item.findingIds.map((id) => [h('button', { class: 'link', on: { click: () => SEC.go('findings', id) } }, byId.get(id).title), ' · ']))
      )
    );
  }
}

function secCoverage(box, report) {
  const cov = report.coverage;
  box.append(
    h('p', { class: 'sev-info' }, 'What was checked, what was skipped and why, and what a browser extension cannot test. A short list of findings only means something next to a long list of checks that actually ran.'),
    section(
      'Checks in this scan',
      table(
        ['Check', 'Result', 'Requests', 'Note'],
        cov.checks.map((c) => [c.title, secBadge(c.state === 'done' ? 'observed' : c.state === 'failed' ? 'high' : 'conf', SEC_STATE_LABEL[c.state]), c.requests, h('span', { class: 'sev-info' }, c.reason)])
      )
    ),
    section(
      'Not testable from a browser extension',
      h('ul', null, cov.notTestable.map((n) => h('li', null, h('b', null, n.title), '. ', n.reason, h('div', { class: 'sev-info' }, 'How to check: ' + n.how))))
    ),
    report.requestLog.length
      ? h('details', { class: 'card' }, h('summary', null, 'Every request this scan made (' + report.requestLog.length + ')'), table(['Method', 'Path', 'Result', 'Purpose'], report.requestLog.map((r) => [r.method, mono(r.path), r.status || r.note || '', r.purpose || ''])))
      : '',
    section('Limitations', h('ul', null, report.limitations.map((l) => h('li', null, l))))
  );
}

function secExport(box, report) {
  const md = DFSecReport.toMarkdown(report);
  const name = 'security-check-' + slug(new URL(report.target).host) + '-' + stamp();
  const D = SEC.disclosure;
  const included = new Set(D.include || report.findings.filter((f) => f.severity !== 'info' && f.status !== 'info').map((f) => f.id));
  const text = h('textarea', { rows: 14, 'aria-label': 'Disclosure message', spellcheck: 'true' });
  const regenerate = () => {
    D.include = [...included];
    D.text = DFSecReport.disclosureTemplate(report, { ...D, include: D.include });
    text.value = D.text;
  };
  text.addEventListener('input', () => (D.text = text.value));
  const field = (key, label, type = 'text') => h('label', { class: 'sec-filter' }, label, h('input', { type, value: D[key], on: { input: (e) => (D[key] = type === 'number' ? +e.target.value || 90 : e.target.value) } }));
  text.value = D.text || (regenerate(), D.text);

  box.append(
    DFOwnerSession.isUnlocked() && SEC.technicalSealed && SEC.technicalSealed === report.id
      ? h('div', { class: 'card' }, icon('owner', 14), ' Technical evidence for this scan is sealed in the ', h('button', { class: 'link', on: { click: () => show('owner') } }, 'Owner tab'), '. It is not part of this report or its exports.')
      : '',
    section(
      'Report',
      h('p', { class: 'sev-info' }, 'Cookie and storage values, tokens and credentials are never included: evidence uses names, masked prefixes and lengths only.'),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', on: { click: () => copy(md) } }, icon('copy', 14), ' Copy Markdown'),
        h('button', { on: { click: () => download(name + '.md', md, 'text/markdown') } }, icon('download', 14), ' Download .md'),
        h('button', { on: { click: () => download(name + '.json', JSON.stringify(report, null, 2), 'application/json') } }, icon('download', 14), ' Download .json'),
        h('button', { on: { click: async () => { await saveToWorkspace('security', 'Security check: ' + new URL(report.target).host, report); SEC.saved = true; } } }, icon('work', 14), ' Save to workspace')
      )
    ),
    section(
      'Responsible disclosure message',
      h('p', { class: 'sev-info' }, 'A starting point for telling a site owner. It states only what was observed and promises nothing you have not decided. Edit it freely before sending. If this is not your site, send it privately and give the owner time to fix things.'),
      h('div', { class: 'sec-toolbar' }, field('recipient', 'Recipient name'), field('sender', 'Your name'), field('contact', 'Your contact'), field('days', 'Days before any public mention', 'number')),
      h(
        'details',
        { class: 'card' },
        h('summary', null, 'Findings to include (' + included.size + ')'),
        report.findings.map((f) => h('label', { class: 'sec-ack' }, h('input', { type: 'checkbox', checked: included.has(f.id), on: { change: (e) => (e.target.checked ? included.add(f.id) : included.delete(f.id)) } }), ' ' + f.title + ' (' + SEC_SEV_TEXT[f.severity] + ')'))
      ),
      h('div', { class: 'row' }, h('button', { on: { click: () => { regenerate(); toast('Message regenerated from the fields above'); } } }, icon('retry', 14), ' Regenerate from fields')),
      text,
      h('div', { class: 'row' }, h('button', { class: 'primary', on: { click: () => copy(text.value) } }, icon('copy', 14), ' Copy message'), h('button', { on: { click: () => download(name + '-disclosure.txt', text.value, 'text/plain') } }, icon('download', 14), ' Download .txt'))
    )
  );
}

/* ---------- the tab ---------- */

registerTab('security', 'Security', async (v) => {
  const tab = await activeTab();
  const target = DFSecScan.classifyTarget(tab.url);
  const body = h('div');
  const intro = h(
    'details',
    { class: 'card intro', open: SEC.view === 'setup' && !SEC.report },
    h('summary', null, icon('security', 15), ' ', h('b', null, 'Website security assessment')),
    h('p', null, 'Finds missing protections and exposed files on sites you own or have permission to test, explains each in plain language, and shows how to fix it. Evidence is redacted by default.'),
    h(
      'ul',
      null,
      h('li', null, 'It only talks to the site in the open tab, using GET and HEAD without cookies, within a request budget you can see and lower.'),
      h('li', null, 'It never logs in, guesses passwords, sends attack payloads, crawls other sites or changes anything.'),
      h('li', null, 'Results are labelled Confirmed, Potential or Needs manual verification, and the report lists what was not checked.')
    )
  );
  v.append(intro);
  if (target.kind === 'unsupported') {
    v.append(emptyState('This page cannot be checked', target.reason));
    return;
  }
  SEC.target = target;
  v.append(body);
  // A report belongs to the site it was made for. After moving to another site, start from the
  // setup screen instead of showing results that look like they describe the new page.
  if (SEC.view === 'results' && SEC.report && !SEC.pinned) {
    try {
      if (new URL(SEC.report.target).origin !== target.origin) SEC.view = 'setup';
    } catch (_) {
      SEC.view = 'setup';
    }
  }

  const draw = () => {
    clear(body);
    SEC.progressUI = null;
    if (SEC.error) body.append(h('div', { class: 'card sev-error', role: 'alert' }, h('b', null, 'The scan could not run. '), SEC.error));
    if (SEC.view === 'running') body.append(secMakeProgress());
    else if (SEC.view === 'results' && SEC.report) {
      body.append(secResultsView());
    } else {
      body.append(
        h('div', { class: 'card' }, h('div', null, 'Target: ', mono(target.origin), ' ', secBadge(target.kind === 'local' ? 'observed' : 'review', target.kind === 'local' ? 'Local / training' : 'Public site'))),
        secSetupView(target),
        SEC.report ? h('button', { class: 'link', on: { click: () => { SEC.view = 'results'; draw(); } } }, 'Back to the last report') : ''
      );
    }
  };
  SEC.repaint = draw;
  const offOwner = DFOwnerSession.onChange(() => SEC.repaint && SEC.view === 'setup' && SEC.repaint());
  onLeave(() => {
    SEC.repaint = null;
    SEC.progressUI = null;
    offOwner();
  });
  // A saved report opened from the Workspace tab.
  if (DF.state.secReport) {
    const r = DFSecReport.validateReport(DF.state.secReport);
    DF.state.secReport = null;
    if (r) {
      SEC.report = r;
      SEC.saved = true;
      SEC.pinned = true; // opened on purpose from the Workspace: keep it even on another site
      SEC.view = 'results';
      SEC.tab = 'overview';
    } else SEC.error = 'That saved report was made by an older version of DevForge and cannot be displayed. Use the export in Workspace.';
  }
  draw();
}, { perTab: true });

registerCommand('security-check', 'Security: assess this site', () => show('security'), 'security headers cookies vulnerabilities');
