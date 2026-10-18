// Network tab extras: save the current capture to the Workspace, compare two captures, and copy
// any request as code. Saved captures are always redacted (tokens, cookies and secrets masked)
// and keep only a short preview of each body.

// The captured requests as plain, redacted records, with bodies where the page still holds them.
async function netSnapshotEntries(limit = 200) {
  await pollNet().catch(() => {}); // pick up whatever the page captured since the last poll
  const rows = [...net.rows.values()].filter((r) => ['fetch', 'xhr', 'websocket', 'sse', 'beacon'].includes(r.kind)).slice(0, limit);
  const out = [];
  for (let i = 0; i < rows.length; i += 10) {
    const part = await Promise.all(
      rows.slice(i, i + 10).map(async (r) => {
        let e = r;
        try {
          e = await fullEntry(r.id);
        } catch (_) {
          /* the request left the capture log: keep the summary */
        }
        return DFDiff.slimEntry(redactEntry(e));
      })
    );
    out.push(...part);
  }
  return out;
}

async function netSaveCapture() {
  await pollNet().catch(() => {}); // the page may have captured requests since the last poll
  if (!net.rows.size) throw new Error('Nothing is captured yet. Turn capture on, use the page, then save.');
  const entries = await busy('Saving capture', () => netSnapshotEntries());
  if (!entries.length) throw new Error('Only timing rows were captured (browser-initiated loads). Requests made by page scripts are needed.');
  let host = DF.state.url;
  try {
    host = new URL(DF.state.url).host;
  } catch (_) {
    /* keep the raw address */
  }
  const when = new Date();
  return saveToWorkspace('network', 'Network capture: ' + host + ' · ' + entries.length + ' requests · ' + when.toLocaleTimeString(), {
    capturedAt: when.toISOString(),
    pageUrl: redactUrl(DF.state.url),
    redacted: true,
    count: entries.length,
    entries,
  });
}

const netSavedCaptures = async () =>
  (await DFStore.allItems())
    .filter((i) => i.kind === 'network' && !i.locked && i.payload && Array.isArray(i.payload.entries))
    .sort((a, b) => b.created - a.created);

function netChangeLine(k, v) {
  if (k === 'requestHeaders' || k === 'responseHeaders') {
    const parts = [];
    for (const n of Object.keys(v.added)) parts.push('+' + n);
    for (const n of Object.keys(v.removed)) parts.push('−' + n);
    for (const [n, val] of Object.entries(v.changed)) parts.push(n + ': ' + String(val[0]).slice(0, 40) + ' → ' + String(val[1]).slice(0, 40));
    return [k === 'requestHeaders' ? 'Request headers' : 'Response headers', parts.join(' · ')];
  }
  const label = { status: 'Status', size: 'Size', ms: 'Time', body: 'Body length' }[k] || k;
  const f = (x) => (k === 'size' || k === 'body' ? fmtBytes(x) : k === 'ms' ? fmtMs(x) : String(x));
  return [label, f(v[0]) + ' → ' + f(v[1])];
}

