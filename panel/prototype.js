// Prototype tab: try front-end changes on the page you are looking at, without touching its code.
//
// Two ways to work, one result:
//   Visual dashboard  pick an element, change colours / type / spacing / layout with controls that
//                     fit the element's own layout context (flex, grid, text) and the site's theme.
//   Code editor       write CSS (and, if you allow it, JavaScript) directly.
// Both feed one override stylesheet that is held only in this tab's memory. Reload or Reset and the
// page is exactly as the site made it. The panel does not change the page's files or storage.

// Runs in the page's own world. Reports whether the script ran, was blocked by the site's
// Content-Security-Policy, or threw.
function runPrototypeScript(code) {
  const tag = '_' + Math.random().toString(36).slice(2);
  const res = { ran: false, blocked: false, error: null };
  const onErr = (e) => (res.error = String(e.detail));
  const onDone = () => (res.ran = true);
  const onCsp = () => (res.blocked = true);
  const onWin = (e) => {
    if (!res.error) res.error = e.message;
  };
  document.addEventListener(tag + 'e', onErr);
  document.addEventListener(tag + 'd', onDone);
  document.addEventListener('securitypolicyviolation', onCsp);
  window.addEventListener('error', onWin);
  const s = document.createElement('script');
  s.textContent = '(function(){try{\n' + code + '\n}catch(e){document.dispatchEvent(new CustomEvent("' + tag + 'e",{detail:String((e&&e.stack)||e)}))}})();document.dispatchEvent(new CustomEvent("' + tag + 'd"));';
  (document.head || document.documentElement).append(s);
  s.remove();
  document.removeEventListener(tag + 'e', onErr);
  document.removeEventListener(tag + 'd', onDone);
  document.removeEventListener('securitypolicyviolation', onCsp);
  window.removeEventListener('error', onWin);
  return res;
}

