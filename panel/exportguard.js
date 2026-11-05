// Secrets check before an export leaves the panel. The matching and masking are in
// lib/exportguard.js. This file asks the user what to do when something is found. Every export
// path calls guardFiles() or guardText() and stops if it returns null.

const GUARD_SHOWN = 8;

// Resolves to 'mask' | 'keep' | 'omit', or null for cancel.
function guardDialog(result, { allowOmit }) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const n = result.findings.length;
    const files = new Set(result.findings.map((f) => f.file)).size;
    const done = (choice) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (before && before.focus) before.focus();
      resolve(choice);
    };
    const option = (id, label, hint, primary) =>
      h('div', { class: 'guard-option' }, h('button', { id, class: primary ? 'primary' : '', on: { click: () => done(id.replace('guard-', '')) } }, label), h('span', { class: 'sev-info' }, hint));
    const list = result.findings.slice(0, GUARD_SHOWN).map((f) => h('li', null, DFExportGuard.describe(f)));
    if (n > GUARD_SHOWN) list.push(h('li', null, '…and ' + (n - GUARD_SHOWN) + ' more'));
    const cancel = h('button', { id: 'guard-cancel', on: { click: () => done(null) } }, 'Cancel');
    const overlay = h(
      'div',
      { class: 'guard-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'guard-title', 'aria-describedby': 'guard-body' },
      h(
        'div',
        { class: 'card' },
        h('b', { id: 'guard-title' }, 'Secrets check'),
        h('p', { id: 'guard-body' }, 'DevForge found ' + n + ' value' + (n === 1 ? '' : 's') + ' that look like secrets, in ' + files + ' file' + (files === 1 ? '' : 's') + '. It matches on shape, so some may be harmless. Nothing is sent anywhere. What should this export do?'),
        h('ul', { class: 'guard-list' }, ...list),
        option('guard-mask', 'Mask them', 'Replace each value with [REDACTED:type]. The rest stays as it is.', true),
        option('guard-keep', 'Keep, with a warning', 'Leave the files as they are and add a note that lists them.'),
        allowOmit ? option('guard-omit', 'Leave those files out', 'The files that contain a match are not exported.') : null,
        h('div', { class: 'row' }, cancel)
      )
    );
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      } else if (e.key === 'Tab') {
        const items = [...overlay.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
        e.preventDefault();
        items[next].focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    overlay.querySelector('#guard-mask').focus();
  });
}

// files: [{ path, data }]. Returns the files to export (possibly masked, with a report file added),
// or null when the user cancelled.
async function guardFiles(files, { allowOmit = true } = {}) {
  status('Checking files for secrets…');
  await sleep(0); // let the message paint before the scan blocks the panel
  let result;
  try {
    result = DFExportGuard.scan(files);
  } finally {
    status('');
  }
  if (!result.findings.length) return files;
  const choice = await guardDialog(result, { allowOmit });
  if (!choice) {
    toast('Export cancelled. Nothing was saved.');
    return null;
  }
  return DFExportGuard.apply(files, choice).files;
}

// One text: a single exported file or an AI prompt. Returns the text to use, or null on cancel.
async function guardText(text, name) {
  const result = DFExportGuard.checkText(text, name);
  if (!result.findings.length) return text;
  const choice = await guardDialog(result, { allowOmit: false });
  if (!choice) {
    toast('Cancelled. Nothing was saved or copied.');
    return null;
  }
  return choice === 'mask' ? DFExportGuard.maskText(text).text : text;
}

// A text download that has passed the check. Non-text data is saved as it is.
async function saveGuarded(name, data, type) {
  const safe = typeof data === 'string' ? await guardText(data, name) : data;
  if (safe == null) return;
  download(name, safe, type);
}
