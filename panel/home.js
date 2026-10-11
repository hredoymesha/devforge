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
          h('li', null, 'Extra access (all sites, cookie flags) is optional and asked for only when a tool needs it.')
        ),
        h('div', { class: 'row' }, h('button', { on: { click: (e) => { DF.state.settings.seenWelcome = true; saveSettings(); e.target.closest('.home-welcome').remove(); } } }, 'Got it'))
      )
    );
  }

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
