registerTab('css', 'CSS', async (v) => {
  if (!DF.state.h) {
    v.append(needsSelection());
    return;
  }
  v.append(loading('Analyzing CSS'));
  let c;
  try {
    c = await call('css', DF.state.h);
  } catch (e) {
    clear(v).append(h('div', { class: 'card sev-error' }, e.message));
    return;
  }
  clear(v);
  v.append(
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'mono' }, DF.state.info.selectors[0].selector),
      c.confidence.provenance ? tagEl('observed') : '',
      h(
        'span',
        { class: 'sev-info' },
        c.confidence.value + (c.confidence.note ? ' - ' + c.confidence.note : '')
      )
    )
  );
  if (c.blockedSheets.length)
    v.append(
      h(
        'div',
        { class: 'card' },
        h('b', { class: 'sev-warn' }, c.blockedSheets.length + ' unreadable stylesheet(s)'),
        c.blockedSheets.map((b) => h('div', { class: 'mono sev-info' }, b.source)),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            { on: { click: () => fetchBlocked(c.blockedSheets) } },
            'Fetch & show them (asks for site permission)'
          )
        )
      )
    );
  /* edit */
  const undoState = h('span', { class: 'sev-info', id: 'hist' });
  const refreshHist = async () => {
    try {
      const hi = await call('history');
      undoState.textContent = `${hi.undo} change(s), ${hi.redo} redoable`;
    } catch (_) {}
  };
  const prop = h('input', {
      class: 'grow',
      placeholder: 'property (e.g. color)',
      list: 'cssprops',
      'aria-label': 'CSS property',
    }),
    val = h('input', { class: 'grow', placeholder: 'value', 'aria-label': 'CSS value' });
  const doEdit = async (spec) => {
    try {
      await call('edit', spec);
      await refreshHist();
      toast('Applied (live preview, not saved to the site)');
    } catch (e) {
      toast(e.message);
    }
  };
  v.append(
    section(
      'Live edit',
      h(
        'div',
        { class: 'row' },
        prop,
        val,
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: () =>
                prop.value &&
                doEdit({ kind: 'style', prop: prop.value.trim(), value: val.value.trim() }),
            },
          },
          'Apply'
        )
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: async () => {
                try {
                  await call('undo');
                  await refreshHist();
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          '↶ Undo'
        ),
        h(
          'button',
          {
            on: {
              click: async () => {
                try {
                  await call('redo');
                  await refreshHist();
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          '↷ Redo'
        ),
        h(
          'button',
          {
            class: 'danger',
            on: {
              click: async () => {
                await call('resetAll');
                await refreshHist();
                toast('All changes reverted');
              },
            },
          },
          'Reset all'
        ),
        undoState
      )
    )
  );
  const ov = h('textarea', {
    rows: 5,
    placeholder:
      '/* override stylesheet: add or override rules, e.g.\n.btn { background: hotpink !important; } */',
    'aria-label': 'Override CSS',
  });
  v.append(
    section(
      'Override stylesheet',
      ov,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { on: { click: () => doEdit({ kind: 'css-rule', value: ov.value }) } },
          'Apply override'
        ),
        h(
          'span',
          { class: 'sev-info' },
          'Validated before applying. Only affects this tab until reload.'
        )
      )
    )
  );
  /* rules */
  const winners = c.winners;
  v.append(
    section(
      'Matched rules (' + c.rules.length + ')',
      c.rules.length
        ? c.rules
            .slice()
            .sort((a, b) => b.order - a.order)
            .map((r) =>
              h(
                'div',
                { class: 'card' },
                h(
                  'div',
                  { class: 'mono' },
                  r.selector,
                  ' ',
                  h('span', { class: 'tag' }, 'spec ' + r.specificity)
                ),
                h(
                  'div',
                  { class: 'sev-info mono' },
                  r.source + (r.context.length ? ' · ' + r.context.join(' · ') : '')
                ),
                h(
                  'div',
                  { class: 'mono' },
                  r.declarations.map((d) => {
                    const win =
                      winners[d.prop] &&
                      winners[d.prop].from === r.selector &&
                      winners[d.prop].value === d.value;
                    return h(
                      'div',
                      {
                        style: {
                          textDecoration: win ? 'none' : 'line-through',
                          opacity: win ? 1 : 0.55,
                        },
                        title: win ? 'wins the cascade' : 'overridden (or not winning)',
                      },
                      d.prop + ': ' + d.value + (d.important ? ' !important' : '') + ';'
                    );
                  })
                )
              )
            )
        : h(
            'div',
            { class: 'empty' },
            'No readable stylesheet rules match (styles may be inline, in a blocked sheet, or injected via adopted stylesheets).'
          )
    )
  );
  if (c.inline.length)
    v.append(
      section('Inline style', codeBlock(c.inline.map((d) => `${d.prop}: ${d.value};`).join('\n')))
    );
  if (Object.keys(c.variables).length)
    v.append(
      section(
        'CSS variables used',
        table(
          ['Variable', 'Resolved value'],
          Object.entries(c.variables).map(([k, x]) => [mono(k), mono(x || '(empty)')])
        )
      )
    );
  if (Object.keys(c.inherited).length)
    v.append(
      section(
        'Inherited',
        table(
          ['Property', 'Value', 'From'],
          Object.entries(c.inherited).map(([k, x]) => [k, x.value, x.inheritedFrom])
        )
      )
    );
  v.append(
    section(
      'Fonts',
      kv({
        stack: c.fonts.stack.join(', '),
        '@font-face': c.fonts.fontFaceRules.length
          ? c.fonts.fontFaceRules.map((f) => f.family + ' ' + f.weight).join(', ')
          : 'none readable',
        loaded: c.fonts.loadedFaces.map((f) => f.family + ' ' + f.weight).join(', ') || '-',
      })
    )
  );
  if (c.keyframes.length)
    v.append(
      section(
        'Keyframes',
        c.keyframes.map((k) => codeBlock(k.css))
      )
    );
  v.append(
    section(
      'Pseudo-state preview',
      h(
        'div',
        { class: 'row' },
        ['hover', 'focus', 'active'].map((s) =>
          h(
            'button',
            {
              on: {
                click: async () => {
                  const r = await call('forceState', DF.state.h, s, true);
                  if (r.applied) {
                    ov.value = (ov.value ? ov.value + '\n' : '') + r.css;
                    toast('Added :' + s + ' declarations to the override box. Press Apply.');
                  } else toast(r.note);
                },
              },
            },
            ':' + s
          )
        )
      ),
      h(
        'div',
        { class: 'sev-info' },
        'Emulated by copying :state declarations into the override stylesheet (true state forcing needs the debugger permission, which DevForge does not request).'
      )
    )
  );
  v.append(
    section(
      'Computed styles',
      h(
        'div',
        { class: 'row' },
        h('input', {
          class: 'grow',
          placeholder: 'filter…',
          'aria-label': 'Filter computed',
          on: {
            input: (e) => {
              const q = e.target.value.toLowerCase();
              for (const r of $('#comp').rows) r.hidden = !r.cells[0].textContent.includes(q);
            },
          },
        }),
        h(
          'button',
          {
            on: {
              click: async () =>
                download(
                  'computed-' + stamp() + '.json',
                  JSON.stringify(await call('computedAll', DF.state.h), null, 2),
                  'application/json'
                ),
            },
          },
          'Export JSON'
        )
      ),
      h(
        'div',
        { id: 'comp-wrap', style: { maxHeight: '260px', overflow: 'auto' } },
        h(
          'button',
          {
            on: {
              click: async (e) => {
                const all = await call('computedAll', DF.state.h);
                const t = table(
                  ['Property', 'Value'],
                  Object.entries(all).map(([k, x]) => [k, mono(x)])
                );
                t.id = 'comp';
                clear($('#comp-wrap')).append(t);
              },
            },
          },
          'Show all computed properties'
        )
      )
    )
  );
  /* export css */
  v.append(
    section(
      'Export',
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: async () => {
                const x = await call('collectComponent', DF.state.h);
                copy(x.css);
              },
            },
          },
          'Copy component CSS'
        ),
        h(
          'button',
          {
            on: {
              click: async () => {
                const p = await call('patch');
                if (!p.count) return toast('No changes to export');
                download('devforge-patch-' + stamp() + '.css', p.patch, 'text/css');
              },
            },
          },
          'Export change patch'
        )
      )
    )
  );
  const hi = await call('history');
  undoState.textContent = `${hi.undo} change(s), ${hi.redo} redoable`;
  if (hi.log.length)
    v.append(
      section(
        'Change log',
        table(
          ['When', 'Kind', 'Target', 'Before → After'],
          hi.log
            .slice()
            .reverse()
            .map((l) => [
              new Date(l.t).toLocaleTimeString(),
              l.kind,
              mono(l.selector || ''),
              mono(
                (l.prop ? l.prop + ': ' : '') +
                  (l.before == null ? '' : l.before) +
                  ' → ' +
                  (l.after == null ? '' : l.after)
              ),
            ])
        )
      )
    );
  v.append(
    h(
      'datalist',
      { id: 'cssprops' },
      [
        'color',
        'background',
        'background-color',
        'font-size',
        'font-weight',
        'font-family',
        'margin',
        'padding',
        'border',
        'border-radius',
        'display',
        'position',
        'width',
        'height',
        'opacity',
        'box-shadow',
        'transform',
        'gap',
        'flex',
        'grid-template-columns',
        'text-align',
        'visibility',
      ].map((p) => h('option', { value: p }))
    )
  );
});
async function fetchBlocked(blocked) {
  const urls = blocked.map((b) => b.source).filter((s) => /^https?:/.test(s));
  const perm = await ensureOrigins(urls);
  const out = [];
  for (const u of urls) {
    try {
      const { bytes } = await fetchBytes(u);
      out.push(`/* ${u} */\n` + new TextDecoder().decode(bytes));
    } catch (e) {
      out.push(
        `/* ${u}: ${e.message} (${perm.denied.length ? 'site permission was not granted' : 'fetch failed'}) */`
      );
    }
  }
  const v = $('#view');
  v.append(
    section(
      'Fetched stylesheets (source text, not matched)',
      ...out.map((o) => codeBlock(o.slice(0, 20000)))
    )
  );
}
