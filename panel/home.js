// Home: a starting point that makes the main tools easy to find. It shows whether DevForge can
// work on the current page, one-click entry points for common jobs, and recent Workspace items.

const HOME_TILES = [
  { icon: 'pick', title: 'Inspect an element', text: 'Pick anything on the page for its selectors, styles, box model and accessibility info.', run: () => pickNow() },
  { icon: 'security', title: 'Check site security', text: 'A guided, evidence-based assessment of headers, cookies, exposed files and risky code.', run: () => show('security') },
  { icon: 'network', title: 'Watch network traffic', text: 'Record fetch, XHR and WebSocket calls, then mock, delay or replay them.', run: async () => { show('network'); await startCapture(); toast('Network capture on'); } },
  { icon: 'perf', title: 'Measure performance', text: 'Core Web Vitals with the element behind each slow metric.', run: () => show('perf') },
  { icon: 'mutations', title: 'Track DOM changes', text: 'A timeline of what changed on the page, with old and new values.', run: () => show('mutations') },
  { icon: 'tokens', title: 'Extract design tokens', text: 'Colours, type scale and spacing as CSS variables, SCSS or JSON.', run: () => show('tokens') },
  { icon: 'export', title: 'Export or screenshot', text: 'Copy a component as code, or capture an element or the full page.', run: () => show('export') },
  { icon: 'site', title: 'Save a site snapshot', text: 'Detect the stack and save the files the page uses, with source maps.', run: () => show('site') },
  { icon: 'play', title: 'Prototype a change', text: 'Try new styles on the live page with a visual dashboard or code, without editing the site.', run: () => show('proto') },
  { icon: 'tokens', title: 'Check colour contrast', text: 'WCAG ratios for any two colours, or every text colour on the page.', run: () => show('tokens') },
  { icon: 'export', title: 'Export a page bundle', text: 'Pick HTML, scripts, styles, source maps, storage and more, as one ZIP or separate files.', run: () => show('export') },
];

const HOME_KIND_ICON = { security: 'security', element: 'inspect', component: 'export', screenshot: 'export', data: 'data', workflow: 'auto', playground: 'play', 'ai-task': 'ai', recreation: 'recreate' };

function homeTile(t) {
  return h(
    'button',
    { class: 'home-tile', on: { click: t.run } },
    h('span', { class: 'home-tile-icon' }, icon(t.icon, 18)),
    h('span', { class: 'home-tile-body' }, h('b', null, t.title), h('span', null, t.text))
  );
}


