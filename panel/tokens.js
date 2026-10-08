// Tokens tab: reverse-engineers a design system from computed styles (agent/tokens.js) and exports
// it as CSS variables, SCSS, W3C design-token JSON or a Tailwind theme (lib/tokens.js).
const tokS = { raw: null, minCount: 2 };

function tokenExport(fmt) {
  if (!tokS.raw) throw new Error('Scan the page first.');
  const t = DFTokens.build(tokS.raw, { minCount: tokS.minCount });
  const f = {
    css: ['tokens.css', DFTokens.toCss(t), 'text/css'],
    scss: ['_tokens.scss', DFTokens.toScss(t), 'text/x-scss'],
    json: ['tokens.json', DFTokens.toJson(t), 'application/json'],
    tailwind: ['tailwind.tokens.js', DFTokens.toTailwind(t), 'text/javascript'],
  }[fmt];
  return { name: f[0], text: f[1], type: f[2] };
}

function renderTokens(box) {
  clear(box);
  const raw = tokS.raw;
  if (!raw) return;
  const t = DFTokens.build(raw, { minCount: tokS.minCount });
  const preview = h('div');
  box.append(
    h(
      'div',
      { class: 'sev-info' },
      `${raw.scanned} visible elements scanned (${raw.scope}). Values used fewer than ${tokS.minCount} time(s) are left out of the token set.`
    ),
    section(
      `Colors (${t.colors.length})`,
      t.colors.length
        ? h(
            'div',
            { class: 'swatches' },
            t.colors.map((c) => {
              const onWhite = DFTokens.contrast(c.value.slice(0, 7), '#ffffff');
              const onBlack = DFTokens.contrast(c.value.slice(0, 7), '#000000');
              return h(
                'button',
                {
                  class: 'sw',
                  title:
                    `${c.value} · used ${c.count}× (${Object.entries(c.roles)
                      .map(([r, n]) => r + ' ' + n)
                      .join(', ')})` +
                    (onWhite ? `\ncontrast on white ${onWhite}:1, on black ${onBlack}:1` : '') +
                    '\nClick to copy',
                  on: { click: () => copy(c.value) },
                },
                h('i', { style: { background: c.value } }),
                h('span', { class: 'mono' }, c.name),
                h('span', { class: 'mono sev-info' }, c.value)
              );
            })
          )
        : h('div', { class: 'sev-info' }, 'No repeated colors.')
    ),
    section(
      'Typography',
      t.fontFamilies.length
        ? table(
            ['Token', 'Family', 'Uses'],
            t.fontFamilies.map((f) => [
              mono(f.name),
              h('span', { style: { fontFamily: f.value } }, f.value),
              f.count,
            ]),
            { class: 'compact' }
          )
        : '',
      h(
        'div',
        { class: 'type-scale' },
        t.fontSizes.map((s) =>
          h(
            'div',
            { class: 'ts-row' },
            h('span', { class: 'mono sev-info' }, s.value),
            h(
              'span',
              { class: 'ts-sample', style: { fontSize: `min(${s.value}, 40px)` } },
              'Aa Quick fox'
            ),
            h('span', { class: 'sev-info' }, s.count + '×')
          )
        )
      ),
      kv({
        weights: t.fontWeights.map((w) => `${w.value} (${w.count})`).join(', ') || '–',
        'line heights': t.lineHeights.map((w) => `${w.value} (${w.count})`).join(', ') || '–',
      })
    ),
    section(
      `Spacing (${t.spacing.length})`,
      h(
        'div',
        { class: 'space-scale' },
        t.spacing.map((s) =>
          h(
            'div',
            { class: 'sp-row' },
            h('span', { class: 'mono' }, s.value),
            h('i', { style: { width: `min(${s.value}, 100%)` } }),
            h('span', { class: 'sev-info' }, s.count + '×')
          )
        )
      ),
      t.spacing.length && t.spacing.every((s) => parseFloat(s.value) % 4 === 0)
        ? h('div', { class: 'sev-ok' }, 'All spacing values sit on a 4px grid.')
        : t.spacing.length
          ? h(
              'div',
              { class: 'sev-info' },
              'Off the 4px grid: ' +
                t.spacing
                  .filter((s) => parseFloat(s.value) % 4)
                  .map((s) => s.value)
                  .join(', ')
            )
          : ''
    ),
    section(
      'Radii & shadows',
      h(
        'div',
        { class: 'row' },
        t.radii.map((r) =>
          h(
            'span',
            { class: 'radius-demo', style: { borderRadius: r.value }, title: r.count + '×' },
            r.value
          )
        )
      ),
      h(
        'div',
        { class: 'shadows' },
        t.shadows.map((s) =>
          h(
            'div',
            {
              class: 'shadow-demo',
              style: { boxShadow: s.value },
              title: s.value + ' · ' + s.count + '×',
            },
            s.count + '×'
          )
        )
      )
    ),
    raw.variables.length
      ? h(
          'details',
          null,
          h('summary', null, `Custom properties on :root (${raw.variables.length})`),
          table(
            ['Name', 'Declared', 'Resolved'],
            raw.variables.map((x) => [mono(x.name), mono(x.declared), mono(x.resolved)]),
            { class: 'compact' }
          )
        )
      : '',
    section(
      'Export',
      h(
        'div',
        { class: 'row' },
        [
          ['css', 'CSS variables'],
          ['scss', 'SCSS'],
          ['json', 'Design tokens JSON'],
          ['tailwind', 'Tailwind theme'],
        ].map(([fmt, label]) =>
          h(
            'button',
            {
              on: {
                click: () => {
                  const f = tokenExport(fmt);
                  clear(preview).append(
                    h(
                      'div',
                      { class: 'row' },
                      h('b', { class: 'grow' }, f.name),
                      h('button', { on: { click: () => copy(f.text) } }, 'Copy'),
                      h(
                        'button',
                        { class: 'primary', on: { click: () => download(f.name, f.text, f.type) } },
                        'Download'
                      )
                    ),
                    codeBlock(f.text)
                  );
                },
              },
            },
            label
          )
        )
      ),
      preview
    )
  );
}

registerTab('tokens', 'Tokens', async (v) => {
  const box = h('div');
  const scope = h(
    'select',
    { 'aria-label': 'Scope' },
    h('option', { value: 'page' }, 'whole page'),
    h('option', { value: 'sel', disabled: !DF.state.h }, 'selected element')
  );
  const min = h(
    'select',
    { 'aria-label': 'Minimum uses' },
    [1, 2, 3, 5].map((n) =>
      h('option', { value: n, selected: n === tokS.minCount }, `used ≥ ${n}×`)
    )
  );
  min.addEventListener('change', () => {
    tokS.minCount = +min.value;
    renderTokens(box);
  });
  const scan = async () => {
    clear(box).append(loading('Reading computed styles'));
    tokS.raw = await call('designTokens', scope.value === 'sel' ? DF.state.h : null);
    renderTokens(box);
  };
  v.append(
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'primary', on: { click: scan } }, 'Scan design tokens'),
      scope,
      min
    ),
    h(
      'div',
      { class: 'sev-info' },
      'Collects the colors, type scale, spacing, radii and shadows this page actually renders, and turns them into a token set you can drop into a project.'
    ),
    box
  );
  if (tokS.raw) renderTokens(box);
  else
    box.append(emptyState('No scan yet', 'Scan to extract the design system in use on this page.'));
});
