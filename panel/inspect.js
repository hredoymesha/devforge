let treeSel = null;
// Sweeping the mouse over the tree would otherwise fire one page call per row it crosses.
const hoverHighlight = debounce((hnd) => call('highlight', hnd).catch(() => {}), 90);

/*
 * Framework component probe, run in the page's MAIN world (framework internals such as React fibers
 * or Vue instances are JS expandos only that world can see). It installs a capture listener once;
 * the isolated agent then fires a composed event on the element (probeDispatch), which hands the
 * real node over without marking the DOM. Self-contained: executeScript serializes it.
 */
function installComponentProbe() {
  if (window.__dfProbeInstalled) return true;
  window.__dfProbeInstalled = true;
  const clipStr = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  // Props can hold functions, DOM nodes, React elements and cycles; reduce them to plain JSON.
  const plain = (v, depth, seen) => {
    if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
    if (typeof v === 'string') return clipStr(v, 200);
    if (typeof v === 'function') return 'ƒ ' + (v.name || 'anonymous') + '()';
    if (typeof v === 'symbol' || typeof v === 'bigint') return String(v);
    if (v instanceof Node) return '<' + (v.nodeName || 'node').toLowerCase() + '>';
    if (v.$$typeof)
      return '<' + ((v.type && (v.type.displayName || v.type.name)) || v.type || 'Element') + ' />';
    if (seen.has(v)) return '[circular]';
    if (depth > 3) return Array.isArray(v) ? '[…' + v.length + ']' : '{…}';
    seen.add(v);
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => plain(x, depth + 1, seen));
    const o = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 30) {
        o['…'] = Object.keys(v).length - 30 + ' more';
        break;
      }
      if (k === 'children' && depth === 0 && typeof v[k] === 'object') o[k] = '[children]';
      else
        try {
          o[k] = plain(v[k], depth + 1, seen);
        } catch (_) {
          o[k] = '[unreadable]';
        }
    }
    return o;
  };
  const reactName = (t) =>
    t &&
    (t.displayName ||
      t.name ||
      (t.render && (t.render.displayName || t.render.name)) ||
      (t.type && reactName(t.type)));
  function read(el) {
    for (let node = el, hops = 0; node && hops < 15; node = node.parentElement, hops++) {
      const keys = Object.keys(node);
      const fk = keys.find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (fk) {
        const chain = [];
        for (let f = node[fk]; f && chain.length < 8; f = f.return) {
          const t = f.type;
          if (typeof t === 'function' || (t && typeof t === 'object')) {
            const name = reactName(t);
            if (name)
              chain.push({
                name,
                props: plain(f.memoizedProps || {}, 0, new WeakSet()),
                hasState:
                  f.memoizedState != null &&
                  typeof t === 'function' &&
                  !!t.prototype &&
                  !!t.prototype.isReactComponent,
              });
          }
        }
        if (chain.length) return { framework: 'React', hops, chain };
      }
      if (node.__vueParentComponent) {
        const chain = [];
        for (let c = node.__vueParentComponent; c && chain.length < 8; c = c.parent) {
          const t = c.type || {};
          chain.push({
            name: t.name || t.__name || (t.__file ? t.__file.split('/').pop() : 'Anonymous'),
            props: plain(c.props || {}, 0, new WeakSet()),
            state: c.setupState ? plain(c.setupState, 1, new WeakSet()) : null,
          });
        }
        return { framework: 'Vue 3', hops, chain };
      }
      if (node.__vue__) {
        const chain = [];
        for (let c = node.__vue__; c && chain.length < 8; c = c.$parent) {
          chain.push({
            name: (c.$options && (c.$options.name || c.$options._componentTag)) || 'Anonymous',
            props: plain(c.$props || c._props || {}, 0, new WeakSet()),
            state: plain(c.$data || {}, 1, new WeakSet()),
          });
        }
        return { framework: 'Vue 2', hops, chain };
      }
      if (node.__svelte_meta) {
        const loc = node.__svelte_meta.loc || {};
        return {
          framework: 'Svelte',
          hops,
          chain: [
            {
              name: (loc.file || 'component').split('/').pop(),
              props: { line: loc.line, column: loc.column },
            },
          ],
        };
      }
      if (window.ng && typeof window.ng.getComponent === 'function') {
        const cmp =
          window.ng.getComponent(node) || (hops === 0 && window.ng.getOwningComponent(node));
        if (cmp)
          return {
            framework: 'Angular',
            hops,
            chain: [{ name: cmp.constructor.name, props: plain(cmp, 0, new WeakSet()) }],
          };
      }
    }
    return null;
  }
  document.addEventListener(
    '__df_probe',
    (e) => {
      try {
        window.__dfProbeResult = { ok: true, value: read(e.composedPath()[0]) };
      } catch (err) {
        window.__dfProbeResult = { ok: false, error: String(err && err.message) };
      }
    },
    true
  );
  return true;
}
async function probeComponent(hnd) {
  await exec(installComponentProbe, [], 'MAIN');
  await call('probeDispatch', hnd);
  const r = await exec(
    () => {
      const x = window.__dfProbeResult;
      window.__dfProbeResult = null;
      return x;
    },
    [],
    'MAIN'
  );
  if (!r) throw new Error('The page did not answer the component probe.');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
function componentSection(d) {
  const box = h(
    'div',
    null,
    h('span', { class: 'sev-info' }, 'Looking for a framework component…')
  );
  probeComponent(d.h)
    .then((c) => {
      clear(box);
      if (!c) {
        box.append(
          h(
            'div',
            { class: 'sev-info' },
            'No React, Vue, Svelte or Angular (dev mode) component found on this element or its ancestors.'
          )
        );
        return;
      }
      box.append(
        h(
          'div',
          { class: 'row' },
          tagEl('observed'),
          h('b', null, c.framework),
          c.hops ? h('span', { class: 'sev-info' }, `found ${c.hops} level(s) up`) : ''
        ),
        ...c.chain.map((x, i) =>
          h(
            'details',
            { open: i === 0 },
            h(
              'summary',
              null,
              h('span', { class: 'mono' }, '<' + x.name + '>'),
              i ? h('span', { class: 'sev-info' }, ' parent') : ''
            ),
            codeBlock(JSON.stringify(x.props, null, 2)),
            x.state
              ? h(
                  'div',
                  null,
                  h('div', { class: 'lbl' }, 'State'),
                  codeBlock(JSON.stringify(x.state, null, 2))
                )
              : ''
          )
        )
      );
    })
    .catch((e) =>
      clear(box).append(
        h('div', { class: 'sev-info' }, 'Component probe unavailable: ' + e.message)
      )
    );
  return section('Component', box);
}

// Quick DOM edits for the selected element. They go through the agent's undo stack.
function quickEdits(d) {
  const form = h('div');
  const run = async (spec, msg) => {
    await call('edit', { h: d.h, ...spec });
    toast(msg + ' · undo with Ctrl+K → "Undo"');
    if (spec.kind !== 'remove') setSelection(await call('select', d.h));
    else {
      DF.state.h = null;
      DF.state.info = null;
      show('inspect');
    }
  };
  const openForm = (kind) => {
    const name = h('input', {
      placeholder: 'attribute name',
      'aria-label': 'Attribute name',
      list: 'attr-names',
    });
    const val = h(kind === 'text' ? 'textarea' : 'input', {
      class: 'grow',
      rows: 3,
      'aria-label': 'New value',
      placeholder: kind === 'text' ? 'new text' : 'value (empty removes the attribute)',
    });
    if (kind === 'text') val.value = d.text;
    clear(form).append(
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row' }, kind === 'attr' ? name : '', val),
        h(
          'datalist',
          { id: 'attr-names' },
          Object.keys(d.attributes.value).map((a) => h('option', { value: a }))
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'primary',
              on: {
                click: () =>
                  kind === 'text'
                    ? run({ kind: 'text', value: val.value }, 'Text replaced')
                    : run(
                        {
                          kind: 'attr',
                          prop: name.value,
                          value: val.value === '' ? null : val.value,
                        },
                        'Attribute updated'
                      ),
              },
            },
            'Apply'
          ),
          h('button', { on: { click: () => clear(form) } }, 'Cancel')
        )
      )
    );
    (kind === 'attr' ? name : val).focus();
  };
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'sev-info' }, 'Edit:'),
      h('button', { on: { click: () => openForm('text') } }, 'Text'),
      h('button', { on: { click: () => openForm('attr') } }, 'Attribute'),
      h('button', { on: { click: () => run({ kind: 'hide' }, 'Element hidden') } }, 'Hide'),
      h(
        'button',
        { class: 'danger', on: { click: () => run({ kind: 'remove' }, 'Element removed') } },
        'Delete'
      ),
      h('button', { on: { click: () => copy(d.selectors[0].selector) } }, 'Copy selector')
    ),
    form
  );
}
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
  row.addEventListener('mouseenter', () => hoverHighlight(n.h));
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
    box.append(needsSelection());
    return;
  }
  box.append(
    h(
      'nav',
      { class: 'crumbs', 'aria-label': 'Ancestors' },
      d.ancestry.map((a) =>
        h(
          'button',
          {
            class: 'link',
            'aria-current': a.h === d.h ? 'true' : null,
            on: { click: async () => setSelection(await call('select', a.h)) },
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
    ),
    quickEdits(d),
    componentSection(d)
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
  if (!DF.state.settings.onboarded)
    v.append(
      h(
        'div',
        { class: 'card intro' },
        h('b', null, 'Getting started'),
        h(
          'ol',
          null,
          h('li', null, 'Press ⌖ Pick (or Ctrl+Shift+U) and click anything on the page.'),
          h(
            'li',
            null,
            'Read its styles, box model and component props here; tweak it live on the CSS tab.'
          ),
          h(
            'li',
            null,
            'Network, Perf, Mutations and Storage work on the whole page, no selection needed.'
          ),
          h('li', null, 'Ctrl+K opens the command palette with every action.')
        ),
        h(
          'button',
          {
            on: {
              click: (e) => {
                DF.state.settings.onboarded = true;
                saveSettings();
                e.currentTarget.closest('.intro').remove();
              },
            },
          },
          'Got it'
        )
      )
    );
  const xrayBox = h('input', { type: 'checkbox', checked: !!DF.state.xray });
  xrayBox.addEventListener(
    'change',
    guard(async () => {
      DF.state.xray = (await call('xray', xrayBox.checked)).on;
    })
  );
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
      h('button', { on: { click: inspectSearch } }, 'Go'),
      h('label', { title: 'Outline every element on the page to debug layout' }, xrayBox, ' X-ray')
    ),
    h('div', { id: 'insp-results' })
  );
  const tree = h('div', { id: 'insp-tree', class: 'tree', role: 'tree' }, loading('Loading DOM'));
  v.append(
    section('DOM tree', tree),
    section('Selected element', h('div', { id: 'insp-details' }))
  );
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
