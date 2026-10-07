registerTab('data', 'Data', async (v) => {
  const out = h('div');
  let rows = [],
    label = '';
  const kinds = [
    ['links', 'Links'],
    ['images', 'Images'],
    ['tables', 'Tables'],
    ['forms', 'Forms'],
    ['headings', 'Headings'],
    ['repeated', 'Repeated cards/lists'],
    ['metadata', 'Metadata'],
  ];
  const scope = h(
    'select',
    { 'aria-label': 'Scope' },
    h('option', { value: 'page' }, 'whole page'),
    h('option', { value: 'sel', disabled: !DF.state.h }, 'selected element')
  );
  const show = (data, kind) => {
    clear(out);
    label = kind;
    if (kind === 'tables') rows = data.flatMap((t) => t.rows.map((r) => r));
    else if (kind === 'repeated') rows = data.rows;
    else if (kind === 'metadata')
      rows = Object.entries(data.meta).map(([k, x]) => ({ name: k, content: x }));
    else if (kind === 'forms')
      rows = data.flatMap((f) =>
        f.fields.map((x) => ({ action: f.action, method: f.method, ...x }))
      );
    else rows = data;
    const ORDER = {
      links: ['text', 'href', 'rel'],
      images: ['src', 'alt', 'width', 'height'],
      forms: ['action', 'method', 'tag', 'type', 'name', 'id', 'required', 'placeholder'],
      repeated: ['heading', 'text', 'link', 'image'],
      metadata: ['name', 'content'],
      headings: ['level', 'text'],
    };
    if (ORDER[kind] && rows.length && !Array.isArray(rows[0]))
      rows = rows.map((r) => {
        const o = {};
        ORDER[kind].forEach((k) => {
          if (k in r) o[k] = r[k];
        });
        Object.keys(r).forEach((k) => {
          if (!(k in o)) o[k] = r[k];
        });
        return o;
      });
    if (kind === 'repeated' && !data.found)
      return out.append(h('div', { class: 'empty' }, data.note));
    out.append(
      h(
        'div',
        { class: 'sev-info' },
        `${rows.length} row(s)` +
          (kind === 'repeated'
            ? ` - container ${data.container}, ${data.count} items (inferred)`
            : '')
      )
    );
    if (rows.length)
      out.append(
        Array.isArray(rows[0])
          ? table(
              rows[0].map((_, i) => 'col ' + (i + 1)),
              rows.slice(0, 200)
            )
          : table(
              Object.keys(rows[0]),
              rows
                .slice(0, 200)
                .map((r) =>
                  Object.values(r).map((x) =>
                    typeof x === 'object' ? JSON.stringify(x) : String(x ?? '')
                  )
                )
            ),
        h(
          'div',
          { class: 'row' },
          [
            [
              'JSON',
              () => JSON.stringify(kind === 'tables' || kind === 'metadata' ? data : rows, null, 2),
              'json',
              'application/json',
            ],
            ['CSV', () => toCSV(rows), 'csv', 'text/csv'],
            ['Markdown', () => toMD(rows), 'md', 'text/markdown'],
            [
              'TXT',
              () =>
                rows
                  .map((r) => (Array.isArray(r) ? r.join('\t') : Object.values(r).join('\t')))
                  .join('\n'),
              'txt',
              'text/plain',
            ],
            [
              'HTML',
              () =>
                '<table border="1">' +
                rows
                  .map(
                    (r) =>
                      '<tr>' +
                      (Array.isArray(r) ? r : Object.values(r))
                        .map(
                          (c) =>
                            '<td>' +
                            String(c ?? '')
                              .replace(/&/g, '&amp;')
                              .replace(/</g, '&lt;') +
                            '</td>'
                        )
                        .join('') +
                      '</tr>'
                  )
                  .join('') +
                '</table>',
              'html',
              'text/html',
            ],
          ].map(([n, fn, ext, mime]) =>
            h(
              'button',
              { on: { click: () => download(`${label}-${stamp()}.${ext}`, fn(), mime) } },
              n
            )
          )
        ),
        h(
          'button',
          { on: { click: () => saveToWorkspace('data', label, { rows }) } },
          'Save to workspace'
        )
      );
  };
  v.append(
    h(
      'div',
      { class: 'row' },
      scope,
      kinds.map(([k, l]) =>
        h(
          'button',
          {
            on: {
              click: async () => {
                clear(out).append(loading('Extracting'));
                try {
                  show(await call('extractData', k, scope.value === 'sel' ? DF.state.h : null), k);
                } catch (e) {
                  clear(out).append(h('div', { class: 'sev-error' }, e.message));
                }
              },
            },
          },
          l
        )
      )
    ),
    out
  );
});
