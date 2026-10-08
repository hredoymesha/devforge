function issueTable(issues, onSel) {
  return issues.length
    ? table(
        ['Sev', 'Rule', 'Issue / fix', ''],
        issues.slice(0, 200).map((i) => [
          h('span', { class: 'sev-' + i.severity }, i.severity),
          i.rule,
          h(
            'div',
            null,
            i.message,
            i.fix ? h('div', { class: 'sev-info' }, 'Fix: ' + i.fix) : '',
            i.detail ? h('div', { class: 'mono sev-info' }, String(i.detail).slice(0, 160)) : '',
            i.snippet ? h('div', { class: 'mono sev-info' }, i.snippet) : ''
          ),
          i.h
            ? h(
                'button',
                {
                  on: {
                    click: async () => {
                      try {
                        const d = await call('select', i.h);
                        DF.state.h = d.h;
                        DF.state.info = d;
                        await call('highlight', i.h);
                      } catch (e) {
                        toast(e.message);
                      }
                    },
                  },
                },
                'Select'
              )
            : '',
        ])
      )
    : h('div', { class: 'empty sev-info' }, 'No issues found by these checks.');
}
registerTab('audit', 'Audit', async (v) => {
  const out = h('div');
  const run = (label, fn) => async () => {
    clear(out).append(loading(label));
    try {
      await fn(out);
    } catch (e) {
      clear(out).append(h('div', { class: 'card sev-error' }, e.message));
    }
  };
  v.append(
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'primary',
          on: {
            click: run('Auditing accessibility', async (o) => {
              const scope = DF.state.h && $('#aud-scope').value === 'sel' ? DF.state.h : null;
              const r = await call('accessibilityAudit', scope);
              clear(o).append(
                section(
                  `Accessibility - ${r.summary.error} errors, ${r.summary.warn} warnings (${r.checked} elements)`,
                  issueTable(r.issues),
                  h('div', { class: 'sev-info' }, 'Limits: ' + r.limits.join(' '))
                )
              );
            }),
          },
        },
        'Accessibility'
      ),
      h(
        'select',
        { id: 'aud-scope', 'aria-label': 'Scope' },
        h('option', { value: 'page' }, 'whole page'),
        h('option', { value: 'sel' }, 'selected element')
      ),
      h(
        'button',
        {
          on: {
            click: run('Measuring performance', async (o) => {
              const p = await call('performanceAudit');
              clear(o).append(
                section(
                  'Performance',
                  kv({
                    'DOM nodes': p.domCount,
                    'max depth': p.maxDepth,
                    resources: p.resourceCount,
                    timing: p.timing ? JSON.stringify(p.timing) : '-',
                    paints: JSON.stringify(p.paints),
                    'long tasks': p.longTasks,
                  }),
                  h('h2', null, 'Optimization suggestions'),
                  p.tips.length
                    ? h(
                        'ul',
                        null,
                        p.tips.map((t) => h('li', null, t))
                      )
                    : h('div', { class: 'sev-info' }, 'Nothing flagged.'),
                  table(
                    ['Type', 'Count', 'Transfer KB'],
                    Object.entries(p.byType).map(([k, x]) => [
                      k,
                      x.count,
                      Math.round(x.transfer / 1024),
                    ])
                  ),
                  p.slow.length
                    ? h(
                        'div',
                        null,
                        h('b', null, 'Slow resources'),
                        table(
                          ['URL', 'ms'],
                          p.slow.map((s) => [mono(s.url), s.ms])
                        )
                      )
                    : '',
                  h(
                    'div',
                    { class: 'row' },
                    h(
                      'button',
                      {
                        on: {
                          click: async () => {
                            try {
                              await call('observeLongTasks');
                              toast('Observing long tasks - interact, then run Performance again.');
                            } catch (e) {
                              toast(e.message);
                            }
                          },
                        },
                      },
                      'Start observing long tasks'
                    )
                  ),
                  h('div', { class: 'sev-info' }, p.note)
                )
              );
            }),
          },
        },
        'Performance'
      ),
      h(
        'button',
        {
          on: {
            click: run('Scanning security patterns', async (o) => {
              const s = await call('securityAudit');
              let hd = null;
              try {
                hd = await call('fetchHeaders');
              } catch (e) {
                hd = { error: e.message };
              }
              clear(o).append(
                section(
                  'Security (passive, pattern-based)',
                  issueTable(s.issues),
                  s.thirdPartyHosts.length
                    ? kv({ 'third-party script hosts': s.thirdPartyHosts.join(', ') })
                    : '',
                  kv({ CSP: s.csp }),
                  hd && !hd.error
                    ? h(
                        'div',
                        null,
                        h('h2', null, 'Response headers (HEAD ' + 'to page URL)'),
                        kv(hd.headers),
                        hd.issues.length
                          ? h(
                              'ul',
                              null,
                              hd.issues.map((i) => h('li', { class: 'sev-warn' }, i))
                            )
                          : h('div', { class: 'sev-info' }, 'Core headers present.')
                      )
                    : h(
                        'div',
                        { class: 'sev-info' },
                        'Header check unavailable: ' + (hd && hd.error)
                      ),
                  h('div', { class: 'sev-info' }, s.note)
                )
              );
            }),
          },
        },
        'Security'
      ),
      h(
        'button',
        {
          on: {
            click: run('Reading scripts', async (o) => {
              const s = await call('scriptsInfo');
              clear(o).append(
                section(
                  'JavaScript',
                  table(
                    ['#', 'Kind', 'Source / size', 'Minified?'],
                    s.scripts.map((x) => [
                      x.index,
                      x.kind + (x.module ? ' (module)' : ''),
                      mono(x.src || x.size + ' chars'),
                      x.minified && x.minified.provenance
                        ? [String(x.minified.value), ' ', tagEl(x.minified.provenance)]
                        : '',
                    ])
                  ),
                  kv({
                    'inline source': s.availability.inlineSource,
                    'external source': s.availability.externalSource,
                    'server-side': s.availability.serverSide,
                  }),
                  s.scripts
                    .filter((x) => x.preview)
                    .slice(0, 5)
                    .map((x) =>
                      h(
                        'details',
                        null,
                        h('summary', null, 'inline #' + x.index),
                        codeBlock(x.preview)
                      )
                    )
                )
              );
            }),
          },
        },
        'Scripts'
      ),
      h(
        'button',
        {
          on: {
            click: run('Checking responsiveness', async (o) => {
              const r = await call('responsiveReport');
              clear(o).append(
                section(
                  'Responsive (at current viewport)',
                  kv({
                    'viewport width': r.viewportWidth,
                    'scroll width': r.scrollWidth,
                    'horizontal overflow': r.horizontalOverflow,
                    'viewport meta': r.viewportMeta,
                    'breakpoints in readable CSS': r.breakpointsInCss.join(', ') || 'none',
                  }),
                  r.overflowing.length
                    ? table(
                        ['Element', 'Right edge', 'Width', ''],
                        r.overflowing.map((x) => [
                          mono(x.el),
                          x.right,
                          x.width,
                          h('button', { on: { click: () => call('highlight', x.h) } }, 'Show'),
                        ])
                      )
                    : '',
                  h('div', { class: 'sev-info' }, r.note),
                  h(
                    'div',
                    { class: 'row' },
                    [375, 768, 1024, 1440].map((w) =>
                      h(
                        'button',
                        {
                          on: {
                            click: async () => {
                              const t = await activeTab();
                              const win = await chrome.windows.get(t.windowId);
                              await chrome.windows.update(t.windowId, {
                                state: 'normal',
                                width: w + (win.width - (await exec(() => innerWidth))),
                              });
                              toast('Window resized for ' + w + 'px viewport; run again.');
                            },
                          },
                        },
                        w + 'px'
                      )
                    )
                  )
                )
              );
            }),
          },
        },
        'Responsive'
      )
    ),
    h(
      'div',
      { class: 'sev-info' },
      'All checks run locally on demand. Nothing runs in the background.'
    ),
    out
  );
});
