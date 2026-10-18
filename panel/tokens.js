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
    t.colors.length > 1 ? section('Palette contrast (text row on background column)', paletteMatrix(t.colors)) : '',
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


/* ---------- colour readability ---------- */
const tokContrast = { fg: '#1a1a1a', bg: '#ffffff', level: 'AA', scan: null };
const contrastBadge = (ok, label) => h('span', { class: 'sec-badge ' + (ok ? 'sec-observed' : 'sec-high') }, (ok ? '✓ ' : '✕ ') + label);

function apcaAdvice(lc) {
  const a = Math.abs(lc);
  if (a >= 90) return 'Lc ' + lc + ': very high; fine for thin or small text.';
  if (a >= 75) return 'Lc ' + lc + ': suitable for body text.';
  if (a >= 60) return 'Lc ' + lc + ': fine for larger or bold text (about 18px and up); too low for small body text.';
  if (a >= 45) return 'Lc ' + lc + ': only for large headings (about 36px or 24px bold).';
  if (a >= 30) return 'Lc ' + lc + ': for non-text details only.';
  return 'Lc ' + lc + ': too low for readable text.';
}

function contrastChecker() {
  const out = h('div', { id: 'tok-contrast-out', role: 'status', 'aria-live': 'polite' });
  const fg = h('input', { type: 'text', id: 'tok-fg', value: tokContrast.fg, 'aria-label': 'Text colour', class: 'mono' });
  const bg = h('input', { type: 'text', id: 'tok-bg', value: tokContrast.bg, 'aria-label': 'Background colour', class: 'mono' });
  const fgPick = h('input', { type: 'color', 'aria-label': 'Pick text colour', value: '#1a1a1a' });
  const bgPick = h('input', { type: 'color', 'aria-label': 'Pick background colour', value: '#ffffff' });
  const draw = () => {
    tokContrast.fg = fg.value;
    tokContrast.bg = bg.value;
    const f = DFContrast.parse(fg.value);
    const b = DFContrast.parse(bg.value);
    clear(out);
    if (!f || !b) {
      out.append(h('div', { class: 'sev-info' }, 'Enter colours as #rgb, #rrggbb or rgb(…). Translucent text is blended with the background first.'));
      return;
    }
    if (/^#[0-9a-f]{6}$/i.test(fg.value.trim())) fgPick.value = fg.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(bg.value.trim())) bgPick.value = bg.value.trim();
    const bgSolid = b.a < 1 ? DFContrast.over(b, { r: 255, g: 255, b: 255, a: 1 }) : b;
    const r = DFContrast.ratio(f, bgSolid);
    const g = DFContrast.grade(DFContrast.exact(f, bgSolid));
    const lc = DFContrast.apca(f.a < 1 ? DFContrast.over(f, bgSolid) : f, bgSolid);
    const fix = (target) => {
      const s = DFContrast.suggest(f, bgSolid, target);
      return s && s.changed
        ? h('div', null, 'Nearest text colour for ' + target + ':1 → ', h('button', { class: 'link mono', on: { click: () => { fg.value = s.hex; draw(); } } }, s.hex), ' (' + s.ratio + ':1) ', h('button', { class: 'sec-mini', on: { click: () => copy(s.hex) } }, 'Copy'))
        : s
          ? ''
          : h('div', { class: 'sev-info' }, 'No text colour of this hue reaches ' + target + ':1 on this background. Change the background.');
    };
    out.append(
      h('div', { class: 'tok-ratio', style: { color: g.aaNormal ? 'var(--ok)' : g.aaLarge ? 'var(--warn)' : 'var(--err)' } }, r + ':1'),
      h('div', { class: 'row' }, contrastBadge(g.aaNormal, 'AA text (4.5)'), contrastBadge(g.aaLarge, 'AA large text (3)'), contrastBadge(g.aaaNormal, 'AAA text (7)'), contrastBadge(g.aaaLarge, 'AAA large text (4.5)'), contrastBadge(g.ui, 'Icons & borders (3)')),
      h('div', { class: 'sev-info' }, 'APCA (draft WCAG 3, for information): ' + apcaAdvice(lc)),
      h('div', { class: 'tok-sample', style: { background: bg.value, color: fg.value } }, h('div', { style: { fontSize: '16px' } }, 'Normal text: The quick brown fox jumps over the lazy dog.'), h('div', { style: { fontSize: '24px', fontWeight: 700 } }, 'Large bold text')),
      !g.aaNormal ? fix(4.5) : '',
      !g.aaaNormal ? fix(7) : '',
      h(
        'details',
        null,
        h('summary', null, 'How it looks with colour-vision deficiencies'),
        h(
          'div',
          { class: 'tok-vision' },
          DFContrast.VISION.map((k) => {
            const sf = DFContrast.simulate(f, k);
            const sb = DFContrast.simulate(bgSolid, k);
            const rr = DFContrast.ratio(sf, sb);
            return h('div', { class: 'tok-vis', style: { background: DFContrast.hex(sb), color: DFContrast.hex(DFContrast.over(sf, sb)) } }, h('b', null, k), h('div', null, 'Aa ' + rr + ':1'));
          })
        ),
        h('div', { class: 'sev-info' }, 'Approximate simulation (Machado et al.). It estimates the effect; it does not replace testing with people.')
      )
    );
  };
  for (const el of [fg, bg]) el.addEventListener('input', draw);
  fgPick.addEventListener('input', () => { fg.value = fgPick.value; draw(); });
  bgPick.addEventListener('input', () => { bg.value = bgPick.value; draw(); });
  draw();
  return h(
    'div',
    null,
    h('div', { class: 'row' }, h('label', null, 'Text ', fgPick, fg), h('label', null, 'Background ', bgPick, bg), h('button', { id: 'tok-swap', on: { click: () => { [fg.value, bg.value] = [bg.value, fg.value]; draw(); } } }, '⇄ Swap')),
    out
  );
}

function pageContrastScan() {
  const out = h('div', { id: 'tok-scan-out' });
  const level = h('select', { id: 'tok-level', 'aria-label': 'Level to check against', on: { change: () => { tokContrast.level = level.value; if (tokContrast.scan) draw(); } } }, ['AA', 'AAA'].map((l) => h('option', { value: l, selected: l === tokContrast.level }, 'WCAG ' + l)));
  const draw = () => {
    const d = tokContrast.scan;
    clear(out);
    if (!d) return;
    const need = (p) => DFContrast.required(p.large, tokContrast.level);
    const failing = d.pairs.filter((p) => (p.exact == null ? p.ratio : p.exact) < need(p));
    const passing = d.pairs.length - failing.length;
    out.append(
      h('div', { class: 'card ' + (failing.length ? 'sev-warn' : ''), role: 'status' }, h('b', null, failing.length ? failing.length + ' of ' + d.pairs.length + ' colour pairs fall short of ' + tokContrast.level : 'All ' + d.pairs.length + ' colour pairs meet ' + tokContrast.level), h('div', { class: 'sev-info' }, d.scanned + ' text elements read (' + d.scope + '), ' + passing + ' pass. ' + (d.unknown ? d.unknown + ' sit on images or gradients and cannot be measured automatically. ' : '') + 'Large text is 24px, or 18.66px bold, and needs less.'))
    );
    if (failing.length)
      out.append(
        h(
          'div',
          { class: 'table-scroll' },
          table(
            ['Text / background', 'Ratio', 'Needs', 'Uses', 'Example', 'Fix'],
            failing.map((p) => {
              const s = DFContrast.suggest(p.fg, p.bg, need(p));
              return [
                h('span', { class: 'tok-pair', style: { background: p.bg, color: p.fg }, title: p.fg + ' on ' + p.bg }, 'Aa'),
                h('b', { class: 'sev-error' }, p.ratio + ':1'),
                need(p) + ':1' + (p.large ? ' (large)' : ''),
                String(p.count),
                h('button', { class: 'link', title: 'Select this element on the page', on: { click: selectAndShow(p.h) } }, p.sample),
                s && s.changed ? h('button', { class: 'link mono', title: 'Copy ' + s.hex + ' (' + s.ratio + ':1); original text colour ' + p.fg, on: { click: () => copy(s.hex) } }, s.hex) : h('span', { class: 'sev-info' }, '–'),
              ];
            }),
            { class: 'compact' }
          )
        ),
        h('button', { on: { click: () => copy(failing.map((p) => p.selector + ' { color: ' + p.fg + ' on ' + p.bg + ' = ' + p.ratio + ':1 (needs ' + need(p) + ':1) }').join('\n')) } }, icon('copy', 13), ' Copy list')
      );
  };
  return h(
    'div',
    null,
    h('div', { class: 'row' }, h('button', { id: 'tok-scan', class: 'primary', on: { click: async () => { clear(out).append(loading('Reading text colours')); tokContrast.scan = await call('contrastScan', null); draw(); } } }, 'Check this page\'s text'), level),
    out
  );
}

// Ratios between the page's most used opaque colours, for choosing safe text/background pairs.
function paletteMatrix(colors) {
  const cols = colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c.value)).slice(0, 8);
  if (cols.length < 2) return h('div', { class: 'sev-info' }, 'Needs at least two opaque colours.');
  const cell = (a, b) => {
    if (a === b) return h('td', { class: 'tok-cell' }, '–');
    const r = DFContrast.ratio(a.value, b.value);
    const x = DFContrast.exact(a.value, b.value); // grade on the exact value; r is rounded for display
    return h('td', { class: 'tok-cell ' + (x >= 7 ? 'tok-aaa' : x >= 4.5 ? 'tok-aa' : x >= 3 ? 'tok-lg' : 'tok-fail'), title: a.value + ' on ' + b.value + ': ' + r + ':1' }, r.toFixed(1));
  };
  return h(
    'div',
    { class: 'table-scroll' },
    h('table', { class: 'compact tok-matrix' }, h('thead', null, h('tr', null, h('th', null, 'text ↓ / bg →'), cols.map((c) => h('th', { scope: 'col' }, h('i', { class: 'swatch', style: { background: c.value }, title: c.value }))))), h('tbody', null, cols.map((a) => h('tr', null, h('th', { scope: 'row' }, h('i', { class: 'swatch', style: { background: a.value }, title: a.value }), a.name), cols.map((b) => cell(a, b)))))),
    h('div', { class: 'legend' }, h('span', null, h('i', { class: 'tok-aaa' }), 'AAA ≥ 7'), h('span', null, h('i', { class: 'tok-aa' }), 'AA ≥ 4.5'), h('span', null, h('i', { class: 'tok-lg' }), 'large text only ≥ 3'), h('span', null, h('i', { class: 'tok-fail' }), 'below 3'))
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
    section('Colour readability checker', contrastChecker()),
    section('Does the page\'s text meet WCAG?', pageContrastScan()),
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