function netCompareResult(d, labels) {
  const copyCurl = (e) => h('button', { class: 'sec-mini', title: 'Copy this request as cURL', on: { click: () => copy(DFHar.toCurl(e)) } }, icon('copy', 12), ' cURL');
  const simple = (list) =>
    table(
      ['Request', 'Status', ''],
      list.map((x) => [mono(x.key), String(x.entry.status == null ? '–' : x.entry.status), copyCurl(x.entry)]),
      { class: 'compact' }
    );
  const box = h('div', { id: 'net-cmp-result' });
  box.append(
    h('div', { class: 'card' + (d.added.length || d.removed.length || d.changed.length ? ' sev-warn' : ''), role: 'status' }, h('b', null, d.message), ' ', h('span', { class: 'sev-info' }, d.same + ' identical · ' + d.totals.a + ' vs ' + d.totals.b + ' requests')),
    h('div', { class: 'row' }, h('button', { on: { click: () => copy(DFDiff.capturesToMarkdown(d, labels)) } }, icon('copy', 13), ' Copy as Markdown'), h('button', { on: { click: () => download('network-compare-' + stamp() + '.json', JSON.stringify({ labels, message: d.message, added: d.added, removed: d.removed, changed: d.changed.map((c) => ({ key: c.key, changes: c.changes })) }, null, 2), 'application/json') } }, icon('download', 13), ' Download diff (.json)'))
  );
  if (d.changed.length)
    box.append(
      section(
        'Changed (' + d.changed.length + ')',
        d.changed.map((x) =>
          h('details', { class: 'card', open: d.changed.length <= 3 }, h('summary', null, mono(x.key)), table(['What', 'Change'], Object.entries(x.changes).map(([k, v]) => netChangeLine(k, v)), { class: 'compact' }), h('div', { class: 'row' }, copyCurl(x.after)))
        )
      )
    );
  if (d.added.length) box.append(section('Only in ' + labels.b + ' (' + d.added.length + ')', simple(d.added)));
  if (d.removed.length) box.append(section('Only in ' + labels.a + ' (' + d.removed.length + ')', simple(d.removed)));
  return box;
}

function captureCompareCard() {
  const out = h('div');
  const selA = h('select', { id: 'net-cmp-a', 'aria-label': 'First capture' });
  const selB = h('select', { id: 'net-cmp-b', 'aria-label': 'Second capture' });
  const ignoreQ = h('input', { type: 'checkbox', id: 'net-cmp-q' });
  const savedBox = h('div', { class: 'sev-info' });
  let items = [];
  const label = (i) => i.title.replace(/^Network capture: /, '');
  const fill = () => {
    for (const [sel, pick] of [[selA, items[1] || items[0]], [selB, items[0]]]) {
      clear(sel).append(h('option', { value: 'live' }, 'Live capture (now)'), ...items.map((i) => h('option', { value: i.id, selected: pick && i.id === pick.id }, label(i))));
      if (!pick) sel.value = 'live';
    }
    savedBox.textContent = items.length ? items.length + ' saved capture(s).' : 'No saved captures yet. Save one now, change something on the page, capture again, then compare.';
  };
  const resolve = async (v) => (v === 'live' ? { entries: await netSnapshotEntries(), name: 'Live capture' } : (() => { const it = items.find((i) => i.id === v); return it ? { entries: it.payload.entries, name: label(it) } : null; })());
  const compare = async () => {
    const [A, B] = await Promise.all([resolve(selA.value), resolve(selB.value)]);
    if (!A || !B) throw new Error('Choose two captures.');
    if (selA.value === selB.value && selA.value !== 'live') throw new Error('Choose two different captures.');
    const d = DFDiff.compareCaptures(A.entries, B.entries, { ignoreQuery: ignoreQ.checked });
    clear(out).append(netCompareResult(d, { a: A.name, b: B.name }));
  };
  const reload = async () => {
    items = await netSavedCaptures();
    fill();
  };
  reload().catch(() => (savedBox.textContent = 'Saved captures could not be read.'));
  return h(
    'details',
    { class: 'card', id: 'net-compare', on: { toggle: (e) => e.target.open && reload().catch(() => {}) } },
    h('summary', null, 'Saved captures and compare'),
    h('div', { class: 'sev-info' }, 'Save the current capture, make a change (a deploy, a setting, a login) and capture again. Saved captures are redacted and kept in the Workspace.'),
    h('div', { class: 'row' }, h('button', { id: 'net-save-capture', class: 'primary', on: { click: async () => { await netSaveCapture(); await reload(); } } }, icon('work', 13), ' Save current capture')),
    savedBox,
    h('div', { class: 'row' }, h('label', null, 'A ', selA), h('label', null, 'B ', selB)),
    h('div', { class: 'row' }, h('label', null, ignoreQ, ' ignore query strings'), h('button', { id: 'net-cmp-run', on: { click: compare } }, 'Compare')),
    out
  );
}
