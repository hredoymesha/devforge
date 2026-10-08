const reState = { best: null, history: [] };
registerTab('recreate', 'Recreate', async (v) => {
  if (!DF.state.h) {
    v.append(needsSelection());
    return;
  }
  const info = DF.state.info;
  const target = h(
    'select',
    { id: 're-target', 'aria-label': 'Target' },
    [
      ['html', 'HTML + CSS'],
      ['react', 'React (JSX)'],
      ['vue', 'Vue SFC'],
      ['svelte', 'Svelte'],
      ['tailwind', 'Tailwind (arbitrary props)'],
      ['json', 'Structure JSON'],
    ].map(([k, l]) => h('option', { value: k }, l))
  );
  const name = h('input', {
    id: 're-name',
    value: slug(info.tag + '-' + (info.id || info.classes[0] || 'component')),
    'aria-label': 'Component name',
  });
  const out = h('div', { id: 're-out' });
  // Switching the target regenerates code from the last measurement; no need to re-run it.
  target.addEventListener('change', () => {
    if (reState.last && reState.last.h === DF.state.h) renderRecreate(out, reState.last);
  });
  v.append(
    h(
      'div',
      { class: 'card' },
      h('b', null, 'Recreate '),
      mono(info.selectors[0].selector),
      h(
        'div',
        { class: 'sev-info' },
        'Builds a clean implementation from COMPUTED styles (ground truth for what is rendered), then measures layout similarity against the original and refines until it stops improving.'
      ),
      h(
        'div',
        { class: 'row' },
        target,
        name,
        h(
          'button',
          { class: 'primary', on: { click: () => runRecreate(out, target.value, name.value) } },
          'Recreate & compare'
        )
      )
    ),
    out
  );
  if (reState.last && reState.last.h === DF.state.h) renderRecreate(out, reState.last);
});
async function runRecreate(out, target, name) {
  clear(out).append(loading('Analyzing structure and styles'));
  try {
    const hd = DF.state.h;
    const attempts = [];
    const tryPin = async (pin) => {
      const rec = await call('recreate', hd, { pin });
      const doc = DFGen.page(rec.tree, rec.css, name);
      const cmp = await call('compareRecreation', hd, doc);
      return { pin, rec, doc, cmp };
    };
    for (const pin of ['none', 'all']) {
      status(
        `Generating attempt ${attempts.length + 1} (${pin === 'none' ? 'natural flow' : 'pinned sizes'})…`
      );
      const a = await tryPin(pin);
      attempts.push(a);
      if (a.cmp.similarity >= 99.5) break;
      if (attempts.length > 1 && a.cmp.similarity <= attempts[attempts.length - 2].cmp.similarity)
        break;
    }
    status('');
    const best = attempts.reduce((x, y) => (y.cmp.similarity > x.cmp.similarity ? y : x));
    reState.last = { h: hd, attempts, best, target, name, info: DF.state.info };
    renderRecreate(out, reState.last);
  } catch (e) {
    clear(out).append(h('div', { class: 'card sev-error' }, e.message));
    status(e.message, 'err');
  }
}
function renderRecreate(out, S) {
  clear(out);
  const b = S.best,
    cmp = b.cmp;
  S.target = $('#re-target') ? $('#re-target').value : S.target;
  const gen = DFGen.generate(b.rec, S.target, S.name);
  out.append(
    section(
      'Result',
      h(
        'div',
        { class: 'row' },
        h('b', { style: { fontSize: '20px' } }, cmp.similarity + '%'),
        h('span', { class: 'sev-info' }, 'layout similarity - ' + cmp.basis)
      ),
      table(
        ['Check', 'Score'],
        [
          ['Structure (tag order)', cmp.structure + '%'],
          ['Position (±2px)', cmp.position + '%'],
          ['Size (±2px)', cmp.size + '%'],
          ['Key styles (12 props)', cmp.style + '%'],
        ]
      ),
      h(
        'div',
        { class: 'sev-info' },
        `Elements: original ${cmp.elementCountOriginal}, recreated ${cmp.elementCountRecreated}. Root: ${cmp.rootSize.original.join('×')} vs ${cmp.rootSize.recreated.join('×')}.`
      )
    )
  );
  out.append(
    section(
      'Refinement history',
      table(
        ['Attempt', 'Mode', 'Similarity'],
        S.attempts.map((a, i) => [
          i + 1,
          a.pin === 'none' ? 'natural flow' : 'pinned sizes',
          a.cmp.similarity + '%',
        ])
      ),
      h(
        'div',
        { class: 'sev-info' },
        'Stops when similarity ≥ 99.5% or an attempt does not improve on the previous one. Best attempt is kept.'
      )
    )
  );
  if (cmp.diffs.length)
    out.append(
      section(
        'Differences (' + cmp.diffs.length + ' shown)',
        table(
          ['Kind', 'Element', 'Original', 'Recreated'],
          cmp.diffs.map((d) => [
            d.kind,
            mono(d.el),
            mono(JSON.stringify(d.original)),
            mono(JSON.stringify(d.recreated)),
          ])
        )
      )
    );
  out.append(
    section(
      'Live preview of generated page',
      h('iframe', {
        class: 'preview',
        sandbox: '',
        srcdoc: b.doc,
        title: 'Recreated preview (scripts and navigation disabled)',
      })
    )
  );
  out.append(
    section(
      'Generated ' + S.target,
      tagEl('generated'),
      gen.files.map((f) =>
        h(
          'details',
          null,
          h('summary', null, f.path + ' (' + f.data.length + ' chars)'),
          codeBlock(f.data.slice(0, 20000))
        )
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: () => {
                const target = $('#re-target') ? $('#re-target').value : S.target;
                const g = DFGen.generate(b.rec, target, S.name);
                const rep = reportMd(S, g);
                download(
                  'recreation-' + S.name + '-' + stamp() + '.zip',
                  DFZip.build([
                    ...g.files.map((f) => ({ path: S.name + '/' + f.path, data: f.data })),
                    { path: S.name + '/preview.html', data: b.doc.replace(' data-df-root', '') },
                    { path: S.name + '/RECREATION-REPORT.md', data: rep },
                  ]),
                  'application/zip'
                );
              },
            },
          },
          'Download ZIP + report'
        ),
        h(
          'button',
          {
            on: {
              click: () =>
                saveToWorkspace('recreation', S.name, {
                  html: b.doc.replace(' data-df-root', ''),
                  css: b.rec.css,
                  similarity: cmp.similarity,
                }),
            },
          },
          'Save to workspace'
        ),
        h(
          'button',
          {
            on: {
              click: () => {
                DF.state.aiDraft = { html: b.doc, css: b.rec.css };
                show('ai');
              },
            },
          },
          'Send to AI task →'
        )
      )
    )
  );
  out.append(section('Recreation report', codeBlock(reportMd(S, gen))));
}
function reportMd(S, gen) {
  const c = S.best.cmp,
    i = S.info;
  return `# Recreation report: ${S.name}\n\n- Original: \`${i.selectors[0].selector}\` on ${DF.state.url}\n- Target: ${S.target} (generated)\n- Date: ${new Date().toISOString()}\n\n## Detected\n- Structure: ${c.elementCountOriginal} elements (observed)\n- Styles: computed values per element, non-default only (observed)\n- Framework hints: ${(i.framework.value || []).join(', ') || 'none'} (inferred)\n- Assets: ${i.assets.length} referenced; the recreation links them by original URL (not downloaded here - use Component ZIP for local copies)\n\n## Browser limitations / unavailable\n- Event listeners, application state and animations driven by JavaScript are **not** reconstructed.\n- CSS :hover/:focus/@media variants are not captured: only the current computed state at the current viewport width.\n- Backend behaviour: unavailable.\n\n## Measured similarity (layout)\n${c.basis}\n\n| Check | Score |\n|---|---|\n| Structure | ${c.structure}% |\n| Position | ${c.position}% |\n| Size | ${c.size}% |\n| Style | ${c.style}% |\n| **Overall** | **${c.similarity}%** |\n\n## Refinement attempts\n${S.attempts.map((a, k) => `${k + 1}. ${a.pin === 'none' ? 'natural flow' : 'pinned sizes'} → ${a.cmp.similarity}%`).join('\n')}\n\n## Remaining differences\n${
    c.diffs
      .slice(0, 15)
      .map(
        (d) =>
          `- ${d.kind} on ${d.el}: ${JSON.stringify(d.original)} vs ${JSON.stringify(d.recreated)}`
      )
      .join('\n') || 'none measured'
  }\n\n## Assumptions & recommendations\n- Responsive behaviour was captured only at the current width (${S.info.box.width}px element width). Re-run at other viewport widths for variants.\n- Replace generated class names with your own naming scheme and extract repeated groups into components.\n- Add behaviour (events, state) manually; consider the AI tab for a guided prompt.\n`;
}
