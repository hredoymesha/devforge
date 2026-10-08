// Static checks for pasted code (HTML, CSS, JS, JSON). Nothing is executed.
const DFValidate = (() => {
  const VOID = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'source',
    'track',
    'wbr',
    'param',
  ]);

  function extractBlocks(text) {
    const blocks = [];
    const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text))) {
      let lang = (m[1] || '').toLowerCase();
      const code = m[2];
      if (!lang)
        lang = /^\s*</.test(code)
          ? 'html'
          : /[{;]\s*$/m.test(code) &&
              /:\s*[^;]+;/.test(code) &&
              !/function|const |let |=>/.test(code)
            ? 'css'
            : 'js';
      if (lang === 'javascript') lang = 'js';
      if (lang === 'jsx') lang = 'jsx';
      if (lang === 'htm') lang = 'html';
      blocks.push({ lang, code });
    }
    if (!blocks.length && text.trim())
      blocks.push({
        lang: /^\s*</.test(text) ? 'html' : 'js',
        code: text,
        note: 'No code fence found; treating the whole reply as code.',
      });
    return blocks;
  }

  function html(code) {
    const issues = [];
    const stack = [];
    const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let m;
    const ids = {};
    const stripped = code.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, (s) =>
      s.replace(/[^<>/\w\s]/g, ' ')
    );
    while ((m = re.exec(stripped))) {
      if (m[0].startsWith('<!--')) continue;
      const closing = !!m[1],
        tag = m[2].toLowerCase(),
        attrs = m[3] || '';
      const line = stripped.slice(0, m.index).split('\n').length;
      if (!closing) {
        const idm0 = attrs.match(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
        const idm = idm0 && [null, idm0[1] || idm0[2] || idm0[3]];
        if (idm && idm[1]) {
          if (ids[idm[1]])
            issues.push({
              severity: 'error',
              rule: 'duplicate-id',
              message: `Duplicate id "${idm[1]}"`,
              line,
            });
          ids[idm[1]] = 1;
        }
        if (tag === 'img' && !/\salt\s*=/.test(attrs))
          issues.push({ severity: 'warn', rule: 'img-alt', message: '<img> missing alt', line });
        if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, line });
      } else if (!VOID.has(tag)) {
        const i = stack.map((s) => s.tag).lastIndexOf(tag);
        if (i === -1)
          issues.push({
            severity: 'error',
            rule: 'unexpected-close',
            message: `Closing </${tag}> has no opening tag`,
            line,
          });
        else {
          if (i !== stack.length - 1)
            stack.slice(i + 1).forEach((s) =>
              issues.push({
                severity: 'error',
                rule: 'unclosed',
                message: `<${s.tag}> opened on line ${s.line} is not closed before </${tag}>`,
                line,
              })
            );
          stack.length = i;
        }
      }
    }
    stack.forEach((s) => {
      if (!/^(li|p|td|th|tr|dd|dt|option|tbody|thead|tfoot|body|html|head)$/.test(s.tag))
        issues.push({
          severity: 'error',
          rule: 'unclosed',
          message: `<${s.tag}> opened on line ${s.line} is never closed`,
          line: s.line,
        });
    });
    return issues;
  }

  function css(code) {
    const issues = [];
    let depth = 0,
      inStr = null,
      inCom = false;
    for (let i = 0; i < code.length; i++) {
      const c = code[i],
        n = code[i + 1];
      if (inCom) {
        if (c === '*' && n === '/') {
          inCom = false;
          i++;
        }
        continue;
      }
      if (inStr) {
        if (c === '\\') i++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '/' && n === '*') {
        inCom = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = c;
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        depth--;
        if (depth < 0) {
          issues.push({
            severity: 'error',
            rule: 'brace',
            message: 'Unmatched }',
            line: code.slice(0, i).split('\n').length,
          });
          depth = 0;
        }
      }
    }
    if (depth > 0)
      issues.push({ severity: 'error', rule: 'brace', message: depth + ' unclosed { block(s)' });
    if (inCom) issues.push({ severity: 'error', rule: 'comment', message: 'Unterminated comment' });
    // declarations: use CSS.supports where available
    if (typeof CSS !== 'undefined' && CSS.supports) {
      const body = code.replace(/\/\*[\s\S]*?\*\//g, '');
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(body))) {
        if (/^\s*@(font-face|keyframes|page)/.test(m[1]) === false && /^\s*@/.test(m[1])) continue;
        m[2].split(';').forEach((d) => {
          const i = d.indexOf(':');
          if (i < 1) {
            if (d.trim())
              issues.push({
                severity: 'error',
                rule: 'declaration',
                message: `Malformed declaration "${d.trim().slice(0, 50)}"`,
              });
            return;
          }
          const p = d.slice(0, i).trim(),
            v = d
              .slice(i + 1)
              .replace(/!important/i, '')
              .trim();
          if (p.startsWith('--')) return;
          if (!CSS.supports(p, v))
            issues.push({
              severity: 'warn',
              rule: 'unsupported',
              message: `Browser rejects "${p}: ${v.slice(0, 40)}" (typo, vendor-specific, or unsupported value)`,
            });
        });
        try {
          document.createDocumentFragment().querySelector(
            m[1]
              .trim()
              .split(',')
              .map((s) => s.trim().replace(/::?[\w-]+(\([^)]*\))?/g, ''))
              .join(',') || '*'
          );
        } catch (e) {
          if (!/^\s*[@\d%]|from|to/.test(m[1]))
            issues.push({
              severity: 'error',
              rule: 'selector',
              message: `Invalid selector "${m[1].trim().slice(0, 60)}"`,
            });
        }
      }
    }
    return issues;
  }

  function js(code, acornLib) {
    const issues = [];
    const A = acornLib || (typeof acorn !== 'undefined' ? acorn : null);
    if (!A) return [{ severity: 'warn', rule: 'parser', message: 'JS parser unavailable' }];
    let ok = false,
      lastErr;
    for (const st of ['script', 'module']) {
      try {
        A.parse(code, {
          ecmaVersion: 'latest',
          sourceType: st,
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
        });
        ok = true;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!ok)
      issues.push({
        severity: 'error',
        rule: 'syntax',
        message: lastErr.message,
        line: lastErr.loc && lastErr.loc.line,
      });
    const pats = [
      [/\beval\s*\(/, 'eval() executes arbitrary strings'],
      [/new\s+Function\s*\(/, 'new Function() executes arbitrary strings'],
      [/document\.write\s*\(/, 'document.write is discouraged and can inject markup'],
      [/\.innerHTML\s*=/, 'innerHTML assignment: ensure content is trusted/escaped'],
      [/\.outerHTML\s*=/, 'outerHTML assignment: ensure content is trusted'],
      [/insertAdjacentHTML/, 'insertAdjacentHTML: ensure content is trusted'],
      [/setTimeout\s*\(\s*['"`]/, 'setTimeout with a string evaluates code'],
      [/localStorage|sessionStorage|document\.cookie/, 'Reads/writes browser storage or cookies'],
      [/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/, 'Makes network requests'],
      [/https?:\/\/(?!localhost)[\w.-]+/, 'References external URLs'],
    ];
    pats.forEach(([re, msg]) => {
      if (re.test(code)) issues.push({ severity: 'info', rule: 'security-pattern', message: msg });
    });
    return issues;
  }

  // Cross references: selectors/ids used in JS or CSS that do not exist in the supplied HTML
  function crossRefs(htmlCode, cssCode, jsCode) {
    const issues = [];
    if (!htmlCode) return issues;
    const ids = new Set(),
      classes = new Set();
    for (const m of htmlCode.matchAll(/\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi))
      ids.add(m[1] || m[2] || m[3]);
    for (const m of htmlCode.matchAll(
      /\sclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
    ))
      (m[1] || m[2] || m[3] || '').split(/\s+/).forEach((c) => c && classes.add(c));
    if (jsCode) {
      (jsCode.match(/getElementById\(\s*['"]([^'"]+)['"]/g) || []).forEach((x) => {
        const id = x.match(/['"]([^'"]+)['"]/)[1];
        if (!ids.has(id))
          issues.push({
            severity: 'warn',
            rule: 'missing-id',
            message: `JS references id "${id}" which is not in the HTML`,
          });
      });
      (jsCode.match(/querySelector(All)?\(\s*['"]([^'"]+)['"]/g) || []).forEach((x) => {
        const s = x.match(/['"]([^'"]+)['"]/)[1];
        (s.match(/#[\w-]+/g) || []).forEach((i) => {
          if (!ids.has(i.slice(1)))
            issues.push({
              severity: 'warn',
              rule: 'missing-id',
              message: `JS selector "${s}" uses id ${i} not found in the HTML`,
            });
        });
        (s.match(/\.[\w-]+/g) || []).forEach((c) => {
          if (!classes.has(c.slice(1)))
            issues.push({
              severity: 'warn',
              rule: 'missing-class',
              message: `JS selector "${s}" uses class ${c} not found in the HTML`,
            });
        });
      });
    }
    if (cssCode) {
      const used = new Set();
      (cssCode.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.[a-zA-Z_][\w-]*/g) || []).forEach((c) =>
        used.add(c.slice(1))
      );
      const missing = [...used].filter((c) => !classes.has(c) && !/^\d/.test(c));
      if (missing.length && classes.size)
        issues.push({
          severity: 'info',
          rule: 'css-unused-class',
          message: `${missing.length} CSS class(es) not present in the HTML: ${missing.slice(0, 8).join(', ')}`,
        });
    }
    return issues;
  }

  function review(text, acornLib) {
    const blocks = extractBlocks(text);
    const out = blocks.map((b) => ({
      ...b,
      issues:
        b.lang === 'html'
          ? html(b.code)
          : b.lang === 'css'
            ? css(b.code)
            : /^(js|jsx|ts|tsx|json)$/.test(b.lang)
              ? b.lang === 'json'
                ? jsonCheck(b.code)
                : b.lang === 'js'
                  ? js(b.code, acornLib)
                  : [
                      {
                        severity: 'info',
                        rule: 'unchecked',
                        message:
                          b.lang + ' cannot be syntax-checked in the browser without a compiler.',
                      },
                    ]
              : [
                  {
                    severity: 'info',
                    rule: 'unchecked',
                    message: 'No validator for "' + b.lang + '".',
                  },
                ],
    }));
    const h = out
        .filter((b) => b.lang === 'html')
        .map((b) => b.code)
        .join('\n'),
      c = out
        .filter((b) => b.lang === 'css')
        .map((b) => b.code)
        .join('\n'),
      j = out
        .filter((b) => b.lang === 'js')
        .map((b) => b.code)
        .join('\n');
    const cross = crossRefs(h, c, j);
    const all = out.flatMap((b) => b.issues).concat(cross);
    return {
      blocks: out,
      cross,
      counts: {
        error: all.filter((i) => i.severity === 'error').length,
        warn: all.filter((i) => i.severity === 'warn').length,
        info: all.filter((i) => i.severity === 'info').length,
      },
    };
  }
  function jsonCheck(code) {
    try {
      JSON.parse(code);
      return [];
    } catch (e) {
      return [{ severity: 'error', rule: 'json', message: e.message }];
    }
  }

  return { extractBlocks, html, css, js, crossRefs, review };
})();
if (typeof module !== 'undefined') module.exports = DFValidate;
