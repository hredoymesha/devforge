let treeSel = null;
function nodeRow(n, depth) {
  const wrap = h('div');
  const row = h('div', { class: 'n', tabindex: 0, role: 'treeitem', 'data-h': n.h });
  const tw = h('span', { class: 'tw' }, n.kids ? '▸' : '·');
  row.append(
    tw,
    h('span', { class: 't-tag' }, '<' + n.tag),
    n.id ? h('span', { class: 't-id' }, '#' + n.id) : '',
    n.cls
      ? h('span', { class: 't-cls' }, '.' + n.cls.trim().split(/\s+/).slice(0, 2).join('.'))
      : '',
    h('span', { class: 't-tag' }, '>'),
    n.shadow ? h('span', { class: 'tag' }, 'shadow') : '',
    n.frame ? h('span', { class: 'tag' }, 'iframe') : '',
    n.text ? h('span', { class: 't-txt' }, ' ' + n.text) : ''
  );
  const kids = h('div', { class: 'kids', hidden: true });
  let loaded = false;
  const toggle = async () => {
    if (!n.kids && !n.frame) return;
    if (kids.hidden && !loaded) {
      tw.textContent = '…';
      try {
        const r = await call('children', n.h);
        kids.append(...r.nodes.map((c) => nodeRow(c, depth + 1)));
        if (r.shadow) {
          kids.append(
            h('div', { class: 't-txt' }, '#shadow-root'),
            ...r.shadow.map((c) => nodeRow(c, depth + 1))
          );
        }
        if (r.truncated)
          kids.append(
            h(
              'div',
              { class: 'empty' },
              'More than 500 children: showing the first 500. Use search to find others.'
            )
          );
        if (r.frame && r.frame.provenance === 'unavailable')
          kids.append(h('div', { class: 'sev-warn' }, r.frame.value));
        loaded = true;
      } catch (e) {
        status(e.message, 'err');
        tw.textContent = '▸';
        return;
      }
    }
    kids.hidden = !kids.hidden;
    tw.textContent = kids.hidden ? '▸' : '▾';
  };
  tw.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  row.addEventListener('click', async () => {
    try {
      const d = await call('select', n.h);
      setSelection(d, row);
    } catch (e) {
      status(e.message, 'err');
    }
  });
  row.addEventListener('mouseenter', () => call('highlight', n.h).catch(() => {}));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') row.click();
    if (e.key === 'ArrowRight') {
      if (kids.hidden) toggle();
    }
    if (e.key === 'ArrowLeft' && !kids.hidden) toggle();
  });
  wrap.append(row, kids);
  return wrap;
}
function setSelection(d, row) {
  DF.state.h = d.h;
  DF.state.info = d;
  if (treeSel) treeSel.classList.remove('sel');
  if (row) {
    row.classList.add('sel');
    treeSel = row;
  }
  renderDetails();
}
function renderDetails() {
  const box = $('#insp-details');
  if (!box) return;
  clear(box);
  const d = DF.state.info;
  if (!d) {
    box.append(h('div', { class: 'empty' }, 'Pick or select an element to see details.'));
    return;
  }
  box.append(
    h(
      'div',
      { class: 'crumbs' },
      d.ancestry.map((a) =>
        h(
          'a',
          {
            on: {
              click: async () => {
                try {
                  setSelection(await call('select', a.h));
                } catch (e) {
                  status(e.message, 'err');
                }
              },
            },
          },
          a.label
        )
      )
    )
  );
  box.append(
    h(
      'div',
      { class: 'row' },
      ['parent', 'child', 'prev', 'next'].map((dir) =>
        h(
          'button',
          {
            on: {
              click: async () => {
                try {
                  setSelection(await call('relative', d.h, dir));
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          { parent: '↑ Parent', child: '↓ Child', prev: '← Prev', next: '→ Next' }[dir]
        )
      ),
      h('button', { on: { click: () => show('css') } }, 'CSS →'),
      h('button', { on: { click: () => show('export') } }, 'Export →'),
      h('button', { on: { click: () => show('recreate') } }, 'Recreate →')
    )
  );
  box.append(
    section(
      'Selectors',
      table(
        ['Kind', 'Selector', 'Stability', ''],
        d.selectors.slice(0, 6).map((s) => [
          s.kind,
          mono(s.selector),
          h(
            'div',
            { title: DF.state.info.stabilityBasis },
            s.score + '% ' + s.label,
            h(
              'div',
              { class: 'bar' },
              h('i', {
                style: {
                  width: s.score + '%',
                  background:
                    s.score >= 80 ? 'var(--ok)' : s.score >= 50 ? 'var(--warn)' : 'var(--err)',
                },
              })
            )
          ),
          h('button', { on: { click: () => copy(s.selector) } }, 'Copy'),
        ])
      ),
      h(
        'div',
        { class: 'sev-info' },
        'Stability is a heuristic ranking, not a measured probability.'
      )
    )
  );
  const b = d.box;
  box.append(
    section(
      'Box model',
      h(
        'div',
        { class: 'boxmodel' },
        h(
          'div',
          { class: 'bm m' },
          h('span', { class: 'l' }, 'margin ' + b.margin.join(' ')),
          h(
            'div',
            { class: 'bm b' },
            h('span', { class: 'l' }, 'border ' + b.border.join(' ')),
            h(
              'div',
              { class: 'bm p' },
              h('span', { class: 'l' }, 'padding ' + b.padding.join(' ')),
              h('div', { class: 'bm c' }, b.width + ' × ' + b.height)
            )
          )
        )
      ),
      kv({ position: b.position, display: b.display, 'page x/y': b.pageX + ', ' + b.pageY })
    )
  );
  box.append(
    section(
      'Context',
      kv({
        'positioning ctx': d.context.positioningContext,
        'stacking ctx': {
          value:
            d.context.createsStackingContext.value +
            (d.context.createsStackingContext.reasons.length
              ? ' (' + d.context.createsStackingContext.reasons.join(', ') + ')'
              : ''),
          provenance: 'observed',
        },
        'nearest stacking': d.context.nearestStackingAncestor,
        'z-index': d.context.zIndex,
        shadow: d.inShadow ? 'inside shadow DOM' : d.shadowRoot,
        framework: d.framework.value.length
          ? { value: d.framework.value.join(', '), provenance: 'inferred' }
          : 'none detected',
      })
    )
  );
  box.append(
    section(
      'Typography & visual',
      kv({
        font:
          d.typography.fontFamily.slice(0, 60) +
          ' ' +
          d.typography.fontSize +
          '/' +
          d.typography.lineHeight +
          ' w' +
          d.typography.fontWeight,
        color: colorSwatch(d.typography.color),
        background: colorSwatch(d.visual.background),
        'bg image': d.visual.backgroundImage,
        shadow: d.visual.boxShadow,
        radius: d.visual.borderRadius,
        transform: d.visual.transform,
        opacity: d.visual.opacity,
        animation: d.motion.animationName,
        transition: d.motion.transition,
      })
    )
  );
  if (Object.keys(d.pseudo).length)
    box.append(section('Pseudo-elements', codeBlock(JSON.stringify(d.pseudo, null, 2))));
  box.append(
    section(
      'Accessibility',
      kv({
        role: d.accessibility.role,
        name: d.accessibility.accessibleName,
        tabbable: d.accessibility.tabbable,
        aria: Object.keys(d.accessibility.aria).length
          ? JSON.stringify(d.accessibility.aria)
          : 'none',
      })
    )
  );
  if (d.form) box.append(section('Form', kv(d.form)));
  box.append(
    section(
      'Attributes ',
      tagEl('observed'),
      table(
        ['Name', 'Value'],
        Object.entries(d.attributes.value).map(([k, v]) => [k, mono(v)])
      )
    )
  );
  if (d.inlineHandlers.value.length)
    box.append(
      section(
        'Inline handlers',
        tagEl('observed'),
        table(
          ['Attr', 'Code'],
          d.inlineHandlers.value.map((x) => [x.attr, mono(x.code)])
        ),
        h('div', { class: 'sev-info' }, d.inlineHandlers.note)
      )
    );
  else
    box.append(
      section(
        'Event handlers',
        h('div', { class: 'sev-info' }, d.inlineHandlers.note),
        tagEl('unavailable')
      )
    );
  if (d.assets.length)
    box.append(
      section(
        'Assets (' + d.assets.length + ')',
        table(
          ['Type', 'URL'],
          d.assets.slice(0, 30).map((a) => [a.type, mono(a.url || '(inline)')])
        )
      )
    );
  box.append(
    section(
      'HTML (' + d.htmlLength + ' chars)',
      codeBlock(d.htmlPreview),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: async () => {
                const c = await call('collectComponent', d.h);
                copy(c.html);
              },
            },
          },
          'Copy full HTML'
        ),
        h(
          'button',
          { on: { click: () => saveToWorkspace('element', d.selectors[0].selector, { info: d }) } },
          'Save to workspace'
        )
      )
    )
  );
}
async function inspectSearch() {
  const q = $('#insp-q').value.trim(),
    mode = $('#insp-mode').value,
    out = $('#insp-results');
  if (!q) return;
  clear(out).append(loading('Searching'));
  try {
    if (mode === 'select-css' || mode === 'select-xpath') {
      setSelection(await call('selectBySelector', q, mode === 'select-xpath' ? 'xpath' : 'css'));
      clear(out);
      return;
    }
    const res = await call('search', q, mode);
    clear(out).append(
      h(
        'div',
        { class: 'sev-info' },
        res.length + ' result(s)' + (res.length >= 200 ? ' (first 200)' : '')
      ),
      ...res.map((n) => nodeRow(n, 0))
    );
  } catch (e) {
    clear(out).append(h('div', { class: 'sev-error' }, e.message));
  }
}
registerTab('inspect', 'Inspect', async (v) => {
  v.append(
    h(
      'div',
      { class: 'row' },
      h('input', {
        id: 'insp-q',
        class: 'grow',
        placeholder: 'Search DOM, CSS selector or XPath…',
        'aria-label': 'Search',
        on: { keydown: (e) => e.key === 'Enter' && inspectSearch() },
      }),
      h(
        'select',
        { id: 'insp-mode', 'aria-label': 'Search mode' },
        h('option', { value: 'text' }, 'text/tag/class'),
        h('option', { value: 'css' }, 'CSS → list'),
        h('option', { value: 'xpath' }, 'XPath → list'),
        h('option', { value: 'select-css' }, 'CSS → select'),
        h('option', { value: 'select-xpath' }, 'XPath → select')
      ),
      h('button', { on: { click: inspectSearch } }, 'Go')
    ),
    h('div', { id: 'insp-results' })
  );
  const tree = h('div', { id: 'insp-tree', class: 'tree', role: 'tree' }, loading('Loading DOM'));
  v.append(
    section('DOM tree', tree),
    section('Selected element', h('div', { id: 'insp-details' }))
  );
  const mut = h(
    'div',
    { class: 'row' },
    h(
      'button',
      {
        id: 'mut-btn',
        on: {
          click: async () => {
            const on = $('#mut-btn').dataset.on !== '1';
            const r = await call('trackMutations', on);
            $('#mut-btn').dataset.on = on ? '1' : '0';
            $('#mut-btn').textContent = on ? 'Stop tracking mutations' : 'Track DOM mutations';
            renderMut(r);
          },
        },
      },
      'Track DOM mutations'
    ),
    h(
      'button',
      {
        on: {
          click: async () =>
            renderMut(await call('trackMutations', $('#mut-btn').dataset.on === '1')),
        },
      },
      'Refresh'
    ),
    h('div', { id: 'mut-out', class: 'grow' })
  );
  function renderMut(r) {
    const o = clear($('#mut-out'));
    o.append(
      r.tracking
        ? h(
            'span',
            { class: 'sev-info' },
            r.mutations.length + ' recent mutation(s) (max 300 kept)'
          )
        : h('span', { class: 'sev-info' }, 'off')
    );
    if (r.mutations.length)
      o.append(
        table(
          ['Type', 'Target', 'Detail'],
          r.mutations
            .slice(-25)
            .reverse()
            .map((m) => [m.type, mono(m.target), m.attr || '+' + m.added + ' −' + m.removed])
        )
      );
  }
  v.append(section('Mutation tracking', mut));
  renderDetails();
  try {
    await ensureAgent();
    const root = await call('children', null);
    const top = root.nodes;
    clear(tree);
    // Root children are html's children (head, body); wrap them
    const holder = h('div');
    tree.append(h('div', { class: 't-txt' }, '<html>'), holder);
    holder.append(...top.map((n) => nodeRow(n, 0)));
    const sel = await call('selectedHandle');
    if (sel && !DF.state.info) setSelection(await call('select', sel));
    else if (DF.state.info) renderDetails();
    const pi = await call('pageInfo');
    tree.before(
      h(
        'div',
        { class: 'sev-info' },
        `${pi.domCount} elements · ${pi.shadowHosts} shadow host(s) · ${pi.iframes.length} iframe(s)` +
          (pi.iframes.some((f) => !f.accessible)
            ? ` (${pi.iframes.filter((f) => !f.accessible).length} cross-origin: not inspectable)`
            : '')
      )
    );
  } catch (e) {
    clear(tree).append(h('div', { class: 'card sev-error' }, e.message));
  }
});
