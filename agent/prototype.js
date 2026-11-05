/*
 * UI prototyping. Injected after agent.js and registered through __DF.extend().
 *
 * Holds one override stylesheet for the page, created by the user in the Prototype tab. It is
 * temporary: it lives in this tab's memory and disappears on reload or Reset. Where the browser
 * allows it the sheet is "adopted" (document.adoptedStyleSheets) so no element is added to the
 * page's DOM; otherwise a <style> element is used and removed again on Reset.
 *
 * protoAnalyze() reads the page's own design (theme variables, fonts, framework, and the layout
 * context of the selected element) so the panel offers controls that fit it.
 */
(() => {
  const DF = window.__DF;
  if (!DF || DF.protoApply) return;
  const { target, clip, onDestroy, dom } = DF.kit;

  const st = { sheet: null, style: null, on: true, css: '', method: null };

  // Re-serialise every declaration of every style rule as !important, including those nested in @media / @supports.
  const important = (rules) => {
    for (const r of rules) {
      if (r.style) {
        for (const p of [...r.style]) r.style.setProperty(p, r.style.getPropertyValue(p), 'important');
      } else if (r.cssRules) important(r.cssRules);
    }
  };
  const collect = (rules, out) => {
    for (const r of rules) {
      if (r.selectorText != null && r.style) {
        let matches;
        try {
          matches = document.querySelectorAll(r.selectorText).length;
        } catch (_) {
          matches = -1;
        }
        out.push({ selector: clip(r.selectorText, 120), matches, declarations: r.style.length });
      } else if (r.cssRules) collect(r.cssRules, out);
    }
    return out;
  };

  function protoApply(css, opts = {}) {
    st.css = String(css || '').slice(0, 300000);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(st.css);
    if (opts.important !== false) important(sheet.cssRules);
    const text = [...sheet.cssRules].map((r) => r.cssText).join('\n');
    if (!st.sheet && !st.style) {
      try {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        st.sheet = sheet;
        st.method = 'adopted stylesheet (nothing added to the page)';
      } catch (_) {
        st.style = document.createElement('style');
        (document.head || document.documentElement).append(st.style);
        st.method = '<style> element';
      }
    } else if (st.sheet) {
      // Replace the old sheet with the new one, last so it wins ties. Done by removing and adding, not
      // by swapping in place: if the prototype was switched off the old sheet is not in the list.
      document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter((s) => s !== st.sheet), sheet];
      st.sheet = sheet;
    }
    if (st.style) st.style.textContent = text;
    st.on = true;
    return { method: st.method, rules: collect(sheet.cssRules, []).slice(0, 200), bytes: text.length };
  }

  function protoToggle(on) {
    st.on = on == null ? !st.on : !!on;
    if (st.sheet) {
      const rest = document.adoptedStyleSheets.filter((s) => s !== st.sheet);
      document.adoptedStyleSheets = st.on ? [...rest, st.sheet] : rest;
    }
    if (st.style) st.style.disabled = !st.on;
    return { on: st.on };
  }

  function protoClear() {
    if (st.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== st.sheet);
    if (st.style) dom.remove(st.style);
    st.sheet = st.style = null;
    st.css = '';
    st.method = null;
    st.on = true;
    return { cleared: true };
  }
  const protoState = () => ({ active: !!(st.sheet || st.style), on: st.on, method: st.method, bytes: st.css.length });
  onDestroy && onDestroy(protoClear);

  const FRAMEWORKS = [
    ['Tailwind CSS', /(^|\s)(flex|grid|hidden|px-\d|py-\d|mt-\d|mb-\d|text-(xs|sm|base|lg|xl)|bg-[a-z]+-\d{2,3}|rounded(-\w+)?)(\s|$)/],
    ['Bootstrap', /(^|\s)(container(-fluid)?|row|col(-\w+)?-\d+|btn(-\w+)?|navbar|card(-body)?)(\s|$)/],
    ['Bulma', /(^|\s)(is-primary|columns|column|hero|navbar-item)(\s|$)/],
  ];

  function protoAnalyze(h) {
    const el = h ? target(h) : null;
    const root = document.documentElement;
    const rcs = getComputedStyle(root);
    const bcs = getComputedStyle(document.body || root);

    // Theme variables the page declares on :root
    const names = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue; // cross-origin sheet
      }
      for (const r of rules || []) {
        if (r.selectorText && /(^|,)\s*(:root|html)\s*(,|$)/.test(r.selectorText) && r.style)
          for (const p of r.style) if (p.startsWith('--')) names.add(p);
      }
    }
    const vars = [...names].slice(0, 120).map((n) => {
      const value = rcs.getPropertyValue(n).trim();
      return { name: n, value: clip(value, 80), isColor: !!value && CSS.supports('color', value) };
    });

    const sample = [...document.querySelectorAll('[class]')].slice(0, 400).map((e) => String(dom.getAttribute(e, 'class')));
    const frameworks = FRAMEWORKS.filter(([, re]) => sample.filter((c) => re.test(c)).length >= 8).map(([n]) => n);

    const out = {
      theme: {
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        colorScheme: rcs.colorScheme || 'normal',
        vars,
        body: { fontFamily: clip(bcs.fontFamily, 100), fontSize: bcs.fontSize, lineHeight: bcs.lineHeight, color: bcs.color, background: bcs.backgroundColor },
        frameworks,
      },
      element: null,
    };
    if (!el) return out;
    const cs = getComputedStyle(el);
    const p = dom.parentElement(el);
    const pcs = p ? getComputedStyle(p) : null;
    const display = cs.display;
    const pDisplay = pcs ? pcs.display : '';
    const textual = [...dom.childNodes(el)].some((n) => dom.nodeType(n) === 3 && n.nodeValue.trim());
    const layout = {
      display,
      position: cs.position,
      isFlexContainer: /flex/.test(display),
      isGridContainer: /grid/.test(display),
      inFlex: /flex/.test(pDisplay),
      inGrid: /grid/.test(pDisplay),
      parentDisplay: pDisplay,
      parentDirection: pcs ? pcs.flexDirection : '',
      parentGap: pcs ? pcs.gap : '',
      textual,
      children: dom.children(el).length,
    };
    const props = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'fontFamily', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'borderTopLeftRadius', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'opacity', 'boxShadow', 'width', 'height', 'maxWidth', 'display', 'gap', 'flexDirection', 'justifyContent', 'alignItems', 'flexWrap', 'gridTemplateColumns', 'flexGrow', 'flexShrink', 'alignSelf', 'order', 'gridColumn', 'gridRow', 'overflow', 'zIndex'];
    const current = {};
    for (const k of props) current[k] = cs[k];
    // What fits here: only offer controls that make sense in this element's layout context.
    const groups = ['colors', 'size', 'spacing', 'border', 'effects'];
    if (textual) groups.unshift('typography');
    if (layout.isFlexContainer) groups.push('flex-container');
    if (layout.isGridContainer) groups.push('grid-container');
    if (layout.inFlex) groups.push('flex-item');
    if (layout.inGrid) groups.push('grid-item');
    out.element = { layout, current, groups, text: textual ? clip((dom.textContent(el) || '').trim(), 200) : '' };
    return out;
  }

  DF.extend({ protoApply, protoToggle, protoClear, protoState, protoAnalyze });
})();