// The status cards at the top of Home. Each is independent: one failing does not hide the others.
async function homeGlance(box) {
  const card = (id, title, ...body) => h('div', { class: 'card home-card', id }, h('b', null, title), ...body);
  const cards = [];
  const s = DF.state.settings;
  const add = async (fn) => {
    try {
      cards.push(await fn());
    } catch (e) {
      cards.push(card('home-card-err', 'Unavailable', h('div', { class: 'sev-info' }, e.message)));
    }
  };

  await add(async () => {
    const all = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    const n = (s.siteAllowlist || []).length;
    // In limited mode the page in front can be allowed with one click. The click is the request, so
    // nothing is granted by a page or by a timer.
    // Read the tab without activeTab(), which also changes the page DevForge is working on.
    const tab = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((list) => list[0] || null, () => null);
    const origin = tab ? DFSiteAccess.originOf(tab.url) : null;
    const offered = s.allowAllSites === false && origin && !(s.siteAllowlist || []).includes(origin);
    return card(
      'home-card-access',
      'Site access',
      h('div', { class: s.allowAllSites !== false ? 'sev-ok' : 'sev-warn' }, s.allowAllSites !== false ? 'All sites allowed' : 'Limited to ' + n + ' site' + (n === 1 ? '' : 's')),
      h('div', { class: 'sev-info' }, all ? 'Chrome grants DevForge all-sites access.' : 'Chrome limits DevForge to sites chosen in its extension settings.'),
      offered ? h('div', { class: 'sev-info' }, 'The page in front (' + origin + ') is not on your list.') : null,
      h(
        'div',
        { class: 'row' },
        offered
          ? h(
              'button',
              {
                id: 'home-allow-site',
                class: 'primary',
                on: {
                  click: () => {
                    s.siteAllowlist = [...new Set([...(s.siteAllowlist || []), origin])];
                    saveSettings();
                    toast('Allowed ' + origin);
                    show('home');
                  },
                },
              },
              'Allow this site'
            )
          : null,
        h('button', { class: 'sec-mini', on: { click: () => show('settings') } }, 'Change')
      )
    );
  });

  await add(async () => {
    const exists = await DFOwnerSession.exists();
    const open = DFOwnerSession.isUnlocked();
    const ago = DFOwnerSession.verifiedAgoMs();
    return card(
      'home-card-owner',
      'Owner session',
      h('div', { class: open ? 'sev-ok' : exists ? 'sev-warn' : 'sev-info' }, !exists ? 'Not set up' : open ? 'Unlocked' : 'Locked'),
      h('div', { class: 'sev-info' }, !exists ? 'Optional: protects sealed diagnostics and the Workspace with a passphrase.' : open ? 'Confirmed ' + (ago < 60000 ? 'just now' : Math.round(ago / 60000) + ' min ago') + '. Locks after ' + DFOwnerSession.idleMinutes() + ' min idle.' : 'Unlock to read sealed data. The panel keeps working without it.'),
      h('div', { class: 'row' }, h('button', { class: 'sec-mini', on: { click: () => show('owner') } }, !exists ? 'Set up' : open ? 'Manage' : 'Unlock'))
    );
  });

  await add(async () => {
    let origin = '';
    try {
      origin = new URL(DF.state.url).origin;
    } catch (_) {
      /* no page address yet */
    }
    const scans = origin
      ? (await DFStore.allItems())
          .filter((i) => i.kind === 'security' && !i.locked && i.payload && i.payload.version === 2 && secOriginOf(i.payload) === origin)
          .sort((a, b) => String(b.payload.scannedAt).localeCompare(String(a.payload.scannedAt)))
      : [];
    if (!scans.length) return card('home-card-sec', 'Security of this site', h('div', { class: 'sev-info' }, 'No saved scan for this site yet.'), h('div', { class: 'row' }, h('button', { class: 'sec-mini', on: { click: () => show('security') } }, 'Run a check')));
    const last = scans[0].payload;
    const t = scans[1] ? DFDiff.compareReports(scans[1].payload, last) : null;
    const high = last.findings.filter((f) => f.severity === 'high').length;
    return card(
      'home-card-sec',
      'Security of this site',
      h('div', { class: high ? 'sev-error' : 'sev-ok' }, last.findings.length + ' finding(s)' + (high ? ', ' + high + ' high' : '')),
      h('div', { class: 'sev-info' }, 'Last scan ' + new Date(last.scannedAt).toLocaleDateString() + (t ? '. ' + t.message : '. Scan again later to see a trend.')),
      h('div', { class: 'row' }, h('button', { class: 'sec-mini', on: { click: () => { DF.state.secReport = last; show('security'); } } }, 'Open last report'))
    );
  });

  await add(async () => {
    const all = await DFKeep.readPerf();
    const pts = all[DFKeep.keyFor(DFPerfHist.keyFor(DF.state.url))] || [];
    const sum = DFPerfHist.summary(pts, 'lcp');
    return card(
      'home-card-perf',
      'Performance of this page',
      sum ? h('div', { class: sum.rating === 'good' ? 'sev-ok' : sum.rating === 'poor' ? 'sev-error' : 'sev-warn' }, 'LCP ' + fmtMs(sum.latest)) : h('div', { class: 'sev-info' }, 'No readings yet.'),
      h('div', { class: 'sev-info' }, sum ? sum.n + ' check(s)' + (sum.delta != null ? ', ' + fmtMs(Math.abs(sum.delta)) + (sum.delta <= 0 ? ' faster' : ' slower') + ' than the previous one' : '') + '.' : 'Open the Perf tab to take a first reading.'),
      h('div', { class: 'row' }, h('button', { class: 'sec-mini', on: { click: () => show('perf') } }, 'Open Perf'))
    );
  });

  await add(async () => {
    const u = await DFKeep.usage();
    return card('home-card-data', 'Stored on this device', h('div', null, u.itemCount + ' Workspace item(s), ' + fmtBytes(u.itemBytes + u.localBytes)), h('div', { class: 'sev-info' }, u.autoSavedScans + ' automatically saved scan(s), ' + u.perfPoints + ' performance reading(s). Nothing leaves this browser.'), h('div', { class: 'row' }, h('button', { class: 'sec-mini', on: { click: () => show('settings') } }, 'Clean up')));
  });

  clear(box).append(...cards);
}

