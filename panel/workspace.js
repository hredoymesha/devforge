registerTab('work', 'Workspace', async (v) => {
  const ps = await DFStore.listProjects();
  if (!DF.state.project && ps[0]) DF.state.project = ps[0].id;
  const name = h('input', { placeholder: 'New project name', 'aria-label': 'Project name' });
  v.append(
    h(
      'div',
      { class: 'row' },
      h(
        'select',
        {
          'aria-label': 'Project',
          on: {
            change: (e) => {
              DF.state.project = e.target.value;
              show('work');
            },
          },
        },
        ps.map((p) => h('option', { value: p.id, selected: p.id === DF.state.project }, p.name))
      ),
      name,
      h(
        'button',
        {
          on: {
            click: async () => {
              if (!name.value.trim()) return;
              const p = await DFStore.createProject(name.value.trim());
              DF.state.project = p.id;
              show('work');
            },
          },
        },
        'Create'
      ),
      ps.length
        ? h(
            'button',
            {
              class: 'danger',
              on: {
                click: async () => {
                  if (confirm('Delete this project and all its items? This cannot be undone.')) {
                    await DFStore.deleteProject(DF.state.project);
                    DF.state.project = null;
                    show('work');
                  }
                },
              },
            },
            'Delete project'
          )
        : ''
    )
  );
  if (!ps.length) {
    v.append(
      h(
        'div',
        { class: 'empty' },
        'No projects yet. Create one above, or just save something - a default project is created automatically. Everything is stored locally in this browser (IndexedDB).'
      )
    );
    return;
  }
  const q = h('input', {
    class: 'grow',
    placeholder: 'Search all saved items (title, code, notes)…',
    'aria-label': 'Search workspace',
  });
  const out = h('div');
  const draw = async () => {
    const items = (
      q.value ? await DFStore.allItems() : await DFStore.listItems(DF.state.project)
    ).filter(
      (it) =>
        !q.value ||
        JSON.stringify([
          it.title,
          it.kind,
          it.url,
          it.payload && !it.payload.dataUrl ? it.payload : '',
        ])
          .toLowerCase()
          .includes(q.value.toLowerCase())
    );
    clear(out).append(
      items.length
        ? table(
            ['Kind', 'Title', 'Saved', ''],
            items
              .sort((a, b) => b.created - a.created)
              .map((it) => [
                it.kind,
                it.title,
                new Date(it.created).toLocaleString(),
                h(
                  'span',
                  null,
                  h('button', { on: { click: () => openItem(it) } }, 'Open'),
                  ' ',
                  h(
                    'button',
                    {
                      on: {
                        click: async () => {
                          await DFStore.deleteItem(it.id);
                          draw();
                        },
                      },
                    },
                    '✕'
                  )
                ),
              ])
          )
        : h('div', { class: 'empty' }, q.value ? 'Nothing matches.' : 'This project is empty.')
    );
  };
  const detail = h('div');
  const openItem = (it) => {
    clear(detail).append(
      section(
        it.kind + ': ' + it.title,
        h('div', { class: 'sev-info mono' }, it.url || ''),
        it.payload && it.payload.dataUrl
          ? h('img', { src: it.payload.dataUrl, style: { maxWidth: '100%' } })
          : codeBlock(JSON.stringify(it.payload, null, 2).slice(0, 20000)),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              on: {
                click: () =>
                  download(
                    slug(it.title) + '.json',
                    JSON.stringify(it, null, 2),
                    'application/json'
                  ),
              },
            },
            'Download'
          ),
          it.payload && it.payload.prompt
            ? h('button', { on: { click: () => copy(it.payload.prompt) } }, 'Copy prompt')
            : '',
          it.payload && it.payload.steps
            ? h(
                'button',
                {
                  on: {
                    click: () => {
                      wf.steps = it.payload.steps;
                      show('auto');
                    },
                  },
                },
                'Load workflow'
              )
            : '',
          it.payload && it.payload.html
            ? h(
                'button',
                {
                  on: {
                    click: () => {
                      DF.state.pg = {
                        html: it.payload.html,
                        css: it.payload.css || '',
                        js: it.payload.js || '',
                      };
                      DF.state.pgPaused = true;
                      show('play');
                    },
                  },
                },
                'Open in Playground'
              )
            : ''
        )
      )
    );
    detail.scrollIntoView();
  };
  q.addEventListener('input', draw);
  v.append(h('div', { class: 'row' }, q), out, detail);
  draw();
});
