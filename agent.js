/*
 * Page agent. Injected into the active tab only when the panel needs it, in the isolated world.
 * Everything it returns is plain JSON. Values that are guesses rather than readings carry a
 * provenance tag: observed | extracted | inferred | generated | unavailable.
 */
(() => {
  if (window.__DF && window.__DF.version) return;

  const MAX_NODES = 20000;
  const state = {
    selected: null,
    picking: false,
    overlay: null,
    hoverBox: null,
    overrides: new Map(), // key -> {el, prop, before, after}
    undo: [],
    redo: [],
    styleEl: null,
    mutations: [],
    mo: null,
    changeLog: [],
  };

  // helpers
  const isEl = (n) => n && n.nodeType === 1;
  const lc = (s) => (s || '').toLowerCase();
  const clip = (s, n = 400) =>
    s == null ? '' : String(s).length > n ? String(s).slice(0, n) + '…' : String(s);
  const safe = (fn, fallback = null) => {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  };
  const prov = (value, provenance, extra) => ({ value, provenance, ...(extra || {}) });

  function parentOf(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null; // pierce shadow boundary
  }

  function deepestAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // selector generation + stability scoring
  const AUTO_ID =
    /(\d{4,}|[a-f0-9]{8,}|^:r|^ember\d|^react-|__|css-[a-z0-9]{5,}|^radix-|^headlessui-)/i;
  const AUTO_CLASS =
    /(^css-[a-z0-9]{5,}$|^sc-[a-zA-Z]{5,}|^_[a-zA-Z0-9]{5,}$|^[a-z]{1,2}[A-Za-z0-9]{6,}$|\d{4,}|^jsx-\d+|^svelte-[a-z0-9]+$|^[A-Za-z]+_[A-Za-z]+__[A-Za-z0-9_-]{5}$)/;

  function cssEsc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1');
  }
  function countMatches(root, sel) {
    return safe(() => root.querySelectorAll(sel).length, -1);
  }

  function selectorsFor(el) {
    const root = el.getRootNode ? el.getRootNode() : document;
    const scope = root.querySelectorAll ? root : document;
    const out = [];
    const tag = lc(el.tagName);
    const unique = (sel) => countMatches(scope, sel) === 1 && scope.querySelector(sel) === el;

    if (el.id) {
      const sel = '#' + cssEsc(el.id);
      if (unique(sel))
        out.push({ kind: 'id', selector: sel, score: AUTO_ID.test(el.id) ? 45 : 92 });
    }
    for (const a of [
      'data-testid',
      'data-test',
      'data-cy',
      'data-qa',
      'data-test-id',
      'aria-label',
      'name',
      'role',
      'type',
      'placeholder',
      'title',
      'alt',
      'href',
    ]) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v || v.length > 80) continue;
      const sel = `${tag}[${a}="${v.replace(/"/g, '\\"')}"]`;
      if (unique(sel)) {
        const base =
          a.startsWith('data-test') || a === 'data-cy' || a === 'data-qa'
            ? 90
            : a === 'aria-label' || a === 'name'
              ? 78
              : 60;
        out.push({ kind: 'attribute', selector: sel, score: base });
        break;
      }
    }
    const stable = [...(el.classList || [])].filter((c) => !AUTO_CLASS.test(c));
    if (stable.length) {
      for (let n = 1; n <= Math.min(3, stable.length); n++) {
        const sel =
          tag +
          stable
            .slice(0, n)
            .map((c) => '.' + cssEsc(c))
            .join('');
        if (unique(sel)) {
          out.push({ kind: 'class', selector: sel, score: 70 - (n - 1) * 3 });
          break;
        }
      }
    }
    // structural path (always works, fragile)
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && isEl(cur) && depth < 12) {
      const p = cur.parentElement;
      let part = lc(cur.tagName);
      if (cur.id && !AUTO_ID.test(cur.id) && countMatches(document, '#' + cssEsc(cur.id)) === 1) {
        parts.unshift('#' + cssEsc(cur.id));
        break;
      }
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = p;
      depth++;
      if (!p) break;
    }
    const pathSel = parts.join(' > ');
    out.push({
      kind: 'path',
      selector: pathSel,
      score: Math.max(8, 38 - parts.length * 3),
      verified: safe(() => scope.querySelector(pathSel) === el, false),
    });
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const xp = xpathFor(el);
    out.push({ kind: 'xpath', selector: xp, score: txt && txt.length < 40 ? 55 : 30 });
    if (txt && txt.length > 0 && txt.length < 40 && !el.children.length) {
      out.push({
        kind: 'xpath-text',
        selector: `//${tag}[normalize-space(.)=${xpathStr(txt)}]`,
        score: 50,
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  function xpathStr(s) {
    return s.includes("'")
      ? s.includes('"')
        ? `concat('${s.split("'").join(`',"'",'`)}')`
        : `"${s}"`
      : `'${s}'`;
  }
  function xpathFor(el) {
    const parts = [];
    let cur = el;
    while (cur && isEl(cur)) {
      const p = cur.parentElement;
      const same = p ? [...p.children].filter((c) => c.tagName === cur.tagName) : [cur];
      parts.unshift(lc(cur.tagName) + (same.length > 1 ? `[${same.indexOf(cur) + 1}]` : ''));
      cur = p;
    }
    return '/' + parts.join('/');
  }
  function stabilityLabel(score) {
    return score >= 80 ? 'Stable' : score >= 50 ? 'Medium' : 'Fragile';
  }

  // element registry (stable handles across calls)
  const handles = new Map(); // handle -> WeakRef(element)
  const handleIds = new WeakMap(); // element -> handle (no expando on page nodes)
  let handleSeq = 1,
    sinceSweep = 0;
  function sweepHandles() {
    for (const [k, r] of handles) {
      const e = r.deref();
      if (!e || !e.isConnected) handles.delete(k);
    }
  }
  function handleOf(el) {
    let id = handleIds.get(el);
    if (!id) {
      id = 'h' + handleSeq++;
      handleIds.set(el, id);
    }
    if (!handles.has(id)) handles.set(id, new WeakRef(el));
    if (++sinceSweep >= 500) {
      sinceSweep = 0;
      sweepHandles();
    }
    return id;
  }
  function byHandle(h) {
    const r = handles.get(h);
    const el = r && r.deref();
    return el && el.isConnected ? el : null;
  }
  function target(h) {
    const el = h ? byHandle(h) : state.selected;
    if (!el || !el.isConnected)
      throw new Error(
        'Element is no longer in the page (it may have been removed or re-rendered). Re-select it.'
      );
    return el;
  }

  // picker
  function ensureOverlay() {
    if (state.overlay) return;
    const host = document.createElement('div');
    host.id = '__df_overlay_host';
    host.style.cssText =
      'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const sh = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;border:2px solid #4f8cff;background:rgba(79,140,255,.18);display:none;pointer-events:none;box-sizing:border-box;font:11px monospace';
    const label = document.createElement('div');
    label.style.cssText =
      'position:absolute;top:-20px;left:-2px;background:#4f8cff;color:#fff;padding:1px 5px;border-radius:2px;white-space:nowrap';
    box.appendChild(label);
    sh.appendChild(box);
    document.documentElement.appendChild(host);
    state.overlay = host;
    state.hoverBox = { box, label };
  }
  function drawBox(el, fixedLabel) {
    ensureOverlay();
    const { box, label } = state.hoverBox;
    if (!el || !el.getBoundingClientRect) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    label.textContent =
      fixedLabel ||
      lc(el.tagName) +
        (el.id ? '#' + el.id : '') +
        ' ' +
        Math.round(r.width) +
        '×' +
        Math.round(r.height);
  }
  const onMove = (e) => {
    if (!state.picking) return;
    const el = deepestAt(e.clientX, e.clientY);
    if (el && el !== state.overlay) drawBox(el);
  };
  const onClick = (e) => {
    if (!state.picking) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = deepestAt(e.clientX, e.clientY);
    if (el && el !== state.overlay) {
      select(el);
      stopPick();
      try {
        chrome.runtime.sendMessage({ type: 'df:selected', handle: handleOf(el) });
      } catch (_) {
        /* panel closed */
      }
    }
  };
  const onKey = (e) => {
    if (state.picking && e.key === 'Escape') {
      stopPick();
      try {
        chrome.runtime.sendMessage({ type: 'df:pick-cancelled' });
      } catch (_) {}
    }
  };
  const blockers = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'contextmenu'];
  const blockEv = (e) => {
    if (state.picking) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }
  };
  function startPick() {
    if (state.picking) return { ok: true };
    state.picking = true;
    ensureOverlay();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    blockers.forEach((n) => document.addEventListener(n, blockEv, true));
    return { ok: true };
  }
  function stopPick() {
    state.picking = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    blockers.forEach((n) => document.removeEventListener(n, blockEv, true));
    if (state.hoverBox) state.hoverBox.box.style.display = 'none';
    return { ok: true };
  }
  function select(el) {
    state.selected = el;
    handleOf(el);
    drawBox(el, 'selected');
  }

  function selectBySelector(sel, kind) {
    let el = null;
    if (kind === 'xpath')
      el = document.evaluate(
        sel,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;
    else el = document.querySelector(sel);
    if (!el)
      throw new Error('No element matches that ' + (kind === 'xpath' ? 'XPath' : 'selector') + '.');
    select(el);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return describe(el);
  }

  function relative(h, dir) {
    const el = target(h);
    let n = null;
    if (dir === 'parent') n = parentOf(el);
    else if (dir === 'child')
      n = el.firstElementChild || (el.shadowRoot && el.shadowRoot.firstElementChild);
    else if (dir === 'next') n = el.nextElementSibling;
    else if (dir === 'prev') n = el.previousElementSibling;
    if (!n || !isEl(n)) throw new Error('No ' + dir + ' element.');
    select(n);
    return describe(n);
  }

  // DOM tree
  function nodeBrief(el) {
    return {
      h: handleOf(el),
      tag: lc(el.tagName),
      id: el.id || '',
      cls:
        typeof el.className === 'string'
          ? el.className
          : (el.getAttribute && el.getAttribute('class')) || '',
      kids: el.children.length + (el.shadowRoot ? 1 : 0),
      shadow: !!el.shadowRoot,
      text: el.children.length ? '' : clip((el.textContent || '').trim(), 40),
      frame: el.tagName === 'IFRAME' || el.tagName === 'FRAME',
    };
  }
  function children(h) {
    const el = h ? target(h) : document.documentElement;
    const out = [...el.children].map(nodeBrief);
    let shadow = null;
    if (el.shadowRoot) shadow = [...el.shadowRoot.children].map(nodeBrief);
    let frame = null;
    if (el.tagName === 'IFRAME') {
      try {
        const d = el.contentDocument;
        frame = d
          ? prov('accessible', 'observed')
          : prov('cross-origin iframe: content not accessible from this context', 'unavailable');
        if (d) out.push(...[...d.documentElement.children].map(nodeBrief));
      } catch (_) {
        frame = prov('cross-origin iframe', 'unavailable');
      }
    }
    return { nodes: out.slice(0, 500), truncated: out.length > 500, shadow, frame };
  }
  function ancestry(el) {
    const chain = [];
    let c = el,
      n = 0;
    while (c && n++ < 60) {
      chain.unshift({
        h: handleOf(c),
        label:
          lc(c.tagName) +
          (c.id ? '#' + c.id : '') +
          (c.classList && c.classList.length ? '.' + [...c.classList].slice(0, 2).join('.') : ''),
      });
      c = parentOf(c);
    }
    return chain;
  }

  function search(q, mode) {
    const res = [];
    if (!q) return res;
    try {
      if (mode === 'xpath') {
        const it = document.evaluate(
          q,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        for (let i = 0; i < Math.min(it.snapshotLength, 200); i++) {
          const n = it.snapshotItem(i);
          if (isEl(n)) res.push(nodeBrief(n));
        }
      } else if (mode === 'css') {
        document.querySelectorAll(q).forEach((n, i) => {
          if (i < 200) res.push(nodeBrief(n));
        });
      } else {
        const ql = q.toLowerCase();
        const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
        let n = 0;
        while (w.nextNode() && n++ < MAX_NODES && res.length < 200) {
          const el = w.currentNode;
          const hay = (
            lc(el.tagName) +
            ' ' +
            el.id +
            ' ' +
            (el.getAttribute('class') || '') +
            ' ' +
            (el.children.length ? '' : el.textContent)
          ).toLowerCase();
          if (hay.includes(ql)) res.push(nodeBrief(el));
        }
      }
    } catch (e) {
      throw new Error('Invalid ' + mode + ' query: ' + e.message);
    }
    return res;
  }

  // describe (inspector)
  function contextInfo(el) {
    const cs = getComputedStyle(el);
    const out = {};
    // positioning context
    let c = parentOf(el),
      pos = 'initial containing block';
    while (c && isEl(c)) {
      const p = getComputedStyle(c).position;
      if (p !== 'static') {
        pos = lc(c.tagName) + (c.id ? '#' + c.id : '');
        break;
      }
      c = parentOf(c);
    }
    out.positioningContext = prov(cs.position === 'static' ? 'n/a (static)' : pos, 'observed');
    // stacking context
    const reasons = [];
    const stackingOf = (s, e) => {
      const r = [];
      if (s.position !== 'static' && s.zIndex !== 'auto') r.push('positioned + z-index');
      if (s.position === 'fixed' || s.position === 'sticky') r.push(s.position);
      if (parseFloat(s.opacity) < 1) r.push('opacity<1');
      if (s.transform !== 'none') r.push('transform');
      if (s.filter !== 'none') r.push('filter');
      if (s.perspective !== 'none') r.push('perspective');
      if (s.isolation === 'isolate') r.push('isolation');
      if (s.mixBlendMode !== 'normal') r.push('mix-blend-mode');
      if (/(transform|opacity|filter)/.test(s.willChange)) r.push('will-change');
      if (s.contain && /(layout|paint|strict|content)/.test(s.contain)) r.push('contain');
      const pe = e.parentElement && getComputedStyle(e.parentElement);
      if (pe && /(flex|grid)/.test(pe.display) && s.zIndex !== 'auto')
        r.push('flex/grid item + z-index');
      return r;
    };
    reasons.push(...stackingOf(cs, el));
    out.createsStackingContext = prov(reasons.length > 0, 'observed', { reasons });
    // nearest stacking context ancestor
    let a = parentOf(el),
      nearest = 'root';
    while (a && isEl(a)) {
      if (stackingOf(getComputedStyle(a), a).length) {
        nearest = lc(a.tagName) + (a.id ? '#' + a.id : '');
        break;
      }
      a = parentOf(a);
    }
    out.nearestStackingAncestor = prov(nearest, 'observed');
    out.zIndex = cs.zIndex;
    return out;
  }

  function a11yInfo(el) {
    const role = el.getAttribute('role') || implicitRole(el);
    let name = el.getAttribute('aria-label') || '';
    const lb = el.getAttribute('aria-labelledby');
    if (!name && lb)
      name = lb
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? n.textContent.trim() : '';
        })
        .join(' ')
        .trim();
    if (!name && el.labels && el.labels.length)
      name = [...el.labels].map((l) => l.textContent.trim()).join(' ');
    if (!name && el.tagName === 'IMG') name = el.getAttribute('alt') || '';
    if (!name && /^(A|BUTTON|SUMMARY|LABEL)$/.test(el.tagName))
      name = (el.textContent || '').trim();
    if (!name) name = el.getAttribute('title') || '';
    const aria = {};
    for (const a of el.attributes) if (a.name.startsWith('aria-')) aria[a.name] = a.value;
    return {
      role: prov(role || null, role ? 'inferred' : 'unavailable'),
      accessibleName: prov(clip(name, 200) || null, name ? 'inferred' : 'unavailable', {
        note: 'Approximation of the accessible-name algorithm, not the browser accessibility tree.',
      }),
      aria,
      tabbable: el.tabIndex >= 0,
      tabIndex: el.tabIndex,
    };
  }
  function implicitRole(el) {
    const t = lc(el.tagName);
    const map = {
      a: el.hasAttribute('href') ? 'link' : null,
      button: 'button',
      nav: 'navigation',
      main: 'main',
      header: 'banner',
      footer: 'contentinfo',
      aside: 'complementary',
      form: 'form',
      ul: 'list',
      ol: 'list',
      li: 'listitem',
      table: 'table',
      img: el.getAttribute('alt') === '' ? 'presentation' : 'img',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      select: 'combobox',
      textarea: 'textbox',
      dialog: 'dialog',
      section: null,
      article: 'article',
    };
    if (t === 'input') {
      const ty = lc(el.type);
      return (
        {
          checkbox: 'checkbox',
          radio: 'radio',
          button: 'button',
          submit: 'button',
          range: 'slider',
          search: 'searchbox',
          email: 'textbox',
          text: 'textbox',
          password: 'textbox',
        }[ty] || 'textbox'
      );
    }
    return map[t] || null;
  }

  function pseudoInfo(el) {
    const out = {};
    for (const p of ['::before', '::after', '::marker', '::placeholder', '::first-line']) {
      const s = safe(() => getComputedStyle(el, p));
      if (!s) continue;
      const content = s.content;
      if (p === '::before' || p === '::after') {
        if (content && content !== 'none' && content !== 'normal')
          out[p] = {
            content,
            display: s.display,
            color: s.color,
            position: s.position,
            width: s.width,
            height: s.height,
          };
      }
    }
    return out;
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = clip(a.value, 300);
    const sels = selectorsFor(el);
    return {
      h: handleOf(el),
      tag: lc(el.tagName),
      ancestry: ancestry(el),
      attributes: prov(attrs, 'observed'),
      id: el.id || '',
      classes: [...(el.classList || [])],
      htmlPreview: clip(el.outerHTML, 2500),
      htmlLength: el.outerHTML.length,
      text: clip((el.textContent || '').trim().replace(/\s+/g, ' '), 300),
      inShadow: !!(el.getRootNode && el.getRootNode().host),
      shadowRoot: el.shadowRoot
        ? prov('open', 'observed')
        : prov('none or closed (closed roots cannot be inspected)', 'unavailable'),
      box: {
        x: Math.round(r.x * 10) / 10,
        y: Math.round(r.y * 10) / 10,
        width: Math.round(r.width * 10) / 10,
        height: Math.round(r.height * 10) / 10,
        pageX: Math.round(r.x + scrollX),
        pageY: Math.round(r.y + scrollY),
        margin: [cs.marginTop, cs.marginRight, cs.marginBottom, cs.marginLeft],
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
        border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
        display: cs.display,
        position: cs.position,
      },
      typography: {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        color: cs.color,
        textAlign: cs.textAlign,
      },
      visual: {
        background: cs.backgroundColor,
        backgroundImage: clip(cs.backgroundImage, 200),
        boxShadow: cs.boxShadow,
        textShadow: cs.textShadow,
        transform: cs.transform,
        opacity: cs.opacity,
        borderRadius: cs.borderRadius,
        filter: cs.filter,
      },
      motion: {
        animationName: cs.animationName,
        animationDuration: cs.animationDuration,
        transition: cs.transition,
      },
      context: contextInfo(el),
      pseudo: pseudoInfo(el),
      accessibility: a11yInfo(el),
      form: formInfo(el),
      inlineHandlers: prov(inlineHandlers(el), 'observed', {
        note: 'Only on* attributes are observable. Listeners added with addEventListener are not enumerable from an extension content script.',
      }),
      framework: prov(detectFramework(el), 'inferred'),
      assets: assetsOf(el),
      selectors: sels.map((s) => ({ ...s, label: stabilityLabel(s.score) })),
      stabilityBasis:
        'Heuristic: ids/test attributes score high; auto-generated ids/classes, long structural paths and positional indexes score low. It is a ranking heuristic, not a measured probability.',
    };
  }
  function formInfo(el) {
    const f = el.form || (lc(el.tagName) === 'form' ? el : null);
    if (!f && !/^(input|select|textarea|button)$/.test(lc(el.tagName))) return null;
    return {
      name: el.name || null,
      type: el.type || null,
      required: !!el.required,
      disabled: !!el.disabled,
      form: f
        ? { action: f.getAttribute('action'), method: f.method, fields: f.elements.length }
        : null,
    };
  }
  function inlineHandlers(el) {
    const out = [];
    for (const a of el.attributes)
      if (/^on/i.test(a.name)) out.push({ attr: a.name, code: clip(a.value, 200) });
    return out;
  }
  function detectFramework(el) {
    const found = [];
    const keys = Object.keys(el);
    if (keys.some((k) => k.startsWith('__reactFiber') || k.startsWith('__reactProps')))
      found.push('React (fiber keys on element)');
    if (el.__vue__ || el.__vue_app__ || el._vnode || keys.some((k) => k.startsWith('__vue')))
      found.push('Vue');
    if (el.__svelte_meta || [...el.classList].some((c) => /^svelte-/.test(c))) found.push('Svelte');
    if (
      [...el.attributes].some((a) => /^_ng(content|host)|^ng-/.test(a.name)) ||
      el.hasAttribute('ng-version')
    )
      found.push('Angular');
    if (el.tagName.includes('-') && customElements.get(lc(el.tagName)))
      found.push('Custom element <' + lc(el.tagName) + '>');
    if (
      [...el.classList].some((c) =>
        /^(tw-|bg-|text-|flex$|grid$|p[xytblr]?-\d|m[xytblr]?-\d)/.test(c)
      )
    )
      found.push('Tailwind-style utility classes');
    if ([...el.classList].some((c) => /^(btn|container|row|col-)/.test(c)))
      found.push('Bootstrap-style classes');
    return found;
  }
  function absUrl(u) {
    return safe(() => new URL(u, document.baseURI).href, u);
  }
  function assetsOf(el) {
    const out = [];
    const walk = [el, ...el.querySelectorAll('*')].slice(0, 1500);
    for (const n of walk) {
      const t = lc(n.tagName);
      if (t === 'img' && (n.currentSrc || n.src))
        out.push({ type: 'image', url: n.currentSrc || n.src });
      if (t === 'source' && n.srcset)
        out.push({ type: 'image', url: absUrl(n.srcset.split(',')[0].trim().split(' ')[0]) });
      if (t === 'video' || t === 'audio')
        if (n.currentSrc) out.push({ type: 'media', url: n.currentSrc });
      if (t === 'svg') out.push({ type: 'svg-inline', url: null });
      if (t === 'use') {
        const hr = n.getAttribute('href') || n.getAttribute('xlink:href');
        if (hr) out.push({ type: 'svg-use', url: hr });
      }
      const bg = getComputedStyle(n).backgroundImage;
      const m = bg && bg.match(/url\((['"]?)(.*?)\1\)/g);
      if (m)
        m.forEach((u) =>
          out.push({
            type: 'background-image',
            url: absUrl(u.replace(/^url\((['"]?)|(['"]?)\)$/g, '')),
          })
        );
    }
    const seen = new Set();
    return out
      .filter((a) => {
        const k = a.type + a.url;
        if (seen.has(k) && a.url) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 200);
  }

  // CSS engine
  function specificity(sel) {
    // [a,b,c] for a single complex selector; strips :not()/:is() argument handling approximately
    let a = 0,
      b = 0,
      c = 0;
    let s = sel.replace(/\\./g, 'x').replace(/"[^"]*"|'[^']*'/g, '""');
    s = s.replace(/:(where)\([^)]*\)/g, '');
    s = s.replace(/:(not|is|has|matches)\(([^)]*)\)/g, (_, __, inner) => {
      const best = inner
        .split(',')
        .map(specificity)
        .sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0] || [0, 0, 0];
      a += best[0];
      b += best[1];
      c += best[2];
      return '';
    });
    s = s.replace(/\[[^\]]*\]/g, () => {
      b++;
      return '';
    });
    s = s.replace(/#[\w-]+/g, () => {
      a++;
      return '';
    });
    s = s.replace(/\.[\w-]+/g, () => {
      b++;
      return '';
    });
    s = s.replace(/::[\w-]+(\([^)]*\))?/g, () => {
      c++;
      return '';
    });
    s = s.replace(/:[\w-]+(\([^)]*\))?/g, () => {
      b++;
      return '';
    });
    s = s.replace(/[>+~]/g, ' ');
    s.split(/\s+/).forEach((t) => {
      if (/^[a-zA-Z][\w-]*$/.test(t)) c++;
    });
    return [a, b, c];
  }
  function cmpSpec(x, y) {
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }

  function sheetLabel(sheet, idx) {
    if (sheet.href) return sheet.href;
    const o = sheet.ownerNode;
    if (o && o.tagName === 'STYLE') return `<style> #${idx}` + (o.id ? ' (#' + o.id + ')' : '');
    return `adopted/constructed stylesheet #${idx}`;
  }

  function allSheets(rootNode) {
    const sheets = [];
    const roots = rootNode && rootNode.styleSheets ? rootNode : document;
    for (const s of roots.styleSheets) sheets.push(s);
    if (roots.adoptedStyleSheets) for (const s of roots.adoptedStyleSheets) sheets.push(s);
    return sheets;
  }

  function parseDecls(style) {
    const txt = style.cssText || '';
    const out = [];
    let cur = '',
      depth = 0,
      q = null;
    const flush = () => {
      const i = cur.indexOf(':');
      if (i > 0) {
        let v = cur.slice(i + 1).trim();
        const imp = /!\s*important\s*$/i.test(v);
        v = v.replace(/!\s*important\s*$/i, '').trim();
        out.push({ prop: cur.slice(0, i).trim(), value: v, important: imp });
      }
      cur = '';
    };
    for (const ch of txt) {
      if (q) {
        cur += ch;
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        q = ch;
        cur += ch;
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ';' && depth === 0) {
        flush();
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) flush();
    return out;
  }
  function matchedRules(el) {
    const root = el.getRootNode && el.getRootNode();
    const sheets = [...allSheets(root && root.styleSheets ? root : document)];
    if (root !== document) sheets.push(...allSheets(document)); // light-DOM sheets still can match via :host/::slotted; keep simple
    const matches = [];
    const blocked = [];
    let order = 0;
    sheets.forEach((sheet, si) => {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        blocked.push({
          source: sheetLabel(sheet, si),
          reason:
            'Cross-origin stylesheet: rules are blocked by the browser (no CORS access). Use "Fetch blocked stylesheets" to try the extension network path.',
        });
        return;
      }
      const walkRules = (list, ctx) => {
        for (const rule of list) {
          order++;
          if (rule.type === 1) {
            let hit = null;
            const sels = rule.selectorText.split(/,(?![^(]*\))/).map((s) => s.trim());
            for (const s of sels) {
              if (safe(() => el.matches(s), false)) {
                const sp = specificity(s);
                if (!hit || cmpSpec(sp, hit.spec) > 0) hit = { s, spec: sp };
              }
            }
            if (hit) {
              const decls = parseDecls(rule.style);
              matches.push({
                selector: hit.s,
                ruleSelector: rule.selectorText,
                specificity: hit.spec,
                source: sheetLabel(sheet, si),
                context: ctx.slice(),
                declarations: decls,
                order,
                cssText: rule.cssText,
              });
            }
          } else if (
            rule.type === 4 ||
            rule.type === 12 ||
            rule.type === 3 ||
            (rule.cssRules && rule.conditionText != null) ||
            rule.constructor.name === 'CSSContainerRule' ||
            rule.constructor.name === 'CSSLayerBlockRule'
          ) {
            let ok = true;
            if (rule.type === 4)
              ok = safe(
                () => matchMedia(rule.conditionText || rule.media.mediaText).matches,
                false
              );
            else if (rule.type === 12) ok = safe(() => CSS.supports(rule.conditionText), true);
            const label =
              rule.type === 4
                ? '@media ' + (rule.conditionText || rule.media.mediaText)
                : rule.type === 12
                  ? '@supports ' + rule.conditionText
                  : rule.cssText.split('{')[0].trim();
            walkRules(rule.cssRules, [...ctx, label + (ok ? '' : ' (not currently active)')]);
          }
        }
      };
      walkRules(rules, []);
    });
    return { matches, blocked };
  }

  function cssFor(el) {
    const { matches, blocked } = matchedRules(el);
    // cascade ordering: important, then specificity, then order
    const props = {};
    const rank = (m, d) => [
      d.important ? 1 : 0,
      m.specificity[0],
      m.specificity[1],
      m.specificity[2],
      m.order,
    ];
    const gt = (a, b) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
      return false;
    };
    for (const m of matches) {
      if (m.context.some((c) => c.includes('(not currently active)'))) continue;
      for (const d of m.declarations) {
        const r = rank(m, d);
        if (!props[d.prop] || gt(r, props[d.prop].rank))
          props[d.prop] = { rank: r, selector: m.selector, value: d.value, source: m.source };
      }
    }
    const inline = [];
    inline.push(...parseDecls(el.style));
    for (const d of inline)
      props[d.prop] = {
        rank: [d.important ? 2 : 1, 999, 0, 0, 1e9],
        selector: 'element.style',
        value: d.value,
        source: 'inline style attribute',
      };
    const winners = {};
    for (const [p, w] of Object.entries(props))
      winners[p] = { value: w.value, from: w.selector, source: w.source };
    // variables referenced
    const vars = {};
    const cs = getComputedStyle(el);
    const varNames = new Set();
    for (const m of matches)
      for (const d of m.declarations) {
        (d.value.match(/var\((--[\w-]+)/g) || []).forEach((v) => varNames.add(v.slice(4)));
        if (d.prop.startsWith('--')) varNames.add(d.prop);
      }
    inline.forEach((d) =>
      (d.value.match(/var\((--[\w-]+)/g) || []).forEach((v) => varNames.add(v.slice(4)))
    );
    varNames.forEach((v) => {
      vars[v] = cs.getPropertyValue(v).trim();
    });
    // inherited text properties
    const inherited = {};
    for (const p of [
      'color',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'text-align',
      'visibility',
      'cursor',
      'letter-spacing',
    ]) {
      if (!winners[p]) {
        let a = parentOf(el);
        while (a && isEl(a)) {
          const r = matchedRules(a).matches.find((m) => m.declarations.some((d) => d.prop === p));
          if (r) {
            inherited[p] = {
              value: getComputedStyle(el).getPropertyValue(p),
              inheritedFrom: lc(a.tagName) + (a.id ? '#' + a.id : ''),
            };
            break;
          }
          a = parentOf(a);
        }
      }
    }
    return {
      rules: matches.map((m) => ({
        selector: m.selector,
        specificity: m.specificity.join(','),
        source: m.source,
        context: m.context,
        declarations: m.declarations,
        order: m.order,
      })),
      winners,
      variables: vars,
      inherited,
      inline,
      blockedSheets: blocked,
      fonts: fontsOf(el),
      keyframes: keyframesFor(cs.animationName),
      confidence: blocked.length
        ? prov('partial', 'observed', {
            note:
              blocked.length +
              ' stylesheet(s) were unreadable, so some matching rules may be missing.',
          })
        : prov('complete for readable stylesheets', 'observed'),
      pseudoStates: prov(
        'Rules using :hover/:focus/:active are listed when their selector matches the current state; use "Force state" to toggle.',
        'observed'
      ),
    };
  }

  function fontsOf(el) {
    const cs = getComputedStyle(el);
    const fams = cs.fontFamily.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
    const faces = [];
    for (const sheet of allSheets(document)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      for (const r of rules)
        if (r.type === 5) {
          const fam = r.style.getPropertyValue('font-family').replace(/^["']|["']$/g, '');
          if (fams.includes(fam))
            faces.push({
              family: fam,
              src: clip(r.style.getPropertyValue('src'), 300),
              weight: r.style.getPropertyValue('font-weight'),
              style: r.style.getPropertyValue('font-style'),
            });
        }
    }
    const loaded = [];
    try {
      document.fonts.forEach((f) => {
        if (fams.includes(f.family.replace(/^["']|["']$/g, '')) && f.status === 'loaded')
          loaded.push({ family: f.family, weight: f.weight, style: f.style });
      });
    } catch (_) {}
    return { stack: fams, fontFaceRules: faces, loadedFaces: loaded };
  }
  function keyframesFor(names) {
    if (!names || names === 'none') return [];
    const want = names.split(',').map((s) => s.trim());
    const out = [];
    for (const sheet of allSheets(document)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      for (const r of rules)
        if (r.type === 7 && want.includes(r.name)) out.push({ name: r.name, css: r.cssText });
    }
    return out;
  }

  function computedAll(h) {
    const el = target(h);
    const cs = getComputedStyle(el);
    const o = {};
    for (let i = 0; i < cs.length; i++) o[cs[i]] = cs.getPropertyValue(cs[i]);
    return o;
  }

  // live edit with undo/redo + change tracking
  function ensureStyleEl() {
    if (!state.styleEl) {
      state.styleEl = document.createElement('style');
      state.styleEl.id = '__df_overrides';
      document.documentElement.appendChild(state.styleEl);
    }
  }
  function applyOp(op, dir) {
    // op kinds: style, text, html, attr, remove, hide, css-rule
    const el = op.h ? byHandle(op.h) : null;
    const v = dir === 'undo' ? 'before' : 'after';
    if (op.kind === 'style') {
      if (!el) throw new Error('Element no longer exists');
      const val = op[v];
      if (val == null || val === '') el.style.removeProperty(op.prop);
      else el.style.setProperty(op.prop, val, 'important');
    } else if (op.kind === 'text') {
      if (!el) throw new Error('Element no longer exists');
      if (dir === 'undo') el.innerHTML = op.beforeHTML;
      else el.textContent = op.after;
    } else if (op.kind === 'html') {
      if (!el) throw new Error('Element no longer exists');
      el.innerHTML = op[v];
    } else if (op.kind === 'attr') {
      if (!el) throw new Error('Element no longer exists');
      if (op[v] == null) el.removeAttribute(op.prop);
      else el.setAttribute(op.prop, op[v]);
    } else if (op.kind === 'css-rule') {
      ensureStyleEl();
      state.styleEl.textContent = op[v] || '';
    } else if (op.kind === 'remove') {
      if (dir === 'do') {
        if (!el) throw new Error('Element no longer exists');
        op._parent = el.parentNode;
        op._next = el.nextSibling;
        el.remove();
      } else if (op._parent) op._parent.insertBefore(op._node || el, op._next);
    }
  }
  function doOp(op) {
    if (op.kind === 'remove') {
      const el = byHandle(op.h);
      if (!el) throw new Error('Element no longer exists');
      op._node = el;
    }
    applyOp(op, 'do');
    state.undo.push(op);
    state.redo.length = 0;
    if (state.changeLog.length > 500) state.changeLog.splice(0, 100);
    if (state.undo.length > 1000) state.undo.splice(0, 200);
    state.changeLog.push({
      t: Date.now(),
      kind: op.kind,
      h: op.h,
      prop: op.prop,
      before: clip(op.before, 500),
      after: clip(op.after, 500),
      selector: op.selector,
    });
    return history();
  }
  function edit(spec) {
    const el = spec.h ? target(spec.h) : state.selected;
    if (!el) throw new Error('Nothing selected');
    const h = handleOf(el);
    const sel = (selectorsFor(el)[0] || {}).selector;
    let op;
    if (spec.kind === 'style')
      op = {
        kind: 'style',
        h,
        prop: spec.prop,
        before: el.style.getPropertyValue(spec.prop),
        after: spec.value,
        selector: sel,
      };
    else if (spec.kind === 'text')
      op = {
        kind: 'text',
        h,
        before: el.textContent,
        beforeHTML: el.innerHTML,
        after: spec.value,
        selector: sel,
      };
    else if (spec.kind === 'html')
      op = { kind: 'html', h, before: el.innerHTML, after: spec.value, selector: sel };
    else if (spec.kind === 'attr')
      op = {
        kind: 'attr',
        h,
        prop: spec.prop,
        before: el.getAttribute(spec.prop),
        after: spec.value,
        selector: sel,
      };
    else if (spec.kind === 'remove')
      op = { kind: 'remove', h, before: el.outerHTML, after: '', selector: sel };
    else if (spec.kind === 'css-rule') {
      ensureStyleEl();
      op = {
        kind: 'css-rule',
        before: state.styleEl.textContent,
        after: spec.value,
        selector: '(override stylesheet)',
      };
    } else throw new Error('Unknown edit kind ' + spec.kind);
    if (spec.kind === 'css-rule') {
      // validate CSS before applying
      const txt = String(spec.value || '');
      let dep = 0,
        qq = null,
        com = false;
      for (let i = 0; i < txt.length; i++) {
        const c = txt[i],
          n = txt[i + 1];
        if (com) {
          if (c === '*' && n === '/') {
            com = false;
            i++;
          }
          continue;
        }
        if (qq) {
          if (c === '\\') i++;
          else if (c === qq) qq = null;
          continue;
        }
        if (c === '/' && n === '*') {
          com = true;
          i++;
          continue;
        }
        if (c === '"' || c === "'") {
          qq = c;
          continue;
        }
        if (c === '{') dep++;
        if (c === '}') {
          dep--;
          if (dep < 0) throw new Error('Invalid CSS: unmatched }');
        }
      }
      if (dep !== 0) throw new Error('Invalid CSS: ' + dep + ' unclosed { block(s)');
      if (qq || com) throw new Error('Invalid CSS: unterminated ' + (com ? 'comment' : 'string'));
      if (txt.trim()) {
        const probe = new CSSStyleSheet();
        probe.replaceSync(txt);
        if (!probe.cssRules.length)
          throw new Error('Invalid CSS: the browser parsed no valid rules from this text.');
      }
    }
    return doOp(op);
  }
  function history() {
    return { undo: state.undo.length, redo: state.redo.length, log: state.changeLog.slice(-100) };
  }
  function undo() {
    const op = state.undo.pop();
    if (!op) throw new Error('Nothing to undo');
    applyOp(op, 'undo');
    state.redo.push(op);
    state.changeLog.push({
      t: Date.now(),
      kind: 'undo:' + op.kind,
      prop: op.prop,
      selector: op.selector,
    });
    return history();
  }
  function redo() {
    const op = state.redo.pop();
    if (!op) throw new Error('Nothing to redo');
    applyOp(op, 'do');
    state.undo.push(op);
    return history();
  }
  function resetAll() {
    while (state.undo.length) {
      const op = state.undo.pop();
      try {
        applyOp(op, 'undo');
      } catch (_) {}
    }
    state.redo.length = 0;
    if (state.styleEl) state.styleEl.textContent = '';
    state.changeLog.push({ t: Date.now(), kind: 'reset-all' });
    return history();
  }
  function patch() {
    const lines = [];
    for (const op of state.undo) {
      if (op.kind === 'style')
        lines.push(
          `${op.selector} { ${op.prop}: ${op.after}; } /* was: ${op.before || '(unset)'} */`
        );
      else if (op.kind === 'css-rule') lines.push('/* override stylesheet */\n' + op.after);
      else if (op.kind === 'text')
        lines.push(
          `/* text @ ${op.selector}\n--- ${clip(op.before, 200)}\n+++ ${clip(op.after, 200)} */`
        );
      else if (op.kind === 'attr')
        lines.push(`/* attr ${op.prop} @ ${op.selector}: ${op.before} -> ${op.after} */`);
      else if (op.kind === 'remove') lines.push(`/* removed ${op.selector} */`);
      else if (op.kind === 'html') lines.push(`/* innerHTML replaced @ ${op.selector} */`);
    }
    return { count: state.undo.length, patch: lines.join('\n') };
  }
  function forceState(h, st, on) {
    // Real :hover/:focus forcing needs the debugger permission, which we don't ask for.
    // Instead, copy the matching :state declarations into the override sheet.
    const el = target(h);
    const pseudo = ':' + st;
    let css = '';
    for (const sheet of allSheets(document)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      for (const r of rules)
        if (r.type === 1 && r.selectorText.includes(pseudo)) {
          const sels = r.selectorText
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.includes(pseudo));
          sels.forEach((s) => {
            const base = s.split(pseudo).join('');
            if (safe(() => el.matches(base), false))
              css += `${s.split(pseudo).join('')}{${r.style.cssText.replace(/;/g, ' !important;')}}\n`;
          });
        }
    }
    if (!css)
      return {
        applied: false,
        note: 'No ' + pseudo + ' rules match this element in readable stylesheets.',
      };
    ensureStyleEl();
    return {
      applied: true,
      css,
      note:
        'Emulated by applying the :' +
        st +
        ' declarations as overrides. Stored in the Override CSS tab as a preview, not a native state.',
    };
  }

  // mutation tracking
  function trackMutations(on) {
    if (on && !state.mo) {
      state.mutations = [];
      state.mo = new MutationObserver((list) => {
        for (const m of list) {
          if (state.mutations.length >= 300) state.mutations.shift();
          const t = m.target;
          if (t.id === '__df_overrides' || (t.id || '').startsWith('__df')) continue;
          state.mutations.push({
            t: Date.now(),
            type: m.type,
            target: isEl(t) ? lc(t.tagName) + (t.id ? '#' + t.id : '') : '#text',
            attr: m.attributeName || null,
            added: m.addedNodes.length,
            removed: m.removedNodes.length,
          });
        }
      });
      state.mo.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } else if (!on && state.mo) {
      state.mo.disconnect();
      state.mo = null;
    }
    return { tracking: !!state.mo, mutations: state.mutations.slice(-100) };
  }

  // scripts / JS analysis
  function scriptsInfo() {
    const out = [];
    document.querySelectorAll('script').forEach((s, i) => {
      if (s.id === '__df_bridge') return;
      const src = s.src || null;
      const code = s.textContent || '';
      const minified =
        code.length > 500 &&
        (code.split('\n').length < 5 || code.length / Math.max(1, code.split('\n').length) > 300);
      out.push({
        index: i,
        kind: src ? 'external' : 'inline',
        type: s.type || 'classic',
        module: s.type === 'module',
        async: s.async,
        defer: s.defer,
        src,
        size: src ? null : code.length,
        minified: src
          ? prov('unknown without fetching', 'unavailable')
          : prov(minified, 'inferred'),
        sourceMapComment:
          !src && /\/\/[#@] sourceMappingURL=/.test(code)
            ? (code.match(/sourceMappingURL=(\S+)/) || [])[1]
            : null,
        preview: src ? null : clip(code.trim(), 300),
        dynamic: !!s.__dfDyn,
      });
    });
    const res = performance
      .getEntriesByType('resource')
      .filter((r) => r.initiatorType === 'script' || /\.m?js(\?|$)/.test(r.name))
      .map((r) => ({
        url: r.name,
        transferSize: r.transferSize,
        duration: Math.round(r.duration),
      }));
    return {
      scripts: out,
      loaded: res,
      availability: {
        inlineSource: 'available',
        externalSource:
          'Not readable from the page for cross-origin scripts; fetched on demand with host permission only for the active site.',
        serverSide: 'unavailable',
      },
    };
  }

  // Accessibility
  function luminance(r, g, b) {
    const a = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function parseRGBA(s) {
    const m = (s || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p[3] == null || isNaN(p[3]) ? 1 : p[3] };
  }
  function effectiveBg(el) {
    let c = el;
    let layers = [];
    while (c && isEl(c)) {
      const cs = getComputedStyle(c);
      if (cs.backgroundImage !== 'none')
        return { unknown: true, reason: 'background image/gradient' };
      const bg = parseRGBA(cs.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      c = parentOf(c);
    }
    let base = { r: 255, g: 255, b: 255 };
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      base = {
        r: l.r * l.a + base.r * (1 - l.a),
        g: l.g * l.a + base.g * (1 - l.a),
        b: l.b * l.a + base.b * (1 - l.a),
      };
    }
    return base;
  }
  function contrastOf(el) {
    const cs = getComputedStyle(el);
    const fg = parseRGBA(cs.color);
    const bg = effectiveBg(el);
    if (!fg || bg.unknown) return { unknown: true, reason: bg.reason || 'unparsable color' };
    const fgc =
      fg.a < 1
        ? {
            r: fg.r * fg.a + bg.r * (1 - fg.a),
            g: fg.g * fg.a + bg.g * (1 - fg.a),
            b: fg.b * fg.a + bg.b * (1 - fg.a),
          }
        : fg;
    const l1 = luminance(fgc.r, fgc.g, fgc.b),
      l2 = luminance(bg.r, bg.g, bg.b);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(cs.fontSize),
      bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    return { ratio: Math.round(ratio * 100) / 100, large, required: large ? 3 : 4.5 };
  }
  function visible(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && (r.width > 0 || r.height > 0);
  }

  function accessibilityAudit(h) {
    const root = h ? target(h) : document.documentElement;
    const issues = [];
    const add = (sev, rule, el, msg, fix) =>
      issues.push({
        severity: sev,
        rule,
        selector: (selectorsFor(el)[0] || {}).selector,
        h: handleOf(el),
        message: msg,
        fix,
        snippet: clip(el.outerHTML, 160),
      });
    const all = [root, ...root.querySelectorAll('*')];
    let checked = 0;
    for (const el of all.slice(0, MAX_NODES)) {
      checked++;
      const t = lc(el.tagName);
      if (t === 'img' && !el.hasAttribute('alt') && el.getAttribute('role') !== 'presentation')
        add(
          'error',
          'img-alt',
          el,
          'Image has no alt attribute.',
          'Add alt="description", or alt="" if purely decorative.'
        );
      if (t === 'button' || el.getAttribute('role') === 'button') {
        if (!a11yInfo(el).accessibleName.value)
          add(
            'error',
            'button-name',
            el,
            'Button has no accessible name.',
            'Add visible text, aria-label, or aria-labelledby.'
          );
      }
      if (t === 'a') {
        if (!el.hasAttribute('href') && !el.getAttribute('role'))
          add(
            'warn',
            'link-href',
            el,
            'Anchor without href is not keyboard focusable or announced as a link.',
            'Add href or use a <button>.'
          );
        else if (!a11yInfo(el).accessibleName.value && !el.querySelector('img[alt]'))
          add(
            'error',
            'link-name',
            el,
            'Link has no discernible text.',
            'Add text content or aria-label.'
          );
      }
      if (
        /^(input|select|textarea)$/.test(t) &&
        !/^(hidden|submit|button|reset|image)$/.test(lc(el.type))
      ) {
        if (!a11yInfo(el).accessibleName.value)
          add(
            'error',
            'form-label',
            el,
            'Form control has no label.',
            'Associate a <label for>, wrap with <label>, or add aria-label.'
          );
      }
      if (el.hasAttribute('aria-labelledby'))
        el.getAttribute('aria-labelledby')
          .split(/\s+/)
          .forEach((id) => {
            if (!document.getElementById(id))
              add(
                'error',
                'aria-ref',
                el,
                'aria-labelledby references missing id "' + id + '".',
                'Fix or remove the reference.'
              );
          });
      if (el.hasAttribute('aria-describedby'))
        el.getAttribute('aria-describedby')
          .split(/\s+/)
          .forEach((id) => {
            if (!document.getElementById(id))
              add(
                'error',
                'aria-ref',
                el,
                'aria-describedby references missing id "' + id + '".',
                'Fix or remove the reference.'
              );
          });
      if (
        el.getAttribute('aria-hidden') === 'true' &&
        el.matches('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])')
      )
        add(
          'error',
          'aria-hidden-focusable',
          el,
          'Focusable element is hidden from assistive tech.',
          'Remove aria-hidden or make it non-focusable.'
        );
      if (el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex'), 10) > 0)
        add(
          'warn',
          'tabindex-positive',
          el,
          'Positive tabindex disrupts natural tab order.',
          'Use tabindex="0" or restructure DOM order.'
        );
      if (
        (el.onclick || el.hasAttribute('onclick')) &&
        !el.matches(
          'a[href],button,input,select,textarea,summary,[tabindex],[role=button],[role=link]'
        )
      )
        add(
          'warn',
          'click-not-keyboard',
          el,
          'Click handler on a non-interactive element: not keyboard accessible.',
          'Use <button> or add role, tabindex="0" and key handlers.'
        );
      if (el.hasChildNodes() && visible(el)) {
        const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (direct) {
          const c = contrastOf(el);
          if (!c.unknown && c.ratio < c.required)
            add(
              'warn',
              'color-contrast',
              el,
              `Contrast ${c.ratio}:1 is below ${c.required}:1.`,
              'Darken text or lighten background to reach ' + c.required + ':1.'
            );
        }
      }
    }
    const heads = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
    let prev = 0;
    heads.forEach((hd) => {
      const l = parseInt(hd.tagName[1], 10);
      if (prev && l > prev + 1)
        add(
          'warn',
          'heading-order',
          hd,
          `Heading jumps from h${prev} to h${l}.`,
          'Do not skip heading levels.'
        );
      prev = l;
    });
    if (root === document.documentElement) {
      if (!document.documentElement.lang)
        issues.push({
          severity: 'error',
          rule: 'html-lang',
          message: '<html> has no lang attribute.',
          fix: 'Add lang="en" (or the right language).',
        });
      if (!document.title)
        issues.push({
          severity: 'error',
          rule: 'doc-title',
          message: 'Document has no <title>.',
          fix: 'Add a descriptive title.',
        });
      if (heads.filter((x) => x.tagName === 'H1').length !== 1)
        issues.push({
          severity: 'warn',
          rule: 'h1-count',
          message: `Page has ${heads.filter((x) => x.tagName === 'H1').length} h1 elements.`,
          fix: 'Use exactly one h1.',
        });
      if (!document.querySelector('main,[role=main]'))
        issues.push({
          severity: 'warn',
          rule: 'landmark-main',
          message: 'No <main> landmark.',
          fix: 'Wrap primary content in <main>.',
        });
    }
    return {
      issues,
      checked,
      truncated: all.length > MAX_NODES,
      summary: {
        error: issues.filter((i) => i.severity === 'error').length,
        warn: issues.filter((i) => i.severity === 'warn').length,
      },
      limits: [
        'Contrast is skipped for elements over images/gradients.',
        'Keyboard operability and focus order cannot be fully verified statically; only structural indicators are checked.',
        'Accessible names are approximated, not read from the browser accessibility tree.',
      ],
    };
  }

  // Performance
  function performanceAudit() {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const byType = {};
    res.forEach((r) => {
      const t = r.initiatorType || 'other';
      byType[t] = byType[t] || { count: 0, transfer: 0, decoded: 0 };
      byType[t].count++;
      byType[t].transfer += r.transferSize || 0;
      byType[t].decoded += r.decodedBodySize || 0;
    });
    const big = res
      .filter((r) => (r.transferSize || r.decodedBodySize) > 200 * 1024)
      .map((r) => ({ url: r.name, kb: Math.round((r.transferSize || r.decodedBodySize) / 1024) }))
      .sort((a, b) => b.kb - a.kb)
      .slice(0, 15);
    const slow = res
      .filter((r) => r.duration > 800)
      .map((r) => ({ url: r.name, ms: Math.round(r.duration) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 15);
    const domCount = document.getElementsByTagName('*').length;
    let maxDepth = 0;
    const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let n = 0;
    while (w.nextNode() && n++ < MAX_NODES) {
      let d = 0,
        c = w.currentNode;
      while (c.parentElement) {
        d++;
        c = c.parentElement;
      }
      if (d > maxDepth) maxDepth = d;
    }
    const tips = [];
    if (domCount > 1500)
      tips.push(
        `DOM has ${domCount} elements; Lighthouse warns above ~1500. Consider virtualizing long lists.`
      );
    if (maxDepth > 32) tips.push(`DOM depth is ${maxDepth}; deep trees slow style/layout.`);
    big.forEach((b) => tips.push(`Large resource (${b.kb} KB): ${b.url}`));
    const imgs = [...document.images];
    const noDim = imgs.filter(
      (i) => !i.getAttribute('width') && !i.getAttribute('height') && !i.style.aspectRatio
    ).length;
    if (noDim) tips.push(`${noDim} image(s) lack width/height, which can cause layout shift.`);
    const lazyMiss = imgs.filter(
      (i) => i.getBoundingClientRect().top > innerHeight * 2 && i.loading !== 'lazy'
    ).length;
    if (lazyMiss) tips.push(`${lazyMiss} below-the-fold image(s) are not loading="lazy".`);
    const blocking = [
      ...document.querySelectorAll('head script[src]:not([async]):not([defer]):not([type=module])'),
    ].length;
    if (blocking) tips.push(`${blocking} render-blocking script(s) in <head>; add defer or async.`);
    const paints = {};
    performance.getEntriesByType('paint').forEach((p) => {
      paints[p.name] = Math.round(p.startTime);
    });
    return {
      timing: nav
        ? {
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            load: Math.round(nav.loadEventEnd),
            ttfb: Math.round(nav.responseStart),
            transferSize: nav.transferSize,
          }
        : null,
      paints,
      domCount,
      maxDepth,
      resourceCount: res.length,
      byType,
      big,
      slow,
      tips,
      longTasks: prov(
        window.__dfLongTasks ||
          'not observed (start observing from the Performance tab, then interact with the page)',
        window.__dfLongTasks ? 'observed' : 'unavailable'
      ),
      note: 'Cross-origin resources without Timing-Allow-Origin report transferSize 0, so sizes can be understated.',
    };
  }
  function observeLongTasks() {
    if (window.__dfLT) return { observing: true, tasks: window.__dfLongTasks || [] };
    window.__dfLongTasks = [];
    try {
      window.__dfLT = new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => {
          if (window.__dfLongTasks.length < 200)
            window.__dfLongTasks.push({
              start: Math.round(e.startTime),
              ms: Math.round(e.duration),
            });
        })
      );
      window.__dfLT.observe({ type: 'longtask', buffered: true });
    } catch (e) {
      window.__dfLT = null;
      window.__dfLongTasks = null;
      throw new Error('Long Task API not available here: ' + e.message);
    }
    return { observing: true, tasks: [] };
  }

  // Security
  function securityAudit() {
    const issues = [];
    const add = (sev, rule, msg, detail) =>
      issues.push({ severity: sev, rule, message: msg, detail });
    if (location.protocol === 'http:') add('error', 'insecure-page', 'Page is served over HTTP.');
    performance.getEntriesByType('resource').forEach((r) => {
      if (location.protocol === 'https:' && r.name.startsWith('http://'))
        add('error', 'mixed-content', 'Mixed content resource', r.name);
    });
    document.querySelectorAll('[src],[href],[action]').forEach((el) => {
      const u = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('action');
      if (u && /^http:\/\//i.test(u) && location.protocol === 'https:')
        add('warn', 'http-url', 'http:// URL in markup', `<${lc(el.tagName)}> ${clip(u, 120)}`);
      if (u && /^\s*javascript:/i.test(u))
        add('warn', 'javascript-url', 'javascript: URL', `<${lc(el.tagName)}> ${clip(u, 120)}`);
    });
    document.querySelectorAll('a[target=_blank]').forEach((a) => {
      if (!/noopener|noreferrer/.test(a.rel))
        add('info', 'noopener', 'target=_blank without rel=noopener', clip(a.href, 100));
    });
    let inl = 0;
    document.querySelectorAll('*').forEach((el) => {
      for (const a of el.attributes) if (/^on/i.test(a.name)) inl++;
    });
    if (inl)
      add(
        'info',
        'inline-handlers',
        inl + ' inline event handler attribute(s)',
        'Prevents a strict CSP without unsafe-inline.'
      );
    document.querySelectorAll('form').forEach((f) => {
      if (f.querySelector('input[type=password]') && (f.action || '').startsWith('http://'))
        add('error', 'password-http', 'Password form posts over HTTP', f.action);
      if (f.querySelector('input[type=password]') && f.autocomplete === 'off')
        add('info', 'autocomplete-off', 'Password form disables autocomplete');
    });
    const ext = new Set();
    document.querySelectorAll('script[src]').forEach((s) => {
      const u = safe(() => new URL(s.src));
      if (u && u.origin !== location.origin) {
        ext.add(u.host);
        if (!s.integrity)
          add('info', 'sri-missing', 'Third-party script without Subresource Integrity', s.src);
      }
    });
    document.querySelectorAll('iframe').forEach((f) => {
      if (
        !f.hasAttribute('sandbox') &&
        safe(() => new URL(f.src).origin !== location.origin, false)
      )
        add('info', 'iframe-sandbox', 'Cross-origin iframe without sandbox', clip(f.src, 100));
    });
    const secretRe =
      /(api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i;
    document.querySelectorAll('script:not([src])').forEach((s) => {
      const m = (s.textContent || '').match(secretRe);
      if (m)
        add(
          'warn',
          'possible-secret',
          'Possible hard-coded credential-like string in inline script',
          clip(m[0].replace(/(['"])[A-Za-z0-9_-]{16,}\1/, '$1[redacted]$1'), 80)
        );
    });
    const sinks = [];
    document.querySelectorAll('script:not([src])').forEach((s) => {
      const c = s.textContent || '';
      ['innerHTML', 'document.write', 'eval(', 'outerHTML', 'insertAdjacentHTML'].forEach((k) => {
        if (c.includes(k)) sinks.push(k);
      });
    });
    if (sinks.length)
      add(
        'info',
        'dom-sinks',
        'Inline scripts reference DOM injection sinks',
        [...new Set(sinks)].join(', ') + ' (patterns only, not proof of a vulnerability)'
      );
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    return {
      issues,
      thirdPartyHosts: [...ext],
      csp: meta
        ? prov(meta.content, 'observed')
        : prov(
            'No CSP <meta>. A CSP delivered as an HTTP header is checked in the Network tab by "Fetch headers".',
            'unavailable'
          ),
      note: 'Passive analysis only. Findings are patterns, not confirmed vulnerabilities.',
    };
  }

  async function fetchHeaders() {
    const r = await fetch(location.href, {
      method: 'HEAD',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const wanted = [
      'content-security-policy',
      'strict-transport-security',
      'x-frame-options',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
      'server',
      'content-type',
    ];
    const h = {};
    wanted.forEach((k) => {
      h[k] = r.headers.get(k);
    });
    const issues = [];
    if (!h['content-security-policy']) issues.push('No Content-Security-Policy header.');
    if (location.protocol === 'https:' && !h['strict-transport-security'])
      issues.push('No Strict-Transport-Security header.');
    if (!h['x-content-type-options']) issues.push('No X-Content-Type-Options: nosniff.');
    if (!h['x-frame-options'] && !(h['content-security-policy'] || '').includes('frame-ancestors'))
      issues.push('No clickjacking protection (X-Frame-Options / frame-ancestors).');
    return {
      status: r.status,
      headers: h,
      issues,
      provenance: 'observed (HEAD request to the page URL, same-origin)',
    };
  }

  // Component export collection
  const SKIP_URL = /^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i;
  function absCssUrls(text, base) {
    return text.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (m, q, u) => {
      if (!u || SKIP_URL.test(u)) return m;
      try {
        return 'url("' + new URL(u, base).href + '")';
      } catch (_) {
        return m;
      }
    });
  }
  function absolutizeTree(root) {
    const attrs = ['src', 'href', 'poster', 'data-src', 'action'];
    const all = [root, ...root.querySelectorAll('*')];
    for (const n of all) {
      for (const a of attrs) {
        const v = n.getAttribute && n.getAttribute(a);
        if (v && !SKIP_URL.test(v)) {
          try {
            n.setAttribute(a, new URL(v, document.baseURI).href);
          } catch (_) {}
        }
      }
      const ss = n.getAttribute && n.getAttribute('srcset');
      if (ss)
        n.setAttribute(
          'srcset',
          ss
            .split(',')
            .map((p) => {
              const [u, ...rest] = p.trim().split(/\s+/);
              try {
                return [new URL(u, document.baseURI).href, ...rest].join(' ');
              } catch (_) {
                return p;
              }
            })
            .join(', ')
        );
      const st = n.getAttribute && n.getAttribute('style');
      if (st && st.includes('url(')) n.setAttribute('style', absCssUrls(st, document.baseURI));
    }
  }
  function collectComponent(h, opts) {
    opts = opts || {};
    const el = target(h);
    const nodes = [el, ...el.querySelectorAll('*')];
    const limited = nodes.slice(0, 3000);
    const ruleSeen = new Set();
    const blocked = [];
    const usedKeyframes = new Set();
    const usedFamilies = new Set();
    const varNames = new Set();
    const allSheetsList = allSheets(
      el.getRootNode && el.getRootNode().styleSheets ? el.getRootNode() : document
    );
    if (el.getRootNode() !== document) allSheetsList.push(...allSheets(document));
    limited.forEach((n) => {
      const cs = getComputedStyle(n);
      if (cs.animationName !== 'none')
        cs.animationName.split(',').forEach((a) => usedKeyframes.add(a.trim()));
      cs.fontFamily
        .split(',')
        .forEach((f) => usedFamilies.add(f.trim().replace(/^["']|["']$/g, '')));
    });
    const matchesAny = (sel) => {
      for (const part of sel.split(/,(?![^(]*\))/)) {
        const s =
          part
            .trim()
            .replace(
              /:(hover|focus|active|focus-visible|focus-within|visited|checked|disabled)\b/g,
              ''
            )
            .replace(
              /::?(before|after|placeholder|marker|selection|first-line|first-letter|-webkit-[\w-]+)/g,
              ''
            ) || '*';
        if (limited.some((n) => safe(() => n.matches(s), false))) return true;
      }
      return false;
    };
    let curBase = document.baseURI;
    const fontUrls = [];
    const walk = (list, wrap) => {
      let out = '';
      for (const rule of list) {
        if (rule.type === 1) {
          if (matchesAny(rule.selectorText)) {
            out += absCssUrls(rule.cssText, curBase) + '\n';
            (rule.cssText.match(/var\((--[\w-]+)/g) || []).forEach((v) => varNames.add(v.slice(4)));
          }
        } else if (
          rule.type === 4 ||
          rule.type === 12 ||
          rule.constructor.name === 'CSSContainerRule' ||
          rule.constructor.name === 'CSSLayerBlockRule'
        ) {
          const inner = walk(rule.cssRules, true);
          if (inner)
            out +=
              rule.cssText.split('{')[0].trim() +
              ' {\n' +
              inner
                .split('\n')
                .map((l) => (l ? '  ' + l : l))
                .join('\n') +
              '}\n';
        } else if (rule.type === 7) {
          if (usedKeyframes.has(rule.name)) out += rule.cssText + '\n';
        } else if (rule.type === 5) {
          const fam = rule.style.getPropertyValue('font-family').replace(/^["']|["']$/g, '');
          if (usedFamilies.has(fam)) {
            const t = absCssUrls(rule.cssText, curBase);
            out += t + '\n';
            (t.match(/url\("([^"]+)"\)/g) || []).forEach((u) => fontUrls.push(u.slice(5, -2)));
          }
        }
      }
      return out;
    };
    let css = '';
    allSheetsList.forEach((sheet, i) => {
      let r;
      try {
        r = sheet.cssRules;
      } catch (_) {
        blocked.push(sheetLabel(sheet, i));
        return;
      }
      curBase = sheet.href || document.baseURI;
      const part = walk(r, false);
      if (part && !ruleSeen.has(part)) {
        ruleSeen.add(part);
        css += `/* source: ${sheetLabel(sheet, i)} */\n${part}\n`;
      }
    });
    // :root variables used
    let varCss = '';
    const elCS = getComputedStyle(el);
    [...varNames].forEach((v) => {
      const val = elCS.getPropertyValue(v).trim();
      if (val) varCss += `  ${v}: ${val};\n`;
    });
    if (varCss) css = `:root {\n${varCss}}\n\n` + css;
    // clone html, strip our own marks
    const clone = el.cloneNode(true);
    const sweep = (c) => {
      if (c.removeAttribute) {
        c.removeAttribute('data-df');
      }
      [...(c.children || [])].forEach(sweep);
    };
    sweep(clone);
    clone.querySelectorAll('script').forEach((s) => s.remove());
    absolutizeTree(clone);
    clone.querySelectorAll('style').forEach((st) => {
      st.textContent = st.textContent.replace(/</g, '\\3c ');
    });
    if (opts.stripHandlers) {
      [clone, ...clone.querySelectorAll('*')].forEach((n) => {
        for (const a of [...n.attributes]) {
          if (/^on/i.test(a.name)) n.removeAttribute(a.name);
          else if (
            /^(href|src|action|formaction|xlink:href)$/i.test(a.name) &&
            /^\s*javascript:/i.test(a.value)
          )
            n.setAttribute(a.name, '#');
        }
      });
    }
    // scripts in page that mention the component's id/classes (inferred relation)
    const keys = new Set([el.id, ...el.classList].filter(Boolean));
    nodes.slice(0, 400).forEach((n) => {
      if (n.id) keys.add(n.id);
    });
    const related = [];
    document.querySelectorAll('script:not([src])').forEach((s, i) => {
      const c = s.textContent || '';
      const hit = [...keys].filter((k) => k.length > 2 && c.includes(k));
      if (hit.length)
        related.push({
          kind: 'inline',
          index: i,
          matchedOn: hit.slice(0, 5),
          code: c.length > 60000 ? c.slice(0, 60000) + '\n/* truncated */' : c,
        });
    });
    const externalScripts = [...document.querySelectorAll('script[src]')].map((s) => s.src);
    const assets = assetsOf(el);
    fontUrls.forEach((u) => {
      if (!assets.some((a) => a.url === u)) assets.push({ type: 'font', url: u });
    });
    const handlers = [];
    nodes.forEach((n) =>
      inlineHandlers(n).forEach((hd) =>
        handlers.push({ selector: (selectorsFor(n)[0] || {}).selector, ...hd })
      )
    );
    const base = location.href;
    const htmlOut = clone.outerHTML;
    return {
      title: document.title,
      base,
      html: htmlOut,
      css,
      blockedSheets: blocked,
      assets,
      relatedScripts: related,
      externalScripts,
      handlers,
      framework: detectFramework(el),
      cssVariables: Object.fromEntries(
        [...varNames].map((v) => [v, elCS.getPropertyValue(v).trim()])
      ),
      counts: { elements: nodes.length, truncated: nodes.length > limited.length },
      htmlStyleRoot: {
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyFont: getComputedStyle(document.body).fontFamily,
        bodyColor: getComputedStyle(document.body).color,
      },
      provenance: {
        html: 'extracted (DOM at capture time, scripts stripped)',
        css: 'extracted (readable stylesheets only)',
        scripts: 'inferred (name/id matching only; behaviour is not guaranteed)',
        serverSide: 'unavailable',
      },
      confidence: {
        html: prov(100, 'observed', { basis: 'serialized from the live DOM' }),
        css: prov(blocked.length ? 'partial' : 'complete', 'observed', {
          basis: blocked.length
            ? blocked.length + ' unreadable stylesheet(s)'
            : 'all stylesheets readable',
        }),
        javascript: prov('inferred', 'inferred', {
          basis: 'string matching between script text and component ids/classes',
        }),
        backend: prov('unavailable', 'unavailable'),
      },
    };
  }

  // Recreation (clean computed-style based)
  let defaultsFrame = null;
  const defaultCache = new Map();
  function defaultsFor(tag, ns) {
    const key = ns + ':' + tag;
    if (defaultCache.has(key)) return defaultCache.get(key);
    if (!defaultsFrame) {
      defaultsFrame = document.createElement('iframe');
      defaultsFrame.id = '__df_defaults';
      defaultsFrame.setAttribute('sandbox', 'allow-same-origin');
      defaultsFrame.style.cssText =
        'position:fixed;left:-99999px;width:1200px;height:800px;visibility:hidden;border:0';
      document.documentElement.appendChild(defaultsFrame);
      defaultsFrame.contentDocument.open();
      defaultsFrame.contentDocument.write('<!doctype html><html><body></body></html>');
      defaultsFrame.contentDocument.close();
    }
    const d = defaultsFrame.contentDocument;
    const e =
      ns === 'svg' ? d.createElementNS('http://www.w3.org/2000/svg', tag) : d.createElement(tag);
    d.body.appendChild(e);
    const cs = defaultsFrame.contentWindow.getComputedStyle(e);
    const o = {};
    for (let i = 0; i < cs.length; i++) o[cs[i]] = cs.getPropertyValue(cs[i]);
    e.remove();
    defaultCache.set(key, o);
    return o;
  }
  const SKIP_PROPS =
    /^(-webkit-|-moz-|inline-size|block-size|perspective-origin|transform-origin|width|height|min-|max-|inset|block-|inline-|margin-block|margin-inline|padding-block|padding-inline|border-block|border-inline|border-start|border-end|scroll-|overscroll|container|view-|app-region|anchor|position-|text-size-adjust|caret|d$|cx|cy|r$|rx|ry|x$|y$|offset|math-|speak)/;
  const SIZE_KEEP = new Set(['width', 'height']);
  const INHERITED = new Set([
    'color',
    'font-family',
    'font-size',
    'font-style',
    'font-weight',
    'line-height',
    'letter-spacing',
    'text-align',
    'text-transform',
    'text-indent',
    'white-space',
    'word-spacing',
    'visibility',
    'cursor',
    'list-style-type',
    'list-style-position',
    'direction',
    'text-shadow',
    'font-variant',
    'border-collapse',
  ]);

  const CURRENT_COLOR_NOISE =
    /^(column-rule-color|outline-color|text-decoration-color|text-emphasis-color|caret-color)$/;
  function collapse4(d, a, b, c, e, name, keep) {
    const keys = [a, b, c, e];
    if (keys.every((k) => d[k] != null) && new Set(keys.map((k) => d[k])).size === 1) {
      d[name] = d[a];
      keys.forEach((k) => delete d[k]);
    } else if (keys.every((k) => d[k] != null)) {
      const [t, r, bo, l] = keys.map((k) => d[k]);
      d[name] = t === bo && r === l ? t + ' ' + r : [t, r, bo, l].join(' ');
      keys.forEach((k) => delete d[k]);
    }
  }
  function tidyDecls(d) {
    for (const k of Object.keys(d)) if (CURRENT_COLOR_NOISE.test(k)) delete d[k];
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const w = d['border-' + side + '-width'],
        st = d['border-' + side + '-style'];
      if (!st || st === 'none' || w === '0px') delete d['border-' + side + '-color']; // color is irrelevant when nothing is drawn; width/style are kept because they may differ from UA defaults
    }
    if (d['outline-style'] === 'none' || d['outline-width'] === '0px') delete d['outline-color'];
    collapse4(d, 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin');
    collapse4(d, 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding');
    collapse4(
      d,
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
      'border-radius'
    );
    const bw = [
        'border-top-width',
        'border-right-width',
        'border-bottom-width',
        'border-left-width',
      ],
      bs = bw.map((k) => k.replace('width', 'style')),
      bc = bw.map((k) => k.replace('width', 'color'));
    const same = (ks) => ks.every((k) => d[k] != null) && new Set(ks.map((k) => d[k])).size === 1;
    if (same(bw) && same(bs) && same(bc) && d[bw[0]] !== '0px' && d[bs[0]] !== 'none') {
      d.border = d[bw[0]] + ' ' + d[bs[0]] + ' ' + d[bc[0]];
      [...bw, ...bs, ...bc].forEach((k) => delete d[k]);
    } else {
      if (same(bw)) {
        d['border-width'] = d[bw[0]];
        bw.forEach((k) => delete d[k]);
      }
      if (same(bs)) {
        d['border-style'] = d[bs[0]];
        bs.forEach((k) => delete d[k]);
      }
      if (same(bc)) {
        d['border-color'] = d[bc[0]];
        bc.forEach((k) => delete d[k]);
      }
    }
    for (const k of ['background-position-x', 'background-position-y'])
      if (d[k] === '0%') delete d[k];
    return d;
  }
  function animatedProps(el) {
    const drop = new Set(),
      finalVals = {},
      anims = [];
    let list = [];
    try {
      list = el.getAnimations({ subtree: false });
    } catch (_) {}
    for (const a of list) {
      let frames = [];
      try {
        frames = a.effect.getKeyframes();
      } catch (_) {}
      const isCSSAnim = a.constructor && a.constructor.name === 'CSSAnimation';
      for (const f of frames)
        for (const k of Object.keys(f)) {
          if (['offset', 'computedOffset', 'easing', 'composite'].includes(k)) continue;
          const prop = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()).replace(/^css-/, '');
          if (isCSSAnim) drop.add(prop === 'css-float' ? 'float' : prop);
          else finalVals[prop] = f[k];
        }
      if (isCSSAnim) anims.push(a.animationName);
    }
    return { drop, finalVals, anims };
  }
  function recreate(h, opts) {
    opts = opts || {};
    const root = target(h);
    const nodes = [];
    const keyframeNames = new Set();
    const walker = (el, parentComputed) => {
      if (nodes.length > 2500) return null;
      const tag = lc(el.tagName);
      if (/^(script|style|link|meta|noscript|template)$/.test(tag)) return null;
      const ns = el instanceof SVGElement ? 'svg' : 'html';
      const cs = getComputedStyle(el);
      const def = defaultsFor(tag, ns);
      const declared = {};
      for (let i = 0; i < cs.length; i++) {
        const p = cs[i];
        if (SKIP_PROPS.test(p) && !SIZE_KEEP.has(p)) continue;
        const v = cs.getPropertyValue(p);
        if (def[p] === v) continue;
        if (INHERITED.has(p) && parentComputed && parentComputed[p] === v) continue;
        if (p === 'width' || p === 'height') continue; // sizes come from content/flow; dimension check done in compare
        declared[p] = v;
      }
      const an = animatedProps(el);
      an.drop.forEach((k) => delete declared[k]);
      Object.assign(declared, an.finalVals);
      an.anims.forEach((n) => keyframeNames.add(n));
      if (opts.pin === 'all' && ns === 'html' && cs.display !== 'inline' && cs.display !== 'none') {
        const rr = el.getBoundingClientRect();
        declared.width = Math.round(rr.width * 100) / 100 + 'px';
        declared.height = Math.round(rr.height * 100) / 100 + 'px';
        declared['box-sizing'] = 'border-box';
      }
      tidyDecls(declared);
      const parentSnap = {};
      INHERITED.forEach((p) => {
        parentSnap[p] = cs.getPropertyValue(p);
      });
      const attrs = {};
      for (const a of el.attributes) {
        if (/^(class|style|id|data-df.*)$/.test(a.name) || /^on/i.test(a.name)) continue;
        attrs[a.name] = a.value;
      }
      if (tag === 'img') {
        attrs.src = el.currentSrc || el.src;
        delete attrs.srcset;
        delete attrs.sizes;
        delete attrs.loading;
      }
      if (attrs.href && /^\s*javascript:/i.test(attrs.href)) attrs.href = '#';
      else if (tag === 'a' && attrs.href) attrs.href = absUrl(attrs.href);
      const node = { tag, ns, attrs, style: declared, children: [], id: el.id || null, pseudo: {} };
      for (const p of ['::before', '::after']) {
        const ps = getComputedStyle(el, p);
        if (ps.content && ps.content !== 'none' && ps.content !== 'normal') {
          const o = {};
          [
            'content',
            'display',
            'color',
            'background-color',
            'font-size',
            'width',
            'height',
            'position',
            'margin',
            'padding',
            'border',
            'border-radius',
            'top',
            'left',
            'right',
            'bottom',
            'transform',
          ].forEach((k) => {
            const v = ps.getPropertyValue(k);
            if (v && v !== 'auto' && v !== 'none' && v !== 'normal' && v !== '0px') o[k] = v;
          });
          node.pseudo[p] = o;
        }
      }
      for (const c of el.childNodes) {
        if (c.nodeType === 3) {
          if (c.textContent.length) node.children.push({ text: c.textContent });
        } else if (c.nodeType === 1) {
          const k = walker(c, parentSnap);
          if (k) node.children.push(k);
        }
      }
      if (el.shadowRoot)
        for (const c of el.shadowRoot.children) {
          const k = walker(c, parentSnap);
          if (k) node.children.push(k);
        }
      return node;
    };
    const rootNode = walker(root, null);
    const kfCss = [...keyframeNames]
      .map((n) =>
        keyframesFor(n)
          .map((k) => k.css)
          .join('\n')
      )
      .join('\n');
    // root needs width constraints
    const r = root.getBoundingClientRect();
    rootNode.style.width = getComputedStyle(root).width; // used content width, consistent with the carried box-sizing
    // assign class names
    const uniq = new Map();
    let seq = 0;
    const baseName = (n) => (n.id ? n.id.replace(/[^\w-]/g, '-') : n.tag);
    const classify = (n) => {
      if (n.text != null) return;
      const key = JSON.stringify([n.tag, n.style, n.pseudo]);
      if (Object.keys(n.style).length || Object.keys(n.pseudo).length) {
        if (!uniq.has(key))
          uniq.set(key, {
            cls: 'c' + ++seq + '-' + baseName(n),
            style: n.style,
            pseudo: n.pseudo,
            tag: n.tag,
          });
        n.cls = uniq.get(key).cls;
      }
      n.children.forEach(classify);
    };
    classify(rootNode);
    const rulesCss = [...uniq.values()]
      .map((u) => {
        let out =
          `.${u.cls} {\n` +
          Object.entries(u.style)
            .map(([p, v]) => `  ${p}: ${v};`)
            .join('\n') +
          '\n}\n';
        for (const [p, o] of Object.entries(u.pseudo))
          out +=
            `.${u.cls}${p} {\n` +
            Object.entries(o)
              .map(([k, v]) => `  ${k}: ${v};`)
              .join('\n') +
            '\n}\n';
        return out;
      })
      .join('\n');
    return {
      tree: rootNode,
      css: rulesCss + (kfCss ? '\n' + kfCss + '\n' : ''),
      classCount: uniq.size,
      nodeCount: countTree(rootNode),
      rect: { w: Math.round(r.width), h: Math.round(r.height) },
      truncated: nodes.length > 2500,
    };
  }
  function countTree(n) {
    return n.text != null ? 0 : 1 + n.children.reduce((a, c) => a + countTree(c), 0);
  }

  /* Layout comparison: render generated doc in a hidden iframe, compare per-element boxes and key styles */
  async function compareRecreation(h, doc) {
    const orig = target(h);
    const f = document.createElement('iframe');
    f.id = '__df_compare';
    f.setAttribute('sandbox', 'allow-same-origin'); // no allow-scripts: generated markup can never execute in the page's origin
    const r = orig.getBoundingClientRect();
    f.style.cssText = `position:fixed;left:-99999px;top:0;width:${Math.max(400, Math.ceil(r.width) + 40)}px;height:${Math.max(400, Math.ceil(r.height) + 40)}px;border:0;visibility:hidden`;
    document.documentElement.appendChild(f);
    try {
      await new Promise((res) => {
        f.onload = res;
        f.srcdoc = doc;
        setTimeout(res, 3000);
      });
      await new Promise((res) => setTimeout(res, 300));
      const d = f.contentDocument;
      const root = d.querySelector('[data-df-root]') || d.body.firstElementChild;
      if (!root) throw new Error('Generated document has no root element to compare.');
      const a = [orig, ...orig.querySelectorAll('*')].filter(
        (e) => !/^(script|style|link|meta|noscript|template)$/i.test(e.tagName)
      );
      const b = [root, ...root.querySelectorAll('*')].filter(
        (e) => !/^(script|style|link|meta|noscript|template)$/i.test(e.tagName)
      );
      const n = Math.min(a.length, b.length);
      const orR = orig.getBoundingClientRect(),
        nwR = root.getBoundingClientRect();
      let posOk = 0,
        sizeOk = 0,
        styleOk = 0,
        styleTotal = 0,
        tagOk = 0;
      const diffs = [];
      const props = [
        'color',
        'background-color',
        'font-size',
        'font-weight',
        'font-family',
        'display',
        'border-top-width',
        'border-top-color',
        'border-radius',
        'opacity',
        'box-shadow',
        'text-align',
      ];
      for (let i = 0; i < n; i++) {
        const A = a[i],
          B = b[i];
        if (A.tagName === B.tagName) tagOk++;
        const ra = A.getBoundingClientRect(),
          rb = B.getBoundingClientRect();
        const dx = Math.abs(ra.left - orR.left - (rb.left - nwR.left)),
          dy = Math.abs(ra.top - orR.top - (rb.top - nwR.top));
        const dw = Math.abs(ra.width - rb.width),
          dh = Math.abs(ra.height - rb.height);
        if (dx <= 2 && dy <= 2) posOk++;
        else if (diffs.length < 25)
          diffs.push({
            kind: 'position',
            el: lc(A.tagName) + (A.id ? '#' + A.id : ''),
            original: [Math.round(ra.left - orR.left), Math.round(ra.top - orR.top)],
            recreated: [Math.round(rb.left - nwR.left), Math.round(rb.top - nwR.top)],
          });
        if (dw <= 2 && dh <= 2) sizeOk++;
        else if (diffs.length < 25)
          diffs.push({
            kind: 'size',
            el: lc(A.tagName) + (A.id ? '#' + A.id : ''),
            original: [Math.round(ra.width), Math.round(ra.height)],
            recreated: [Math.round(rb.width), Math.round(rb.height)],
          });
        const sa = getComputedStyle(A),
          sb = f.contentWindow.getComputedStyle(B);
        const animated = new Set();
        try {
          A.getAnimations().forEach((an) => {
            try {
              an.effect
                .getKeyframes()
                .forEach((k) =>
                  Object.keys(k).forEach((x) =>
                    animated.add(x.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()))
                  )
                );
            } catch (_) {}
          });
        } catch (_) {}
        props
          .filter(
            (p) =>
              !animated.has(p) &&
              !(
                /^border-(top|right|bottom|left)-color$/.test(p) &&
                sa.getPropertyValue(p.replace('color', 'width')) === '0px'
              )
          )
          .forEach((p) => {
            styleTotal++;
            if (sa.getPropertyValue(p) === sb.getPropertyValue(p)) styleOk++;
            else if (diffs.length < 25 && p !== 'font-family')
              diffs.push({
                kind: 'style:' + p,
                el: lc(A.tagName),
                original: sa.getPropertyValue(p),
                recreated: sb.getPropertyValue(p),
              });
          });
      }
      const pct = (x, t) => (t ? Math.round((x / t) * 1000) / 10 : 0);
      const result = {
        elementCountOriginal: a.length,
        elementCountRecreated: b.length,
        compared: n,
        structure: pct(tagOk, Math.max(a.length, b.length)),
        position: pct(posOk, n),
        size: pct(sizeOk, n),
        style: pct(styleOk, styleTotal),
        rootSize: {
          original: [Math.round(orR.width), Math.round(orR.height)],
          recreated: [Math.round(nwR.width), Math.round(nwR.height)],
        },
        diffs,
      };
      result.similarity =
        Math.round(
          (result.structure * 0.2 +
            result.position * 0.3 +
            result.size * 0.3 +
            result.style * 0.2) *
            10
        ) / 10;
      result.basis =
        'Layout similarity: share of elements with matching tag order, position (±2px), size (±2px) and 12 key computed styles. It is not a pixel diff.';
      return result;
    } finally {
      f.remove();
    }
  }

  // Data extraction
  function extractData(kind, h) {
    const root = h ? target(h) : document;
    if (kind === 'links')
      return [...root.querySelectorAll('a[href]')].slice(0, 5000).map((a) => ({
        text: clip(a.textContent.trim().replace(/\s+/g, ' '), 120),
        href: absUrl(a.getAttribute('href')),
        rel: a.rel || '',
      }));
    if (kind === 'images')
      return [...root.querySelectorAll('img')].slice(0, 3000).map((i) => ({
        src: i.currentSrc || i.src,
        alt: i.alt,
        width: i.naturalWidth,
        height: i.naturalHeight,
      }));
    if (kind === 'tables')
      return [...root.querySelectorAll('table')].slice(0, 100).map((t, ti) => ({
        index: ti,
        rows: [...t.rows]
          .slice(0, 2000)
          .map((r) => [...r.cells].map((c) => c.textContent.trim().replace(/\s+/g, ' '))),
      }));
    if (kind === 'forms')
      return [...root.querySelectorAll('form')].map((f) => ({
        action: f.getAttribute('action'),
        method: f.method,
        fields: [...f.elements].map((e) => ({
          tag: lc(e.tagName),
          type: e.type,
          name: e.name,
          id: e.id,
          required: e.required,
          placeholder: e.placeholder || null,
        })),
      }));
    if (kind === 'headings')
      return [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((x) => ({
        level: +x.tagName[1],
        text: x.textContent.trim(),
      }));
    if (kind === 'metadata') {
      const m = {};
      document.querySelectorAll('meta').forEach((x) => {
        const k =
          x.getAttribute('name') || x.getAttribute('property') || x.getAttribute('http-equiv');
        if (k) m[k] = x.content;
      });
      const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
        safe(() => JSON.parse(s.textContent), { error: 'invalid JSON-LD' })
      );
      return {
        title: document.title,
        url: location.href,
        lang: document.documentElement.lang,
        canonical: (document.querySelector('link[rel=canonical]') || {}).href || null,
        meta: m,
        jsonLd: ld,
      };
    }
    if (kind === 'repeated') return repeated(root);
    throw new Error('Unknown extraction kind: ' + kind);
  }
  function repeated(root) {
    // find parent with >=3 children sharing tag+class signature; extract text/links/images per child
    const best = { score: 0, parent: null, sig: null };
    const scope = root.querySelectorAll ? root : document;
    const els = [...scope.querySelectorAll('*')].slice(0, 6000);
    for (const p of els) {
      if (p.children.length < 3) continue;
      const groups = {};
      for (const c of p.children) {
        const sig = lc(c.tagName) + '.' + [...c.classList].sort().join('.');
        (groups[sig] = groups[sig] || []).push(c);
      }
      for (const [sig, list] of Object.entries(groups)) {
        const score = list.length * Math.min(5, 1 + (list[0].textContent.length > 20));
        if (list.length >= 3 && score > best.score) {
          best.score = score;
          best.parent = p;
          best.sig = sig;
          best.list = list;
        }
      }
    }
    if (!best.parent)
      return { found: false, rows: [], note: 'No repeated sibling structure (3+ items) found.' };
    const rows = best.list.slice(0, 1000).map((c) => ({
      text: clip(c.textContent.trim().replace(/\s+/g, ' '), 300),
      link: (c.querySelector('a[href]') || {}).href || null,
      image: (c.querySelector('img') || {}).currentSrc || null,
      heading: ((c.querySelector('h1,h2,h3,h4,h5,h6') || {}).textContent || '').trim() || null,
    }));
    return {
      found: true,
      container: (selectorsFor(best.parent)[0] || {}).selector,
      itemSignature: best.sig,
      count: best.list.length,
      rows,
      provenance: 'inferred (sibling pattern detection)',
    };
  }

  // Resource map
  function resourceMap() {
    const nodes = [],
      edges = [];
    const add = (id, type, label, extra) => {
      if (!nodes.find((n) => n.id === id))
        nodes.push({ id, type, label: clip(label, 70), ...(extra || {}) });
    };
    const edge = (a, b, rel) => edges.push({ from: a, to: b, rel });
    add('page', 'page', location.href);
    const perf = performance.getEntriesByType('resource');
    const typeOf = (n) =>
      /\.(css)(\?|$)/.test(n)
        ? 'css'
        : /\.m?js(\?|$)/.test(n)
          ? 'js'
          : /\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(n)
            ? 'image'
            : /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(n)
              ? 'font'
              : /\.(mp4|webm|mp3|ogg)(\?|$)/.test(n)
                ? 'media'
                : 'other';
    document.querySelectorAll('link[rel~=stylesheet]').forEach((l) => {
      add(l.href, 'css', l.href);
      edge('page', l.href, 'link');
    });
    document.querySelectorAll('script[src]').forEach((s) => {
      add(s.src, 'js', s.src);
      edge('page', s.src, 'script');
    });
    document.querySelectorAll('img[src]').forEach((i) => {
      const u = i.currentSrc || i.src;
      add(u, 'image', u);
      edge('page', u, 'img');
    });
    for (const sheet of allSheets(document)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      const from = sheet.href || 'inline-style';
      if (!sheet.href) add('inline-style', 'css', '<style> (inline)');
      const walk = (list) => {
        for (const r of list) {
          if (r.type === 3) {
            const u = absUrl(r.href);
            add(u, 'css', u);
            edge(from, u, '@import');
          } else if (r.type === 5) {
            const m = r.style.getPropertyValue('src').match(/url\((['"]?)(.*?)\1\)/);
            if (m) {
              const u = new URL(m[2], sheet.href || document.baseURI).href;
              add(u, 'font', u);
              edge(from, u, '@font-face');
            }
          } else if (r.type === 1) {
            const m = r.style.cssText.match(/url\((['"]?)(.*?)\1\)/g);
            if (m)
              m.slice(0, 3).forEach((x) => {
                const raw = x.replace(/^url\((['"]?)|(['"]?)\)$/g, '');
                if (raw.startsWith('data:')) return;
                const u = new URL(raw, sheet.href || document.baseURI).href;
                add(u, typeOf(u) === 'font' ? 'font' : 'image', u);
                edge(from, u, 'url()');
              });
          } else if (r.cssRules) walk(r.cssRules);
        }
      };
      walk(rules);
    }
    perf.forEach((r) => {
      const t = r.initiatorType;
      if (t === 'fetch' || t === 'xmlhttprequest' || t === 'beacon') {
        add(r.name, 'api', r.name);
        edge('page', r.name, t);
      } else if (!nodes.find((n) => n.id === r.name)) {
        add(r.name, typeOf(r.name), r.name);
        edge('page', r.name, t || 'resource');
      }
    });
    document.querySelectorAll('iframe[src]').forEach((f) => {
      add(f.src, 'iframe', f.src);
      edge('page', f.src, 'iframe');
    });
    const origin = location.origin;
    nodes.forEach((n) => {
      if (/^https?:/.test(n.id)) n.external = new URL(n.id).origin !== origin;
    });
    return {
      nodes: nodes.slice(0, 1500),
      edges: edges.slice(0, 3000),
      truncated: nodes.length > 1500,
      provenance:
        'observed (DOM, readable CSS, Performance entries). JS-to-resource relations are not included because they are not observable statically.',
    };
  }

  // Page overview / misc
  function pageInfo() {
    const doc = document;
    return {
      url: location.href,
      title: doc.title,
      doctype: doc.doctype ? doc.doctype.name : null,
      domCount: doc.getElementsByTagName('*').length,
      iframes: [...doc.querySelectorAll('iframe')].map((f) => {
        let ok = false;
        try {
          ok = !!f.contentDocument;
        } catch (_) {}
        return { src: f.src, accessible: ok };
      }),
      shadowHosts: countShadow(),
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      scrollHeight: doc.documentElement.scrollHeight,
      readyState: doc.readyState,
    };
  }
  function countShadow() {
    let n = 0,
      i = 0;
    const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    while (w.nextNode() && i++ < MAX_NODES) if (w.currentNode.shadowRoot) n++;
    return n;
  }

  function fullDom(keepScripts) {
    const clone = document.documentElement.cloneNode(true);
    clone
      .querySelectorAll(
        '#__df_overlay_host,#__df_overrides,#__df_defaults,#__df_compare' +
          (keepScripts ? '' : ',script')
      )
      .forEach((n) => n.remove());
    clone.querySelectorAll('style').forEach((st) => {
      st.textContent = st.textContent.replace(/<\/style/gi, '\\3c /style');
    });
    return '<!DOCTYPE html>\n' + clone.outerHTML;
  }

  function responsiveReport() {
    const scrollW = document.documentElement.scrollWidth,
      cw = document.documentElement.clientWidth;
    const overflowing = [];
    if (scrollW > cw) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let n = 0;
      while (w.nextNode() && n++ < MAX_NODES && overflowing.length < 25) {
        const el = w.currentNode;
        const r = el.getBoundingClientRect();
        if (r.right > cw + 1 && r.width > 0)
          overflowing.push({
            h: handleOf(el),
            el:
              lc(el.tagName) +
              (el.id ? '#' + el.id : '') +
              (el.classList[0] ? '.' + el.classList[0] : ''),
            right: Math.round(r.right),
            width: Math.round(r.width),
          });
      }
    }
    const bps = new Set();
    for (const sheet of allSheets(document)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        continue;
      }
      const walk = (l) => {
        for (const r of l) {
          if (r.type === 4) {
            (r.conditionText || r.media.mediaText)
              .match(/\d+(\.\d+)?(px|em|rem)/g)
              ?.forEach((x) => bps.add(x));
          }
          if (r.cssRules) walk(r.cssRules);
        }
      };
      walk(rules);
    }
    const hasViewportMeta = !!document.querySelector('meta[name=viewport]');
    return {
      viewportWidth: cw,
      scrollWidth: scrollW,
      horizontalOverflow: scrollW > cw,
      overflowing,
      breakpointsInCss: [...bps].sort((a, b) => parseFloat(a) - parseFloat(b)),
      viewportMeta: hasViewportMeta,
      note: 'Run at several widths using the panel (window resize via the tab). Cross-origin stylesheets are not included.',
    };
  }

  // Workflow recording / replay
  const rec = { on: false, steps: [], last: 0 };
  const recHandler = (e) => {
    if (!rec.on) return;
    const el = e.target;
    if (!isEl(el) || el.id === '__df_overlay_host') return;
    const sels = selectorsFor(el);
    const step = {
      t: Date.now() - rec.last,
      selector: sels[0].selector,
      alt: sels.slice(1, 3).map((s) => s.selector),
    };
    if (e.type === 'click') step.action = 'click';
    else if (e.type === 'change' || e.type === 'input') {
      if (e.type === 'input' && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
      step.action = 'type';
      step.value = /password/i.test(el.type) ? '' : el.value;
      if (/password/i.test(el.type)) step.note = 'password value not recorded';
      const last = rec.steps[rec.steps.length - 1];
      if (last && last.action === 'type' && last.selector === step.selector) {
        last.value = step.value;
        return;
      }
    } else return;
    rec.steps.push(step);
    rec.last = Date.now();
  };
  function record(on) {
    if (on && !rec.on) {
      rec.on = true;
      rec.steps = [];
      rec.last = Date.now();
      ['click', 'input', 'change'].forEach((n) => document.addEventListener(n, recHandler, true));
    } else if (!on && rec.on) {
      rec.on = false;
      ['click', 'input', 'change'].forEach((n) =>
        document.removeEventListener(n, recHandler, true)
      );
    }
    return { recording: rec.on, steps: rec.steps };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function resolveSel(sel, alts) {
    for (const s of [sel, ...(alts || [])]) {
      const el =
        s &&
        (s.startsWith('/')
          ? document.evaluate(s, document, null, 9, null).singleNodeValue
          : safe(() => document.querySelector(s)));
      if (el) return el;
    }
    return null;
  }
  function setValue(el, v) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function runWorkflow(steps) {
    const log = [];
    const data = {};
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      try {
        if (s.action === 'wait') {
          await sleep(Math.min(+s.ms || 500, 30000));
          log.push({ i, ok: true, action: 'wait' });
          continue;
        }
        if (s.action === 'waitFor') {
          const to = Date.now() + Math.min(+s.timeout || 5000, 30000);
          let el;
          while (!(el = resolveSel(s.selector, s.alt)) && Date.now() < to) await sleep(100);
          if (!el) throw new Error('Timed out waiting for ' + s.selector);
          log.push({ i, ok: true, action: 'waitFor' });
          continue;
        }
        if (s.action === 'navigate') {
          log.push({
            i,
            ok: true,
            action: 'navigate',
            note: 'navigation ends this run; re-run from the next step',
          });
          location.href = s.url;
          return { log, data, interrupted: true };
        }
        const el = resolveSel(s.selector, s.alt);
        if (!el) throw new Error('Element not found: ' + s.selector);
        if (s.action === 'click') {
          el.scrollIntoView({ block: 'center' });
          el.click();
        } else if (s.action === 'type') {
          el.focus();
          setValue(el, s.value || '');
        } else if (s.action === 'extract') {
          data[s.name || 'step' + i] = s.attr
            ? el.getAttribute(s.attr)
            : el.textContent.trim().replace(/\s+/g, ' ');
        } else throw new Error('Unknown action ' + s.action);
        log.push({ i, ok: true, action: s.action, selector: s.selector });
        await sleep(+s.delay || 80);
      } catch (e) {
        log.push({ i, ok: false, action: s.action, error: e.message });
        if (!s.continueOnError) return { log, data, failedAt: i };
      }
    }
    return { log, data };
  }

  // Site resource discovery (for "download all code")
  const EXT_KIND = {
    js: 'js',
    mjs: 'js',
    cjs: 'js',
    css: 'css',
    html: 'html',
    htm: 'html',
    xhtml: 'html',
    json: 'json',
    webmanifest: 'json',
    map: 'map',
    wasm: 'wasm',
    xml: 'data',
    txt: 'data',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    avif: 'image',
    svg: 'image',
    ico: 'image',
    bmp: 'image',
    woff: 'font',
    woff2: 'font',
    ttf: 'font',
    otf: 'font',
    eot: 'font',
    mp4: 'media',
    webm: 'media',
    mp3: 'media',
    ogg: 'media',
    wav: 'media',
    m4a: 'media',
    m3u8: 'media',
    mov: 'media',
  };
  function kindFromUrl(u) {
    try {
      const p = new URL(u).pathname;
      const m = p.match(/\.([a-z0-9]{1,6})$/i);
      return m ? EXT_KIND[m[1].toLowerCase()] || null : null;
    } catch (_) {
      return null;
    }
  }
  function siteResources() {
    const out = new Map();
    const add = (u, kind, via) => {
      if (!u || SKIP_URL.test(u)) return;
      let a;
      try {
        a = new URL(u, document.baseURI);
      } catch (_) {
        return;
      }
      if (!/^https?:$/.test(a.protocol)) return;
      a.hash = '';
      const href = a.href;
      const k = kind || kindFromUrl(href) || 'other';
      const e = out.get(href);
      if (!e) out.set(href, { url: href, kind: k, via: [via] });
      else {
        if (!e.via.includes(via)) e.via.push(via);
        if (e.kind === 'other' && k !== 'other') e.kind = k;
      }
    };
    document.querySelectorAll('link[href]').forEach((l) => {
      const rel = lc(l.rel);
      let k = null;
      if (/stylesheet/.test(rel)) k = 'css';
      else if (/icon|apple-touch|mask-icon/.test(rel)) k = 'image';
      else if (/manifest/.test(rel)) k = 'json';
      else if (/modulepreload/.test(rel)) k = 'js';
      else if (/preload|prefetch/.test(rel))
        k = { script: 'js', style: 'css', font: 'font', image: 'image' }[lc(l.as)] || null;
      if (k) add(l.href, k, 'link[' + rel + ']');
    });
    document.querySelectorAll('script[src]').forEach((s) => add(s.src, 'js', 'script'));
    document
      .querySelectorAll('img,source,video,audio,track,embed,object,iframe,frame,input[type=image]')
      .forEach((n) => {
        const t = lc(n.tagName);
        const k =
          t === 'iframe' || t === 'frame'
            ? 'html'
            : t === 'track'
              ? 'data'
              : t === 'video' ||
                  t === 'audio' ||
                  (t === 'source' &&
                    n.parentElement &&
                    /^(video|audio)$/i.test(n.parentElement.tagName))
                ? 'media'
                : t === 'object' || t === 'embed'
                  ? null
                  : 'image';
        ['src', 'data', 'poster', 'data-src'].forEach((a) => {
          const v = n.getAttribute(a);
          if (v) add(v, a === 'poster' ? 'image' : k, t + '[' + a + ']');
        });
        const ss = n.getAttribute('srcset') || n.getAttribute('data-srcset');
        if (ss)
          ss.split(',').forEach((p) => {
            const u = p.trim().split(/\s+/)[0];
            if (u) add(u, 'image', t + '[srcset]');
          });
      });
    document.querySelectorAll('use[href],use[xlink\\:href]').forEach((n) => {
      const v = n.getAttribute('href') || n.getAttribute('xlink:href');
      if (v && !v.startsWith('#')) add(v.split('#')[0], 'image', 'svg use');
    });
    document.querySelectorAll('[style*="url("]').forEach((n) => {
      (n.getAttribute('style').match(/url\(\s*['"]?([^'")]+)/g) || []).forEach((m) =>
        add(m.replace(/^url\(\s*['"]?/, ''), null, 'style attr')
      );
    });
    const unreadable = [];
    for (const sheet of allSheets(document)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (_) {
        if (sheet.href) unreadable.push(sheet.href);
        continue;
      }
      const base = sheet.href || document.baseURI;
      const walk = (list) => {
        for (const r of list) {
          if (r.type === 3) add(new URL(r.href, base).href, 'css', '@import');
          else if (r.type === 5 || r.type === 1) {
            (r.cssText.match(/url\(\s*(['"]?)(?!data:)([^'")]+)\1\s*\)/g) || []).forEach((m) => {
              const u = m.replace(/^url\(\s*['"]?|['"]?\s*\)$/g, '');
              try {
                add(
                  new URL(u, base).href,
                  r.type === 5 ? 'font' : null,
                  r.type === 5 ? '@font-face' : 'css url()'
                );
              } catch (_) {}
            });
          } else if (r.cssRules) walk(r.cssRules);
        }
      };
      walk(rules);
    }
    performance.getEntriesByType('resource').forEach((r) => {
      const it = r.initiatorType;
      if (it === 'fetch' || it === 'xmlhttprequest' || it === 'beacon') {
        try {
          const a = new URL(r.name);
          a.hash = '';
          if (!out.has(a.href)) out.set(a.href, { url: a.href, kind: 'api', via: ['perf:' + it] });
        } catch (_) {}
        return;
      }
      const k = it === 'script' ? 'js' : it === 'img' ? 'image' : it === 'iframe' ? 'html' : null;
      add(r.name, k, 'perf:' + it);
    });
    const inlineScripts = [],
      inlineStyles = [];
    document.querySelectorAll('script:not([src])').forEach((s, i) => {
      const t = s.textContent || '';
      if (t.trim() && s.id !== '__df_bridge')
        inlineScripts.push({
          index: i,
          type: s.type || 'classic',
          code: t.length > 2e6 ? t.slice(0, 2e6) : t,
          truncated: t.length > 2e6,
        });
    });
    document.querySelectorAll('style').forEach((s, i) => {
      if (s.id === '__df_overrides') return;
      const t = s.textContent || '';
      if (t.trim()) inlineStyles.push({ index: i, css: t.length > 2e6 ? t.slice(0, 2e6) : t });
    });
    return {
      page: location.href,
      base: document.baseURI,
      title: document.title,
      resources: [...out.values()].slice(0, 5000),
      inlineScripts,
      inlineStyles,
      unreadableSheets: unreadable,
      metaGenerator: (document.querySelector('meta[name=generator]') || {}).content || null,
    };
  }
  async function fetchInPage(url, maxBytes) {
    const u = new URL(url, document.baseURI);
    if (u.origin !== location.origin) throw new Error('not same-origin');
    const r = await fetch(u.href, { credentials: 'same-origin', cache: 'force-cache' });
    const len = +r.headers.get('content-length') || 0;
    if (len > maxBytes) throw new Error('too large (' + len + ' bytes)');
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('too large (' + buf.length + ' bytes)');
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return {
      status: r.status,
      ok: r.ok,
      type: r.headers.get('content-type') || '',
      b64: btoa(bin),
      bytes: buf.length,
    };
  }

  // Exposed API
  window.__DF = {
    version: 1,
    ping: () => ({ ok: true, url: location.href }),
    pageInfo,
    startPick,
    stopPick,
    select: (h) => {
      const el = target(h);
      select(el);
      return describe(el);
    },
    selectBySelector,
    relative,
    describe: (h) => describe(target(h)),
    children,
    search,
    css: (h) => cssFor(target(h)),
    computedAll,
    edit,
    undo,
    redo,
    resetAll,
    history,
    patch,
    forceState,
    trackMutations,
    scriptsInfo,
    accessibilityAudit,
    performanceAudit,
    observeLongTasks,
    securityAudit,
    fetchHeaders,
    collectComponent,
    recreate,
    compareRecreation,
    extractData,
    resourceMap,
    fullDom,
    responsiveReport,
    siteResources,
    fetchInPage,
    record,
    runWorkflow,
    highlight: (h) => {
      const el = byHandle(h);
      if (el) {
        drawBox(el, 'highlight');
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return { ok: !!el };
    },
    clearHighlight: () => {
      if (state.hoverBox) state.hoverBox.box.style.display = 'none';
      return { ok: true };
    },
    selectedHandle: () =>
      state.selected && state.selected.isConnected ? handleOf(state.selected) : null,
    destroy: () => {
      stopPick();
      record(false);
      trackMutations(false);
      resetAll();
      if (state.overlay) state.overlay.remove();
      if (defaultsFrame) defaultsFrame.remove();
      delete window.__DF;
      return { ok: true };
    },
    _selectorsFor: (h) => selectorsFor(target(h)),
    _stats: () => ({
      handles: handles.size,
      undo: state.undo.length,
      redo: state.redo.length,
      mutations: state.mutations.length,
      changeLog: state.changeLog.length,
    }),
  };
})();
