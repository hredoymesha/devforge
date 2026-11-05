// Guide: a plain-English manual inside the panel. The text lives in lib/guide.js.
registerTab('guide', 'Guide', async (v) => {
  const G = DFGuide;

  // A name written as [Name] in the text is a label in the panel. Draw it so it stands out.
  const rich = (text) =>
    G.parts(text).map((p) => (p.label ? h('b', { class: 'guide-label' }, p.label) : p.text));
  const list = (tag, items) => h(tag, null, ...items.map((t) => h('li', null, rich(t))));

  const sections = [
    ['guide-first', 'First 5 minutes'],
    ['guide-tabs', 'Every tab'],
    ['guide-problems', 'Common problems'],
    ['guide-privacy', 'Privacy'],
    ['guide-keys', 'Shortcuts'],
    ['guide-words', 'Glossary'],
  ];
  const jump = (id) => $('#' + id, v).scrollIntoView({ block: 'start' });

  const tabCard = (t) => {
    const c = G.CARDS.find((x) => x.id === t.id);
    if (!c) return h('div', { class: 'card' }, h('b', null, t.label), h('p', { class: 'sev-info' }, 'No guide text for this tab yet.'));
    return h(
      'details',
      { class: 'card guide-card', id: 'guide-tab-' + c.id },
      h('summary', null, icon(c.id, 14), ' ', c.name),
      h('p', null, rich(c.does)),
      h('h3', { class: 'guide-sub' }, 'How to use it'),
      list('ol', c.steps),
      h('h3', { class: 'guide-sub' }, 'What it cannot do'),
      h('p', null, rich(c.cannot)),
      c.id === 'guide' ? null : h('div', { class: 'row' }, h('button', { class: 'sec-mini', on: { click: () => show(c.id) } }, 'Open ' + c.name))
    );
  };

  v.append(
    h(
      'div',
      { class: 'guide' },
      h('div', { class: 'home-hero' }, h('h2', null, 'How to use DevForge'), ...G.WHAT.map((t) => h('p', { class: 'sev-info' }, t))),
      h('nav', { class: 'row guide-jump', 'aria-label': 'Sections of this guide' }, ...sections.map(([id, label]) => h('button', { class: 'sec-mini', on: { click: () => jump(id) } }, label))),
      h('h2', { id: 'guide-first' }, 'First 5 minutes'),
      list('ol', G.FIRST_STEPS),
      h('h2', { id: 'guide-tabs' }, 'Every tab'),
      ...DF.tabs.map(tabCard),
      h('h2', { id: 'guide-problems' }, 'Common problems'),
      ...G.PROBLEMS.map((p) => h('details', { class: 'card guide-card' }, h('summary', null, p.q), h('p', null, rich(p.a)))),
      h('h2', { id: 'guide-privacy' }, 'Privacy: what stays on your computer'),
      list('ul', G.PRIVACY),
      h('h2', { id: 'guide-keys' }, 'Shortcuts'),
      h('dl', { class: 'guide-keys' }, ...G.SHORTCUTS.flatMap((s) => [h('dt', null, h('kbd', null, s.keys)), h('dd', null, s.does)])),
      h('h2', { id: 'guide-words' }, 'Glossary'),
      h('dl', { class: 'guide-words' }, ...G.GLOSSARY.flatMap((g) => [h('dt', null, g.term), h('dd', null, g.meaning)]))
    )
  );
});
