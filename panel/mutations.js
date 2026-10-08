// Mutations tab: a live DOM change timeline (agent/mutations.js). Shows old -> new values, which
// elements change most, redundant writes, and can flash changes on the page.
const mutS = {
  since: 0,
  entries: [],
  tracking: false,
  filter: '',
  types: { attributes: true, childList: true, characterData: true },
};

function mutDetail(e) {
  if (e.type === 'attributes')
    return h(
      'span',
      { class: 'mono' },
      h('b', null, e.attr),
      ': ',
      h('span', { class: 'old' }, e.old == null ? '(none)' : e.old),
      ' → ',
      h('span', { class: 'new' }, e.now == null ? '(removed)' : e.now)
    );
  if (e.type === 'characterData')
    return h(
      'span',
      { class: 'mono' },
      h('span', { class: 'old' }, e.old),
      ' → ',
      h('span', { class: 'new' }, e.now)
    );
  return h(
    'span',
    { class: 'mono' },
    e.addedCount ? h('span', { class: 'new' }, '+' + e.addedCount + ' ' + e.added.join(', ')) : '',
    e.addedCount && e.removedCount ? ' ' : '',
    e.removedCount
      ? h('span', { class: 'old' }, '−' + e.removedCount + ' ' + e.removed.join(', '))
      : ''
  );
}