registerTab('home', 'Home', async (v) => {
  const status1 = h('div', { class: 'home-status', role: 'status' }, 'Checking this page…');
  v.append(
    h(
      'div',
      { class: 'home-hero' },
      h('h2', null, 'What would you like to do?'),
      h('p', { class: 'sev-info' }, 'DevForge works on the page in your active tab. Nothing leaves your browser.'),
      status1
    )
  );

  // Whether DevForge can reach this page right now (activeTab access, restricted pages, file URLs).
  (async () => {
    try {
      const tab = await activeTab();
      await exec(() => location.href);
      let host = tab.url;
      try {
        host = new URL(tab.url).host || tab.url;
      } catch (_) {
        /* keep the raw address */
      }
      clear(status1).append(icon('check', 14), ' Ready on ', mono(host.slice(0, 60)));
      status1.className = 'home-status sev-ok';
    } catch (e) {
      clear(status1).append(icon('alert', 14), ' ' + e.message);
      status1.className = 'home-status sev-warn';
    }
  })();

  if (!DF.state.settings.seenWelcome) {
    v.append(
      h(
        'div',
        { class: 'card intro home-welcome' },
        h('b', null, 'Welcome to DevForge'),
        h(
          'ul',
          null,
          h('li', null, 'Tools run only when you use them, and only on the tab you opened DevForge on.'),
          h('li', null, 'Press Ctrl+K for the command palette, or Ctrl+Shift+U to pick an element.'),
          h('li', null, 'DevForge can work on all sites by default. Settings → Site access limits it to the sites you choose.')
        ),
        h('div', { class: 'row' }, h('button', { on: { click: (e) => { DF.state.settings.seenWelcome = true; saveSettings(); e.target.closest('.home-welcome').remove(); } } }, 'Got it'))
      )
    );
  }

  const glance = h('div', { class: 'home-glance', id: 'home-glance' });
  v.append(section('At a glance', glance));
  homeGlance(glance).catch((e) => clear(glance).append(h('div', { class: 'sev-info' }, 'Dashboard unavailable: ' + e.message)));

  v.append(h('div', { class: 'home-grid' }, HOME_TILES.map(homeTile)));

  // Recent Workspace items. A saved security report reopens in its own tab.
  const recentBox = h('div');
  v.append(section('Recent in Workspace', recentBox));
  try {
    const items = (await DFStore.allItems()).sort((a, b) => b.created - a.created).slice(0, 5);
    if (!items.length) {
      recentBox.append(emptyState('Nothing saved yet', 'Save elements, screenshots, data and security reports from their tabs and they will show up here.'));
    } else {
      recentBox.append(
        h(
          'ul',
          { class: 'home-recent' },
          items.map((it) =>
            h(
              'li',
              null,
              h(
                'button',
                {
                  class: 'link',
                  on: {
                    click: () => {
                      if (it.kind === 'security' && it.payload && it.payload.version === 2) {
                        DF.state.secReport = it.payload;
                        show('security');
                      } else show('work');
                    },
                  },
                },
                icon(HOME_KIND_ICON[it.kind] || 'work', 14),
                ' ',
                it.title
              ),
              h('span', { class: 'sev-info' }, ' · ' + new Date(it.created).toLocaleDateString())
            )
          )
        )
      );
    }
  } catch (e) {
    recentBox.append(h('div', { class: 'sev-info' }, 'Workspace is unavailable: ' + e.message));
  }
});
