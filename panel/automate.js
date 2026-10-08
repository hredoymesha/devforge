const wf = { steps: [], recording: false };
registerTab('auto', 'Automate', async (v) => {
  const list = h('div'),
    out = h('div'),
    json = h('textarea', { rows: 8, 'aria-label': 'Workflow JSON' });
  const draw = () => {
    clear(list);
    json.value = JSON.stringify(wf.steps, null, 2);
    list.append(
      wf.steps.length
        ? table(
            ['#', 'Action', 'Target / value', ''],
            wf.steps.map((s, i) => [
              i + 1,
              s.action,
              mono(
                (s.selector || s.url || (s.ms && s.ms + 'ms') || '') +
                  (s.value != null ? ' = "' + s.value + '"' : '') +
                  (s.name ? ' → ' + s.name : '')
              ),
              h(
                'button',
                {
                  on: {
                    click: () => {
                      wf.steps.splice(i, 1);
                      draw();
                    },
                  },
                },
                '✕'
              ),
            ])
          )
        : h('div', { class: 'empty' }, 'No steps. Record on the page or add steps below.')
    );
  };
  const add = (s) => {
    wf.steps.push(s);
    draw();
  };
  const sel = h('input', {
      class: 'grow',
      placeholder: 'CSS selector (or use selected element)',
      'aria-label': 'Selector',
    }),
    val = h('input', { class: 'grow', placeholder: 'value / ms / url', 'aria-label': 'Value' });
  const useSel = () => sel.value || (DF.state.info && DF.state.info.selectors[0].selector);
  v.append(
    section(
      'Record',
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: wf.recording ? 'danger' : 'primary',
            on: {
              click: async (e) => {
                try {
                  if (!wf.recording) {
                    await call('record', true);
                    wf.recording = true;
                    e.target.textContent = 'Stop & import';
                    e.target.className = 'danger';
                    status('Recording clicks and typing on the page…');
                  } else {
                    const r = await call('record', false);
                    wf.recording = false;
                    wf.steps.push(
                      ...r.steps.map((s) => ({
                        action: s.action,
                        selector: s.selector,
                        alt: s.alt,
                        value: s.value,
                      }))
                    );
                    e.target.textContent = 'Start recording';
                    e.target.className = 'primary';
                    status('');
                    draw();
                  }
                } catch (err) {
                  toast(err.message);
                }
              },
            },
          },
          wf.recording ? 'Stop & import' : 'Start recording'
        ),
        h('span', { class: 'sev-info' }, 'Passwords are never recorded.')
      )
    ),
    section(
      'Add step',
      h('div', { class: 'row' }, sel, val),
      h(
        'div',
        { class: 'row' },
        [
          ['click', 'Click'],
          ['type', 'Type'],
          ['extract', 'Extract text'],
          ['waitFor', 'Wait for element'],
          ['wait', 'Wait ms'],
          ['navigate', 'Navigate'],
        ].map(([a, l]) =>
          h(
            'button',
            {
              on: {
                click: () => {
                  const s = { action: a };
                  if (a === 'wait') s.ms = +val.value || 500;
                  else if (a === 'navigate') s.url = val.value;
                  else {
                    s.selector = useSel();
                    if (!s.selector) return toast('Enter a selector or select an element');
                    if (a === 'type') s.value = val.value;
                    if (a === 'extract') s.name = val.value || 'value' + (wf.steps.length + 1);
                  }
                  add(s);
                },
              },
            },
            l
          )
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
                  const s = useSel();
                  const r = await call('selectBySelector', s, s.startsWith('/') ? 'xpath' : 'css');
                  toast('Selector OK: ' + r.tag + ' (' + r.selectors[0].score + '% stable)');
                } catch (e) {
                  toast(e.message);
                }
              },
            },
          },
          'Validate selector'
        )
      )
    ),
    section(
      'Workflow',
      list,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: async () => {
                if (!wf.steps.length) return toast('No steps');
                clear(out).append(loading('Running'));
                try {
                  const r = await call('runWorkflow', wf.steps);
                  clear(out).append(
                    table(
                      ['Step', 'Result'],
                      r.log.map((l) => [
                        l.i + 1 + ' ' + l.action,
                        h('span', { class: l.ok ? '' : 'sev-error' }, l.ok ? 'ok' : l.error),
                      ])
                    ),
                    Object.keys(r.data).length
                      ? h(
                          'div',
                          null,
                          h('b', null, 'Extracted'),
                          codeBlock(JSON.stringify(r.data, null, 2)),
                          h(
                            'button',
                            {
                              on: {
                                click: () =>
                                  download(
                                    'workflow-result-' + stamp() + '.json',
                                    JSON.stringify(r.data, null, 2),
                                    'application/json'
                                  ),
                              },
                            },
                            'Export JSON'
                          )
                        )
                      : '',
                    r.failedAt != null
                      ? h('div', { class: 'sev-error' }, 'Stopped at step ' + (r.failedAt + 1))
                      : r.interrupted
                        ? h('div', { class: 'sev-warn' }, 'Navigation interrupted the run.')
                        : h('div', { class: 'sev-info' }, 'Finished.')
                  );
                } catch (e) {
                  clear(out).append(h('div', { class: 'sev-error' }, e.message));
                }
              },
            },
          },
          '▶ Run'
        ),
        h(
          'button',
          {
            on: {
              click: () => {
                wf.steps = [];
                draw();
              },
            },
          },
          'Clear'
        ),
        h(
          'button',
          { on: { click: () => saveToWorkspace('workflow', 'workflow', { steps: wf.steps }) } },
          'Save'
        ),
        h(
          'button',
          {
            on: {
              click: () =>
                download(
                  'workflow-' + stamp() + '.json',
                  JSON.stringify(wf.steps, null, 2),
                  'application/json'
                ),
            },
          },
          'Export'
        )
      ),
      out
    ),
    section(
      'Edit as JSON',
      json,
      h(
        'button',
        {
          on: {
            click: () => {
              try {
                const p = JSON.parse(json.value);
                if (!Array.isArray(p)) throw new Error('must be an array');
                wf.steps = p;
                draw();
                toast('Imported');
              } catch (e) {
                toast('Invalid JSON: ' + e.message);
              }
            },
          },
        },
        'Apply JSON'
      )
    )
  );
  draw();
});