const PROTO_CONTROLS = {
  typography: ['Text', [['font-size', 'Font size', 'num', ['px', 'rem', 'em', '%']], ['font-weight', 'Weight', 'sel', ['300', '400', '500', '600', '700', '800']], ['line-height', 'Line height', 'num', ['', 'px', 'em']], ['letter-spacing', 'Letter spacing', 'num', ['px', 'em']], ['text-align', 'Align', 'sel', ['left', 'center', 'right', 'justify']], ['font-family', 'Font', 'text', 'e.g. Georgia, serif']]],
  colors: ['Colours', [['color', 'Text colour', 'color'], ['background-color', 'Background', 'color']]],
  size: ['Size and display', [['display', 'Display', 'sel', ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none']], ['width', 'Width', 'text', 'e.g. 320px, 50%, auto'], ['height', 'Height', 'text', 'e.g. 48px, auto'], ['max-width', 'Max width', 'text', 'e.g. 720px']]],
  spacing: ['Spacing', [['padding', 'Padding', 'text', 'one to four values, e.g. 8px 16px'], ['margin', 'Margin', 'text', 'e.g. 0 auto']]],
  border: ['Border and corners', [['border-radius', 'Corner radius', 'num', ['px', '%', 'rem']], ['border', 'Border', 'text', 'e.g. 1px solid #ccc']]],
  effects: ['Effects', [['opacity', 'Opacity', 'range'], ['box-shadow', 'Shadow', 'text', 'e.g. 0 2px 8px rgba(0,0,0,.2)']]],
  'flex-container': ['Flex container (this element lays out its children)', [['flex-direction', 'Direction', 'sel', ['row', 'row-reverse', 'column', 'column-reverse']], ['justify-content', 'Justify', 'sel', ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']], ['align-items', 'Align items', 'sel', ['stretch', 'flex-start', 'center', 'flex-end', 'baseline']], ['flex-wrap', 'Wrap', 'sel', ['nowrap', 'wrap']], ['gap', 'Gap', 'num', ['px', 'rem']]]],
  'grid-container': ['Grid container', [['grid-template-columns', 'Columns', 'text', 'e.g. repeat(3, 1fr)'], ['gap', 'Gap', 'num', ['px', 'rem']]]],
  'flex-item': ['Flex item (inside a flex parent)', [['flex-grow', 'Grow', 'num', ['']], ['flex-shrink', 'Shrink', 'num', ['']], ['align-self', 'Align self', 'sel', ['auto', 'flex-start', 'center', 'flex-end', 'stretch']], ['order', 'Order', 'num', ['']]]],
  'grid-item': ['Grid item (inside a grid parent)', [['grid-column', 'Column', 'text', 'e.g. span 2'], ['grid-row', 'Row', 'text', 'e.g. 1 / 3']]],
};

registerTab('proto', 'Prototype', async (v) => {
  const PR = (DF.state.proto = DF.state.proto || { variants: [{ name: 'Variant A', vars: {}, css: '', js: '' }], cur: 0, mode: 'visual', important: true, allowJs: false, sel: null, analysis: null, closed: new Set() });
  const variant = () => PR.variants[PR.cur];
  const hasWork = () => Object.keys(variant().vars).length > 0 || variant().css.trim() !== '';

  const resultBox = h('div', { id: 'proto-result', role: 'status', 'aria-live': 'polite' });
  const stateLine = h('div', { class: 'sev-info', id: 'proto-state' });
  const body = h('div');
  let timer = null;

  const fullCss = () => {
    const g = DFProto.generateCss(variant().vars);
    return { css: [g.css, variant().css].filter(Boolean).join('\n\n'), skipped: g.skipped, generated: g.css };
  };

  async function apply() {
    try {
      const { css, skipped } = fullCss();
      if (!css.trim()) {
        await call('protoClear');
        clear(resultBox).append(h('div', { class: 'sev-info' }, 'Nothing to apply yet.'));
        return refreshState();
      }
      const r = await call('protoApply', css, { important: PR.important });
      clear(resultBox).append(
        h('div', { class: 'sev-info' }, r.rules.length + ' rule(s) applied · ' + r.method),
        skipped.length ? h('div', { class: 'sev-warn' }, 'Not applied: ' + skipped.join('; ')) : '',
        r.rules.some((x) => x.matches === 0 || x.matches === -1)
          ? h('div', { class: 'sev-warn' }, 'These rules match nothing on this page: ' + r.rules.filter((x) => x.matches <= 0).map((x) => x.selector + (x.matches < 0 ? ' (invalid selector)' : '')).join(', '))
          : '',
        r.rules.length ? h('details', null, h('summary', null, 'Rules and how many elements each matches'), table(['Selector', 'Matches', 'Declarations'], r.rules.map((x) => [mono(x.selector), String(x.matches < 0 ? '?' : x.matches), String(x.declarations)]), { class: 'compact' })) : ''
      );
      refreshState();
    } catch (e) {
      clear(resultBox).append(h('div', { class: 'sev-error' }, 'Could not apply: ' + e.message));
    }
  }
  const sched = () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  };
  async function refreshState() {
    try {
      const s = await call('protoState');
      stateLine.textContent = s.active ? (s.on ? 'Prototype is showing on the page.' : 'Original is showing (prototype switched off).') : hasWork() ? 'Not applied to the page yet (or the page was reloaded). Press Apply.' : 'Nothing applied.';
      toggleBtn.textContent = s.on ? 'Show original' : 'Show prototype';
      toggleBtn.disabled = !s.active;
    } catch (e) {
      stateLine.textContent = e.message;
    }
  }

  /* ---------- visual dashboard ---------- */
  const selectorKey = () => PR.sel || (DF.state.info && DF.state.info.selectors[0] && DF.state.info.selectors[0].selector) || null;
  function setProp(prop, value) {
    const sel = selectorKey();
    if (!sel) return toast('Pick an element first.');
    const vars = variant().vars;
    vars[sel] = vars[sel] || {};
    if (value === '' || value == null) delete vars[sel][prop];
    else vars[sel][prop] = value;
    if (!Object.keys(vars[sel]).length) delete vars[sel];
    sched();
    drawGenerated();
  }
  const valueOf = (prop) => {
    const sel = selectorKey();
    return ((variant().vars[sel] || {})[prop]) || '';
  };
  const currentOf = (prop) => {
    const el = PR.analysis && PR.analysis.element;
    if (!el) return '';
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return el.current[camel] || '';
  };
  const hexOf = (cssColor) => {
    const c = DFContrast.parse(cssColor || '');
    return c ? DFContrast.hex(c) : '#000000';
  };

  function control([prop, label, kind, extra]) {
    const id = 'proto-' + prop;
    const val = valueOf(prop);
    let input;
    if (kind === 'color') {
      const vars = ((PR.analysis && PR.analysis.theme.vars) || []).filter((x) => x.isColor);
      const text = h('input', { type: 'text', id, class: 'mono', value: val, placeholder: currentOf(prop), 'aria-label': label, on: { change: (e) => setProp(prop, e.target.value.trim()) } });
      const pick = h('input', { type: 'color', value: hexOf(val || currentOf(prop)), 'aria-label': label + ' picker', on: { input: (e) => { text.value = e.target.value; setProp(prop, e.target.value); } } });
      const theme = vars.length
        ? h('select', { 'aria-label': label + ': site theme colour', on: { change: (e) => { if (e.target.value) { text.value = 'var(' + e.target.value + ')'; setProp(prop, text.value); } e.target.value = ''; } } }, h('option', { value: '' }, 'site theme…'), vars.map((x) => h('option', { value: x.name }, x.name + ' (' + x.value + ')')))
        : '';
      input = h('span', { class: 'row' }, pick, text, theme);
    } else if (kind === 'sel') {
      input = h('select', { id, 'aria-label': label, on: { change: (e) => setProp(prop, e.target.value) } }, h('option', { value: '' }, currentOf(prop) ? 'unchanged (' + currentOf(prop) + ')' : 'unchanged'), extra.map((o) => h('option', { value: o, selected: o === val }, o)));
    } else if (kind === 'num') {
      const m = /^(-?[\d.]+)([a-z%]*)$/i.exec(val);
      const n = h('input', { type: 'number', id, step: 'any', value: m ? m[1] : '', placeholder: currentOf(prop).replace(/[a-z%]+$/i, ''), 'aria-label': label });
      const u = h('select', { 'aria-label': label + ' unit' }, extra.map((x) => h('option', { value: x, selected: m && m[2] === x }, x || 'none')));
      const go = () => setProp(prop, DFProto.unitValue(n.value, u.value));
      n.addEventListener('input', go);
      u.addEventListener('change', go);
      input = h('span', { class: 'row' }, n, u);
    } else if (kind === 'range') {
      const out = h('span', { class: 'sev-info' }, val || currentOf(prop));
      input = h('span', { class: 'row' }, h('input', { type: 'range', id, min: 0, max: 1, step: 0.05, value: val || currentOf(prop) || 1, 'aria-label': label, on: { input: (e) => { out.textContent = e.target.value; setProp(prop, e.target.value); } } }), out);
    } else {
      input = h('input', { type: 'text', id, value: val, placeholder: extra || currentOf(prop), 'aria-label': label, on: { change: (e) => setProp(prop, e.target.value.trim()) } });
    }
    return h('div', { class: 'proto-field' }, h('label', { for: id }, label), input);
  }

  const generatedBox = h('pre', { id: 'proto-generated', class: 'code-box' });
  function drawGenerated() {
    const g = fullCss().generated;
    generatedBox.textContent = g || '/* the CSS your changes generate appears here */';
  }

  function visualView() {
    const out = h('div');
    const d = DF.state.info;
    const el = PR.analysis && PR.analysis.element;
    if (!d || !el) {
      out.append(h('div', { class: 'empty' }, h('p', null, 'Pick an element on the page to restyle it.'), h('button', { class: 'primary', id: 'proto-pick', on: { click: async () => { await startPick(); } } }, '⌖ Pick an element'), h('p', { class: 'sev-info' }, 'Or select one in the Inspect tab, then come back and press “Analyse selection”.')));
      return out;
    }
    const sels = d.selectors.slice(0, 5);
    if (!PR.sel || !sels.some((s) => s.selector === PR.sel)) PR.sel = sels[0].selector;
    const L = el.layout;
    out.append(
      h('div', { class: 'card' }, h('div', null, h('b', null, '<' + d.tag + '>'), ' ', h('span', { class: 'sev-info' }, L.display + (L.inFlex ? ' · item in a flex ' + (L.parentDirection || 'row') : L.inGrid ? ' · item in a grid' : '') + (L.isFlexContainer ? ' · flex container' : L.isGridContainer ? ' · grid container' : '') + (L.textual ? ' · has text' : '') + ' · ' + L.children + ' child element(s)')), h('div', { class: 'row' }, h('label', null, 'Apply to ', h('select', { id: 'proto-sel', on: { change: (e) => { PR.sel = e.target.value; draw(); } } }, sels.map((s) => h('option', { value: s.selector, selected: s.selector === PR.sel }, s.selector + (s.matches != null ? ' (' + s.matches + ')' : ''))))), h('button', { on: { click: () => { delete variant().vars[selectorKey()]; sched(); draw(); } } }, 'Reset this element'))),
      h('div', { class: 'sev-info' }, 'Only controls that fit this element\'s layout are shown. Values you leave empty stay as the site made them.')
    );
    for (const g of el.groups) {
      const spec = PROTO_CONTROLS[g];
      if (!spec) continue;
      out.append(h('details', { class: 'card', open: !PR.closed.has(g), on: { toggle: (e) => (e.target.open ? PR.closed.delete(g) : PR.closed.add(g)) } }, h('summary', null, spec[0]), spec[1].map(control)));
    }
    if (L.textual) {
      const ta = h('textarea', { rows: 2, id: 'proto-text', 'aria-label': 'Text content' });
      ta.value = el.text;
      out.append(h('details', { class: 'card' }, h('summary', null, 'Text content'), ta, h('div', { class: 'row' }, h('button', { id: 'proto-text-apply', on: { click: async () => { await call('edit', { h: DF.state.h, kind: 'text', value: ta.value }); toast('Text changed on the page (undo: Inspect → History, or Reset page).'); } } }, 'Apply text'), h('span', { class: 'sev-info' }, 'Replaces all text inside this element.'))));
    }
    out.append(section('CSS generated by the dashboard', generatedBox, h('div', { class: 'row' }, h('button', { on: { click: () => copy(fullCss().generated) } }, icon('copy', 13), ' Copy'), h('button', { id: 'proto-to-code', title: 'Move the generated CSS into the code editor so you can edit it by hand', on: { click: () => { variant().css = [variant().css, fullCss().generated].filter(Boolean).join('\n\n'); variant().vars = {}; PR.mode = 'code'; draw(); sched(); } } }, 'Edit as code'))));
    drawGenerated();
    return out;
  }

  /* ---------- code editor ---------- */
  function codeView() {
    const out = h('div');
    const css = h('textarea', { id: 'proto-css', rows: 12, spellcheck: 'false', 'aria-label': 'CSS', class: 'mono' });
    css.value = variant().css;
    const live = h('input', { type: 'checkbox', id: 'proto-live', checked: PR.live !== false, on: { change: (e) => (PR.live = e.target.checked) } });
    css.addEventListener('input', () => {
      variant().css = css.value;
      if (PR.live !== false) sched();
    });
    css.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        apply();
      }
    });
    const vars = ((PR.analysis && PR.analysis.theme.vars) || []).slice(0, 80);
    const js = h('textarea', { id: 'proto-js', rows: 7, spellcheck: 'false', 'aria-label': 'JavaScript', class: 'mono', placeholder: "document.querySelector('h1').textContent = 'New headline';" });
    js.value = variant().js;
    js.addEventListener('input', () => (variant().js = js.value));
    const jsBox = h('div');
    const drawJs = () => {
      clear(jsBox);
      if (!PR.allowJs) return;
      jsBox.append(
        h('div', { class: 'sev-warn' }, 'JavaScript runs inside the page with the page\'s own permissions, like typing it in the DevTools console. It can change anything the page can reach, and Reset cannot undo what it does; reloading the page can. Sites with a strict Content-Security-Policy refuse it.'),
        js,
        h('div', { class: 'row' }, h('button', { id: 'proto-run-js', class: 'primary', on: { click: async () => {
          const r = await exec(runPrototypeScript, [variant().js], 'MAIN');
          clear(resultBox).append(r.blocked ? h('div', { class: 'sev-warn' }, 'The page\'s Content-Security-Policy blocked the script. Styles and the visual dashboard still work here.') : r.error ? h('div', { class: 'sev-error' }, 'The script threw: ' + r.error) : r.ran ? h('div', { class: 'sev-ok' }, 'Script ran.') : h('div', { class: 'sev-warn' }, 'The script did not run (a syntax error or a blocked inline script).'));
        } } }, 'Run JavaScript'))
      );
    };
    out.append(
      h('div', { class: 'sev-info' }, 'Write CSS as you would in a stylesheet. It is applied on top of the site\'s own CSS and goes away on reload.'),
      css,
      h('div', { class: 'row' }, h('button', { id: 'proto-apply', class: 'primary', on: { click: apply } }, 'Apply (Ctrl+Enter)'), h('label', { for: 'proto-live' }, live, ' apply as I type'), h('label', { for: 'proto-imp' }, h('input', { type: 'checkbox', id: 'proto-imp', checked: PR.important, on: { change: (e) => { PR.important = e.target.checked; sched(); } } }), ' make every declaration !important so it wins over the site')),
      vars.length ? h('details', null, h('summary', null, 'The site\'s theme variables (' + vars.length + ')'), h('div', { class: 'sev-info' }, 'Use them as var(--name) so your changes follow the site\'s theme, including dark mode.'), table(['Variable', 'Value', ''], vars.map((x) => [mono(x.name), h('span', null, x.isColor ? h('i', { class: 'swatch', style: { background: x.value } }) : '', ' ' + x.value), h('button', { class: 'sec-mini', on: { click: () => copy('var(' + x.name + ')') } }, 'Copy')]), { class: 'compact' })) : '',
      h('label', { class: 'sec-ack', for: 'proto-allowjs' }, h('input', { type: 'checkbox', id: 'proto-allowjs', checked: PR.allowJs, on: { change: (e) => { PR.allowJs = e.target.checked; drawJs(); } } }), ' Also let me run JavaScript'),
      jsBox
    );
    drawJs();
    return out;
  }

  /* ---------- analysis ---------- */
  async function analyse() {
    PR.analysis = await call('protoAnalyze', DF.state.h || null);
    draw();
  }
  function analysisCard() {
    const a = PR.analysis;
    if (!a) return h('div', { class: 'sev-info' }, 'Press “Analyse page” to read the site\'s theme and the layout around the selected element, so the controls fit.');
    const t = a.theme;
    return h(
      'div',
      { class: 'card', id: 'proto-analysis' },
      h('div', null, h('b', null, 'This page: '), (t.frameworks.length ? t.frameworks.join(', ') + ' · ' : '') + t.vars.length + ' theme variable(s) · ' + (t.prefersDark ? 'dark scheme preferred' : 'light scheme') + ' · body ' + t.body.fontSize + ' ' + t.body.fontFamily.split(',')[0]),
      h('div', { class: 'sev-info' }, 'Your changes are written as rules for the selected element only, so the rest of the layout, theme and structure stay as they are.')
    );
  }

  /* ---------- variants and export ---------- */
  function variantBar() {
    const sel = h('select', { id: 'proto-variant', 'aria-label': 'Variant', on: { change: async (e) => { PR.cur = +e.target.value; await apply(); draw(); } } }, PR.variants.map((x, i) => h('option', { value: i, selected: i === PR.cur }, x.name)));
    const name = h('input', { type: 'text', value: variant().name, maxlength: 40, 'aria-label': 'Variant name', on: { change: (e) => { variant().name = e.target.value.trim() || variant().name; draw(); } } });
    return h(
      'div',
      { class: 'row' },
      h('label', null, 'Variant ', sel),
      name,
      h('button', { id: 'proto-new', on: { click: () => { PR.variants.push({ name: 'Variant ' + String.fromCharCode(65 + PR.variants.length % 26), vars: {}, css: '', js: '' }); PR.cur = PR.variants.length - 1; apply(); draw(); } } }, 'New'),
      h('button', { on: { click: () => { const c = JSON.parse(JSON.stringify(variant())); c.name += ' copy'; PR.variants.push(c); PR.cur = PR.variants.length - 1; apply(); draw(); } } }, 'Duplicate'),
      PR.variants.length > 1 ? h('button', { on: { click: () => { PR.variants.splice(PR.cur, 1); PR.cur = 0; apply(); draw(); } } }, 'Delete') : ''
    );
  }
  function exportBar() {
    const css = () => fullCss().css;
    return h(
      'div',
      { class: 'row' },
      h('button', { on: { click: () => (css() ? copy(css()) : toast('Nothing to copy yet.')) } }, icon('copy', 13), ' Copy CSS'),
      h('button', { on: { click: () => (css() ? download('prototype-' + slug(variant().name) + '.css', css(), 'text/css') : toast('Nothing to export yet.')) } }, icon('download', 13), ' .css'),
      h('button', { title: 'One line you can paste into any page\'s DevTools console', on: { click: () => (css() ? copy(DFProto.consoleSnippet(css())) : toast('Nothing to copy yet.')) } }, 'Copy console snippet'),
      h('button', { title: 'For Tampermonkey or Violentmonkey: re-applies this on every visit', on: { click: () => { let m = '*://*/*'; try { m = '*://' + new URL(DF.state.url).host + '/*'; } catch (_) { /* keep the wildcard */ } download('prototype-' + slug(variant().name) + '.user.js', DFProto.userscript({ name: 'DevForge prototype: ' + variant().name, match: m, css: css(), js: PR.allowJs ? variant().js : '' }), 'text/javascript'); } } }, 'Userscript'),
      h('button', { id: 'proto-save', on: { click: async () => { await saveToWorkspace('prototype', 'Prototype: ' + variant().name + ' (' + (() => { try { return new URL(DF.state.url).host; } catch (_) { return 'page'; } })() + ')', { url: DF.state.url, name: variant().name, css: css(), js: variant().js, vars: variant().vars }); } } }, icon('work', 13), ' Save to Workspace')
    );
  }

  // A pending auto-apply (started by a field losing focus as this button was pressed) must not
  // switch the prototype back on right after the person asked for the original.
  const toggleBtn = h('button', { id: 'proto-toggle', on: { click: async () => { clearTimeout(timer); await call('protoToggle'); refreshState(); } } }, 'Show original');

  function draw() {
    clear(body);
    body.append(
      analysisCard(),
      variantBar(),
      h('div', { class: 'tabs', role: 'tablist' }, [['visual', 'Visual dashboard'], ['code', 'Code editor']].map(([id, label]) => h('button', { role: 'tab', id: 'proto-mode-' + id, 'aria-selected': String(PR.mode === id), class: PR.mode === id ? 'on' : '', on: { click: () => { PR.mode = id; draw(); } } }, label))),
      PR.mode === 'visual' ? visualView() : codeView(),
      resultBox,
      exportBar()
    );
  }

  v.append(
    h('div', { class: 'sev-info' }, 'Try a design change on this page without editing the site. Everything here is temporary: it exists only in this tab and vanishes on reload or Reset.'),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', id: 'proto-analyse', on: { click: analyse } }, 'Analyse page and selection'),
      h('button', { on: { click: startPick } }, '⌖ Pick an element'),
      toggleBtn,
      h('button', { id: 'proto-reset', class: 'danger', on: { click: async () => { await call('protoClear'); try { await call('resetAll'); } catch (_) { /* nothing was edited in the Inspect tab */ } variant().vars = {}; variant().css = ''; clear(resultBox); draw(); refreshState(); toast('Page restored.'); } } }, 'Reset page')
    ),
    stateLine,
    body
  );
  if (!PR.analysis && DF.state.h) await analyse().catch(() => draw());
  else draw();
  refreshState();
});