registerTab('mutations', 'Mutations', async (v) => {
  const statsBox = h('div');
  const listBox = h('div');
  const hotBox = h('div');
  const opt = {
    scope: h(
      'select',
      { 'aria-label': 'Scope' },
      h('option', { value: 'page' }, 'whole document'),
      h('option', { value: 'sel', disabled: !DF.state.h }, 'selected element subtree')
    ),
    flash: h('input', { type: 'checkbox' }),
  };
  const typeBoxes = Object.keys(mutS.types).map((k) =>
    h(
      'label',
      null,
      h('input', {
        type: 'checkbox',
        checked: mutS.types[k],
        on: { change: (e) => (mutS.types[k] = e.target.checked) },
      }),
      ' ' + { attributes: 'attributes', childList: 'nodes', characterData: 'text' }[k]
    )
  );
  const startBtn = h('button', { class: 'primary' });
  const filter = h('input', {
    class: 'grow',
    type: 'search',
    value: mutS.filter,
    placeholder: 'Filter by element, attribute or value…',
    'aria-label': 'Filter mutations',
  });

  const drawStart = () => {
    startBtn.textContent = mutS.tracking ? '■ Stop' : '● Start tracking';
    startBtn.className = mutS.tracking ? 'rec' : 'primary';
  };
  const draw = (r) => {
    clear(statsBox);
    if (r) {
      const perSec = r.elapsed ? (r.total / (r.elapsed / 1000)).toFixed(1) : '0';
      const noop = mutS.entries.filter((e) => e.noop).length;
      statsBox.append(
        h(
          'div',
          { class: 'stats' },
          vitalCard('Total', { value: r.total }, String),
          vitalCard('Per second', { value: perSec }, String),
          vitalCard('Attributes', { value: r.counts.attributes }, String),
          vitalCard('Nodes', { value: r.counts.childList }, String),
          vitalCard('Text', { value: r.counts.characterData }, String),
          vitalCard('No-op writes', { value: noop, rating: noop ? 'ni' : 'good' }, String)
        ),
        r.rate && r.rate.length > 1 ? sparkline(r.rate) : '',
        r.dropped
          ? h('div', { class: 'sev-warn' }, `${r.dropped} oldest record(s) dropped (2000 kept).`)
          : ''
      );
      clear(hotBox);
      if (r.hot.length)
        hotBox.append(
          section(
            'Hot elements',
            table(
              ['Element', 'Changes', ''],
              r.hot.map((x) => [
                mono(x.label),
                x.count,
                h('button', { on: { click: selectAndShow(x.h) } }, 'Select'),
              ]),
              { class: 'compact' }
            )
          )
        );
    }
    const q = mutS.filter.toLowerCase();
    const rows = mutS.entries
      .filter((e) => mutS.types[e.type])
      .filter(
        (e) =>
          !q ||
          JSON.stringify([e.target, e.attr, e.old, e.now, e.added, e.removed])
            .toLowerCase()
            .includes(q)
      )
      .slice(-300)
      .reverse();
    clear(listBox).append(
      rows.length
        ? table(
            ['Time', 'Type', 'Element', 'Change'],
            rows.map((e) => [
              fmtMs(e.t),
              h(
                'span',
                { class: 'tag' },
                e.type === 'childList' ? 'nodes' : e.type === 'characterData' ? 'text' : 'attr'
              ),
              h('button', { class: 'link mono', on: { click: selectAndShow(e.h) } }, e.target),
              h(
                'div',
                null,
                mutDetail(e),
                e.noop
                  ? h(
                      'span',
                      { class: 'tag inferred', title: 'Value written but unchanged' },
                      'no-op'
                    )
                  : ''
              ),
            ]),
            { class: 'compact' }
          )
        : emptyState(
            mutS.tracking ? 'No mutations yet' : 'Not tracking',
            mutS.tracking
              ? 'Interact with the page; changes stream in here.'
              : 'Start tracking to record every DOM change with before/after values.'
          )
    );
  };
  const poll = async () => {
    let r = await call('mutRead', mutS.since);
    if (r.seq < mutS.since) {
      // The page reloaded and the agent's counter restarted: our cursor points past its log.
      mutS.since = 0;
      mutS.entries = [];
      r = await call('mutRead', 0);
    }
    mutS.tracking = r.tracking;
    if (r.entries.length) {
      mutS.entries.push(...r.entries);
      if (mutS.entries.length > 2000) mutS.entries.splice(0, mutS.entries.length - 2000);
      mutS.since = r.seq;
    }
    drawStart();
    draw(r);
  };
  const start = async () => {
    mutS.entries = [];
    mutS.since = 0;
    const r = await call('mutStart', {
      scopeH: opt.scope.value === 'sel' ? DF.state.h : null,
      attributes: mutS.types.attributes,
      childList: mutS.types.childList,
      characterData: mutS.types.characterData,
      flash: opt.flash.checked,
    });
    mutS.tracking = r.tracking;
    drawStart();
    draw(r);
  };
  startBtn.addEventListener(
    'click',
    guard(async () => {
      if (mutS.tracking) {
        await call('mutStop');
        await poll();
      } else await start();
    })
  );
  opt.flash.addEventListener(
    'change',
    guard(() => call('mutFlash', opt.flash.checked))
  );
  filter.addEventListener(
    'input',
    debounce(() => {
      mutS.filter = filter.value;
      draw();
    }, 120)
  );
  v.append(
    h(
      'div',
      { class: 'toolbar' },
      startBtn,
      opt.scope,
      h(
        'label',
        { title: 'Outline changed elements on the page as they change' },
        opt.flash,
        ' Flash on page'
      )
    ),
    h('div', { class: 'row' }, h('span', { class: 'sev-info' }, 'Record:'), typeBoxes),
    statsBox,
    hotBox,
    h(
      'div',
      { class: 'row' },
      filter,
      h(
        'button',
        {
          on: {
            click: async () =>
              download(
                'mutations-' + stamp() + '.json',
                JSON.stringify(await call('mutExport'), null, 2),
                'application/json'
              ),
          },
        },
        'Export'
      )
    ),
    listBox
  );
  drawStart();
  await poll().catch(() => draw());
  if (DF.state.mutAutoStart) {
    DF.state.mutAutoStart = false;
    if (!mutS.tracking) await start();
  }
  const timer = setInterval(() => {
    if (mutS.tracking && !document.hidden && DF.state.tab === 'mutations') poll().catch(() => {});
  }, 800);
  onLeave(() => clearInterval(timer));
});
