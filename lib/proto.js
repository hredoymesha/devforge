/*
 * Prototype helpers (pure). The visual editor keeps its changes as {selector: {property: value}}
 * and turns them into CSS here. Anything that could escape a declaration (braces, semicolons,
 * comments, closing tags) is refused rather than escaped.
 */
const DFProto = (() => {
  const okProp = (p) => typeof p === 'string' && /^(--[\w-]+|[a-z][a-z-]*)$/i.test(p) && p.length <= 80;
  const okValue = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 300 && !/[{};]|\/\*|<\/|\\0/.test(v);
  const okSelector = (s) => typeof s === 'string' && s.trim() !== '' && s.length <= 300 && !/[{};]|\/\*|<\/|\n/.test(s);

  // vars: { selector: { prop: value } } → { css, skipped: [reason, …] }
  function generateCss(vars) {
    const out = [];
    const skipped = [];
    for (const [sel, props] of Object.entries(vars || {})) {
      if (!okSelector(sel)) {
        skipped.push('selector refused: ' + String(sel).slice(0, 40));
        continue;
      }
      const decls = [];
      for (const [p, v] of Object.entries(props || {})) {
        if (v == null || v === '') continue;
        if (!okProp(p) || !okValue(String(v))) {
          skipped.push(sel + ' { ' + String(p).slice(0, 30) + ' } refused');
          continue;
        }
        decls.push('  ' + p + ': ' + String(v).trim() + ' !important;');
      }
      if (decls.length) out.push(sel + ' {\n' + decls.join('\n') + '\n}');
    }
    return { css: out.join('\n\n'), skipped };
  }

  // A line that applies the CSS from the DevTools console of any page.
  const consoleSnippet = (css) => '(() => { const s = new CSSStyleSheet(); s.replaceSync(' + JSON.stringify(css) + '); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; })();';

  // A Tampermonkey / Violentmonkey style userscript that re-applies the CSS (and optional JS) on a match.
  function userscript({ name, match, css, js }) {
    const safe = (s) => String(s || '').replace(/[\r\n]+/g, ' ');
    return ['// ==UserScript==', '// @name ' + safe(name || 'DevForge prototype'), '// @match ' + safe(match || '*://*/*'), '// @grant none', '// ==/UserScript==', '(() => {', "  'use strict';", '  const css = ' + JSON.stringify(css || '') + ';', "  const s = document.createElement('style');", '  s.textContent = css;', '  document.documentElement.append(s);', js ? '  ' + js.split('\n').join('\n  ') : '', '})();', ''].join('\n');
  }

  const unitValue = (n, unit) => (n === '' || n == null || isNaN(+n) ? '' : +n + (unit || 'px'));

  return { okProp, okValue, okSelector, generateCss, consoleSnippet, userscript, unitValue };
})();
if (typeof module !== 'undefined') module.exports = DFProto;
