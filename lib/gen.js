// Code generators for the tree produced by agent.recreate(). Output is generated markup, not the page's original source.
const DFGen = (() => {
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
  ]);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const ind = (n) => '  '.repeat(n);
  const cssSafe = (css) => String(css).replace(/</g, '\\3c '); // '<' is only valid inside CSS strings, where \3c is equivalent; blocks </style> breakout

  function html(node, depth = 0, opts = {}) {
    if (node.text != null) {
      const t = node.text;
      return /\S/.test(t) ? ind(depth) + esc(t.replace(/\s+/g, ' ').trim()) + '\n' : '';
    }
    const attrs = Object.entries(node.attrs)
      .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
      .join('');
    const cls = node.cls ? ` class="${node.cls}"` : '';
    const root = depth === 0 && opts.root ? ' data-df-root' : '';
    const open = `<${node.tag}${cls}${attrs}${root}>`;
    if (VOID.has(node.tag)) return ind(depth) + open + '\n';
    const kids = node.children.map((c) => html(c, depth + 1, opts)).join('');
    if (!kids) return ind(depth) + open + `</${node.tag}>\n`;
    if (node.children.length === 1 && node.children[0].text != null)
      return (
        ind(depth) +
        open +
        esc(node.children[0].text.replace(/\s+/g, ' ').trim()) +
        `</${node.tag}>\n`
      );
    return ind(depth) + open + '\n' + kids + ind(depth) + `</${node.tag}>\n`;
  }

  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const compName = (s) =>
    (s || 'Component')
      .replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase())
      .replace(/^[^A-Z]/, 'C$&');
  function jsxAttrKey(k) {
    const m = {
      class: 'className',
      for: 'htmlFor',
      tabindex: 'tabIndex',
      colspan: 'colSpan',
      rowspan: 'rowSpan',
      readonly: 'readOnly',
      maxlength: 'maxLength',
      autocomplete: 'autoComplete',
      crossorigin: 'crossOrigin',
      srcset: 'srcSet',
      viewbox: 'viewBox',
      'stroke-width': 'strokeWidth',
      'stroke-linecap': 'strokeLinecap',
      'stroke-linejoin': 'strokeLinejoin',
      'fill-rule': 'fillRule',
      'clip-rule': 'clipRule',
      'clip-path': 'clipPath',
      'stop-color': 'stopColor',
      'xlink:href': 'xlinkHref',
    };
    return m[k] || (k.startsWith('data-') || k.startsWith('aria-') ? k : camel(k));
  }
  function jsx(node, depth = 1) {
    if (node.text != null) {
      const t = node.text.replace(/\s+/g, ' ').trim();
      return t ? ind(depth) + '{' + JSON.stringify(t) + '}\n' : '';
    }
    const attrs = Object.entries(node.attrs)
      .filter(([k]) => k !== 'xmlns')
      .map(([k, v]) => (v === '' ? ` ${jsxAttrKey(k)}` : ` ${jsxAttrKey(k)}=${JSON.stringify(v)}`))
      .join('');
    const cls = node.cls ? ` className="${node.cls}"` : '';
    const open = `<${node.tag}${cls}${attrs}`;
    if (VOID.has(node.tag)) return ind(depth) + open + ' />\n';
    const kids = node.children.map((c) => jsx(c, depth + 1)).join('');
    if (!kids) return ind(depth) + open + ' />\n';
    return ind(depth) + open + '>\n' + kids + ind(depth) + `</${node.tag}>\n`;
  }

  function twArb(style) {
    return Object.entries(style)
      .map(([p, v]) => `[${p}:${v.replace(/\s+/g, '_').replace(/[[\]]/g, '')}]`)
      .join(' ');
  }
  function tailwind(node, depth = 0, opts = {}) {
    if (node.text != null)
      return /\S/.test(node.text)
        ? ind(depth) + esc(node.text.replace(/\s+/g, ' ').trim()) + '\n'
        : '';
    const attrs = Object.entries(node.attrs)
      .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
      .join('');
    const cls = Object.keys(node.style).length ? ` class="${escAttr(twArb(node.style))}"` : '';
    const open = `<${node.tag}${cls}${attrs}${depth === 0 && opts.root ? ' data-df-root' : ''}>`;
    if (VOID.has(node.tag)) return ind(depth) + open + '\n';
    const kids = node.children.map((c) => tailwind(c, depth + 1, opts)).join('');
    return ind(depth) + open + (kids ? '\n' + kids + ind(depth) : '') + `</${node.tag}>\n`;
  }

  function page(tree, css, title, opts = {}) {
    return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${esc(title || 'Recreated component')}</title>\n  <style>\n${opts.reset === false ? '' : '    html,body{margin:0}\n'}${cssSafe(
      css
    )
      .split('\n')
      .map((l) => (l ? '    ' + l : l))
      .join(
        '\n'
      )}\n  </style>\n</head>\n<body>\n${html(tree, 1, { root: true })}</body>\n</html>\n`;
  }

  function generate(rec, target, name, meta) {
    const nm = compName(name);
    const tree = rec.tree,
      css = rec.css;
    meta = meta || {};
    switch (target) {
      case 'html':
        return {
          files: [
            { path: 'index.html', data: page(tree, css, name) },
            { path: 'styles.css', data: css },
            { path: 'body.html', data: html(tree, 0) },
          ],
        };
      case 'react': {
        const body = jsx(tree, 2);
        return {
          files: [
            {
              path: `${nm}.jsx`,
              data: `import './${nm}.css';\n\nexport default function ${nm}() {\n  return (\n${body.replace(/\n$/, '')}\n  );\n}\n`,
            },
            { path: `${nm}.css`, data: css },
            {
              path: 'README.md',
              data: 'Generated React component (functional, no dependencies beyond React). Static markup only: event handlers and application state were not reconstructed.\n',
            },
          ],
        };
      }
      case 'vue': {
        const body = html(tree, 1);
        return {
          files: [
            {
              path: `${nm}.vue`,
              data: `<template>\n${body}</template>\n\n<script setup>\n// Static markup. Behaviour was not reconstructed.\n</script>\n\n<style scoped>\n${cssSafe(css)}</style>\n`,
            },
          ],
        };
      }
      case 'svelte':
        return {
          files: [
            { path: `${nm}.svelte`, data: `${html(tree, 0)}\n<style>\n${cssSafe(css)}</style>\n` },
          ],
        };
      case 'tailwind':
        return {
          files: [
            {
              path: 'index.html',
              data: `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<script src="https://cdn.tailwindcss.com"></script>\n</head>\n<body>\n${tailwind(tree, 0, { root: true })}</body>\n</html>\n`,
            },
            {
              path: 'NOTE.md',
              data: "Tailwind output uses arbitrary-property utilities ([prop:value]) because computed styles do not map one-to-one onto Tailwind's design tokens. It is valid Tailwind (v3.1+), but verbose; refactor repeated groups into components or @apply by hand. Pseudo-elements (::before/::after) are not representable this way and are omitted.\n",
            },
          ],
        };
      case 'json':
        return {
          files: [{ path: 'structure.json', data: JSON.stringify({ tree, css }, null, 2) }],
        };
      default:
        throw new Error('Unknown target: ' + target);
    }
  }
  return { generate, html, page, compName };
})();
if (typeof module !== 'undefined') module.exports = DFGen;
