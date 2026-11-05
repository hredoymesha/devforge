// Security tab helpers: a Content-Security-Policy-Report-Only suggestion and Subresource Integrity
// tags, both generated from what the open page loads (lib/csp.js). They read the page and download
// third-party scripts and stylesheets that the page already uses, one at a time, twice each, with the
// usual size and time limits and the private-address guard. They change nothing on the page.

const SRI_MAX_FILES = 30;
const SRI_MAX_BYTES = 5 * 1024 * 1024;

async function sriDigest(bytes) {
  return DFCsp.integrityValue(new Uint8Array(await crypto.subtle.digest('SHA-384', bytes)), 'sha384');
}

// One third-party file: fetched twice, a pause apart. A file whose hash changes between the two is
// not safe to pin, so no tag is offered for it.
async function sriCheck(entry) {
  try {
    const first = await fetchBytes(entry.url, SRI_MAX_BYTES, 15000);
    await sleep(300);
    const second = await fetchBytes(entry.url, SRI_MAX_BYTES, 15000);
    const a = await sriDigest(first.bytes);
    const b = await sriDigest(second.bytes);
    if (a !== b) return { entry, state: 'changing', note: 'The file was different the second time it was fetched, so it cannot be pinned.' };
    const known = DFCsp.compare(entry.existing, a);
    return { entry, state: known === 'matches' ? 'matches' : known === 'differs' ? 'differs' : 'ok', integrity: a, bytes: first.bytes.length, existing: entry.existing };
  } catch (e) {
    return { entry, state: 'failed', note: e.message };
  }
}

function secHardeningCard() {
  const out = h('div', { id: 'hardening-out' });
  const copyBtn = (label, getText) => h('button', { class: 'sec-mini', on: { click: () => copy(getText()) } }, icon('copy', 12), ' ' + label);
  const shown = (u) => DFSafe.redactUrl(u);

  const cspRun = async () => {
    clear(out);
    const facts = await call('secCspFacts');
    const r = DFCsp.build(facts);
    out.append(
      h(
        'div',
        { class: 'card', id: 'csp-result' },
        h('div', { class: 'row' }, h('b', null, 'Content-Security-Policy-Report-Only'), tagEl('generated'), tagEl('inferred')),
        h('div', { class: 'sev-info' }, 'Built from what this page loaded just now. It is a starting point to test, not a finished policy.'),
        h('pre', { id: 'csp-header' }, r.header),
        h('div', { class: 'row' }, copyBtn('Copy header', () => r.header)),
        h('ul', null, ...r.rows.map((row) => h('li', null, mono(row.name), ' ', row.why))),
        h('b', null, 'Before you use it'),
        h('ul', null, ...r.notes.map((n) => h('li', null, n)))
      )
    );
  };

  const sriRun = async () => {
    clear(out);
    const facts = await call('secCspFacts');
    const tags = facts.tags.slice(0, SRI_MAX_FILES);
    if (!tags.length) return out.append(h('div', { class: 'card', id: 'sri-result' }, 'This page loads no scripts or stylesheets from other sites, so there is nothing to pin.'));
    const results = [];
    for (const [i, entry] of tags.entries()) {
      status('Subresource Integrity: fetching ' + (i + 1) + ' of ' + tags.length + '…');
      results.push(await sriCheck(entry));
      await sleep(250);
    }
    status('');
    const fixed = results.filter((r) => r.state === 'ok' || r.state === 'differs').map((r) => DFCsp.tag(r.entry, r.integrity));
    const label = { ok: ['sev-info', 'Add the integrity attribute'], matches: ['sev-ok', 'The integrity value on the page is correct'], differs: ['sev-warn', 'The integrity value on the page does not match the file now'], changing: ['sev-warn', 'Changes between requests'], failed: ['sev-warn', 'Could not be fetched'] };
    out.append(
      h(
        'div',
        { class: 'card', id: 'sri-result' },
        h('div', { class: 'row' }, h('b', null, 'Subresource Integrity'), tagEl('generated'), tagEl('inferred')),
        h('div', { class: 'sev-info' }, 'Each file was downloaded twice and hashed with SHA-384. The hash is of the file as DevForge received it now. The server must also allow cross-origin reads (Access-Control-Allow-Origin) or the browser will refuse the file once crossorigin is set. Test on a staging page first.'),
        h(
          'table',
          { class: 'compact' },
          h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Result'))),
          h(
            'tbody',
            null,
            ...results.map((r) => {
              const [cls, text] = label[r.state] || label.failed;
              return h('tr', null, h('td', null, mono(shown(r.entry.url))), h('td', { class: cls }, text, r.note ? ' (' + r.note + ')' : ''));
            })
          )
        ),
        fixed.length ? h('pre', { id: 'sri-tags' }, fixed.join('\n')) : '',
        fixed.length ? h('div', { class: 'row' }, copyBtn('Copy tags', () => fixed.join('\n'))) : '',
        results.length < facts.tags.length ? h('div', { class: 'sev-info' }, 'Only the first ' + SRI_MAX_FILES + ' of ' + facts.tags.length + ' files were checked.') : '',
        h('div', { class: 'sev-info' }, 'Query values that look like credentials are hidden in the table above. The tags use the address as the page has it, so check them before you paste.')
      )
    );
  };

  return h(
    'details',
    { class: 'card', id: 'hardening' },
    h('summary', null, icon('security', 14), ' ', h('b', null, 'Hardening helpers'), ' ', h('span', { class: 'sev-info' }, 'CSP Report-Only suggestion and Subresource Integrity tags')),
    h('div', { class: 'sev-info' }, 'Both are generated from what the open page loads. They read the page and, for Subresource Integrity, download the third-party scripts and stylesheets it already uses. Nothing is changed.'),
    h('div', { class: 'row' }, h('button', { id: 'btn-csp', 'aria-label': 'Build a CSP suggestion (a Report-Only policy from what this page loads)', on: { click: guard(cspRun) } }, 'Build a CSP suggestion'), h('button', { id: 'btn-sri', 'aria-label': 'Compute integrity hashes (Subresource Integrity tags for third-party files)', on: { click: guard(sriRun) } }, 'Compute integrity hashes')),
    out
  );
}
