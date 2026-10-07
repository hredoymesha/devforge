const aiS = { built: null, reply: '' };
registerTab('ai', 'AI', async (v) => {
  const draft = DF.state.aiDraft;
  DF.state.aiDraft = null;
  const action = h(
    'select',
    { 'aria-label': 'Action' },
    Object.keys(DFAI.ACTIONS).map((a) =>
      h('option', { value: a, selected: a === 'recreate' && draft }, a)
    )
  );
  const prov = h(
    'select',
    { 'aria-label': 'AI service' },
    Object.entries(DFAI.PROVIDERS).map(([k, p]) =>
      h('option', { value: k }, p.name + (p.param ? '' : ' (paste manually)'))
    )
  );
  const task = h('textarea', {
    rows: 3,
    placeholder: 'What exactly do you want? (optional)',
    'aria-label': 'Task details',
  });
  const inc = { html: true, css: true, js: false, a11y: false, errors: false, network: false };
  const out = h('div'),
    review = h('div');
  const incBox = h(
    'div',
    { class: 'row' },
    Object.keys(inc).map((k) =>
      h(
        'label',
        null,
        h('input', {
          type: 'checkbox',
          checked: inc[k],
          on: { change: (e) => (inc[k] = e.target.checked) },
        }),
        ' ' + k
      )
    )
  );
  const buildIt = async () => {
    clear(out);
    try {
      let ctx = { title: '', url: DF.state.url, limitations: '' };
      if (draft) {
        ctx.html = draft.html;
        ctx.css = draft.css;
      }
      if (DF.state.h) {
        const c = await call('collectComponent', DF.state.h);
        ctx = {
          ...ctx,
          title: c.title,
          html: draft ? draft.html : c.html,
          css: draft ? draft.css : c.css,
          js: c.relatedScripts.map((s) => s.code).join('\n\n'),
          selector: DF.state.info.selectors[0].selector,
          framework: c.framework,
          limitations: `CSS: ${c.confidence.css.value}. JS: inferred only. Backend: unavailable. ${c.blockedSheets.length} unreadable stylesheet(s).`,
        };
      } else if (!draft)
        throw new Error('Select an element first (Pick), or arrive here from Recreate.');
      if (inc.a11y) {
        const a = await call('accessibilityAudit', DF.state.h);
        ctx.a11y = a.issues
          .slice(0, 25)
          .map((i) => `- ${i.severity} ${i.rule}: ${i.message} (${i.selector || ''})`)
          .join('\n');
      }
      if (inc.network) {
        ctx.network = JSON.stringify(
          net.items
            .filter((i) => i.kind !== 'perf')
            .slice(-15)
            .map((i) => {
              const r = redactEntry(i);
              return {
                method: r.method,
                url: r.url,
                status: r.status,
                reqHeaders: r.reqHeaders,
                resHeaders: r.resHeaders,
                reqBody: r.reqBody ? String(r.reqBody).slice(0, 1500) : null,
              };
            }),
          null,
          1
        );
      }
      if (inc.errors) {
        ctx.errors =
          'No console capture is available to extensions without the debugger permission. Paste errors into the task box instead.';
      }
      const b = DFAI.build({ action: action.value, task: task.value, includes: inc, ctx });
      aiS.built = b;
      aiS.provider = prov.value;
      aiS.action = action.value;
      const ta = h('textarea', { rows: 12, id: 'ai-text' });
      ta.value = b.text;
      const plan = DFAI.launchPlan(prov.value, b.text);
      clear(out).append(
        h(
          'div',
          { class: 'card sev-warn' },
          h('b', null, 'Privacy: '),
          'This prompt contains page content (below). It stays here until YOU click Send; then it goes to ' +
            plan.name +
            " under that service's terms. Review and edit it first."
        ),
        h(
          'div',
          { class: 'sev-info' },
          `${b.chars.toLocaleString()} chars ≈ ${b.approxTokens.toLocaleString()} tokens${b.truncated ? ' · some parts were truncated to fit' : ''}`
        ),
        ta,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'primary',
              on: {
                click: async () => {
                  const text = $('#ai-text').value;
                  const p = DFAI.launchPlan(prov.value, text);
                  const copied = await copy(text);
                  await chrome.tabs.create({ url: p.url });
                  status(
                    (copied
                      ? 'Copied to clipboard. '
                      : 'Clipboard FAILED - copy the text manually. ') + p.note,
                    copied ? 'ok' : 'err'
                  );
                  aiS.sentAt = Date.now();
                },
              },
            },
            'Copy & open ' + plan.name
          ),
          h('button', { on: { click: () => copy($('#ai-text').value) } }, 'Copy only'),
          h(
            'button',
            {
              on: {
                click: () =>
                  saveToWorkspace('ai-task', action.value + ' task', {
                    prompt: $('#ai-text').value,
                  }),
              },
            },
            'Save task'
          )
        ),
        h(
          'div',
          { class: 'sev-info' },
          "DevForge cannot read the AI site's reply (no API, no scraping). Paste the reply below to review it."
        )
      );
    } catch (e) {
      clear(out).append(h('div', { class: 'card sev-error' }, e.message));
    }
  };
  const reply = h('textarea', {
    rows: 8,
    id: 'ai-reply',
    placeholder: "Paste the AI's reply here…",
    'aria-label': 'AI reply',
  });
  const doReview = () => {
    clear(review);
    const r = DFValidate.review(reply.value, typeof acorn !== 'undefined' ? acorn : null);
    if (!reply.value.trim())
      return review.append(h('div', { class: 'sev-warn' }, 'Paste a reply first.'));
    review.append(
      h(
        'div',
        { class: 'row' },
        h('b', null, 'Review: '),
        h('span', { class: 'sev-error' }, r.counts.error + ' errors'),
        h('span', { class: 'sev-warn' }, r.counts.warn + ' warnings'),
        h('span', { class: 'sev-info' }, r.counts.info + ' notes')
      )
    );
    r.blocks.forEach((b, i) =>
      review.append(
        h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'row' },
            h('b', null, `Block ${i + 1}: ${b.lang}`),
            h('span', { class: 'sev-info' }, b.code.length + ' chars')
          ),
          b.issues.length
            ? b.issues.map((x) =>
                h(
                  'div',
                  { class: 'sev-' + x.severity },
                  `${x.severity} ${x.rule}${x.line ? ' (line ' + x.line + ')' : ''}: ${x.message}`
                )
              )
            : h(
                'div',
                { class: 'sev-info' },
                'No problems found by static checks (this does not prove it works).'
              ),
          h(
            'div',
            { class: 'row' },
            b.lang === 'css'
              ? h(
                  'button',
                  {
                    on: {
                      click: async () => {
                        if (
                          b.issues.some((x) => x.severity === 'error') &&
                          !confirm('This CSS has errors. Apply anyway?')
                        )
                          return;
                        try {
                          await call('edit', { kind: 'css-rule', value: b.code });
                          toast('Applied as live override - Undo is on the CSS tab');
                        } catch (e) {
                          toast(e.message);
                        }
                      },
                    },
                  },
                  'Test on page (reversible)'
                )
              : '',
            /^(html|css|js)$/.test(b.lang)
              ? h(
                  'button',
                  {
                    on: {
                      click: () => {
                        DF.state.pg = DF.state.pg || {};
                        DF.state.pg[b.lang] = b.code;
                        DF.state.pgPaused = true;
                        show('play');
                      },
                    },
                  },
                  'Open in Playground'
                )
              : '',
            h('button', { on: { click: () => copy(b.code) } }, 'Copy')
          )
        )
      )
    );
    if (r.cross.length)
      review.append(
        section(
          'Cross-checks',
          r.cross.map((x) => h('div', { class: 'sev-' + x.severity }, x.message))
        )
      );
    review.append(
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            on: {
              click: () => {
                const t = DFAI.critique(
                  (aiS.built ? aiS.built.text : '(original task not built in this session)').slice(
                    0,
                    12000
                  ),
                  reply.value.slice(0, 12000)
                );
                aiS.critique = t;
                const ta = $('#ai-text');
                if (ta) {
                  ta.value = t;
                  ta.scrollIntoView();
                  toast('Critique prompt loaded above. Send it to the same or a different AI.');
                } else copy(t);
              },
            },
          },
          'Build critique prompt (self-critic loop)'
        )
      )
    );
  };
  v.append(
    section(
      '1 · Build task',
      h('div', { class: 'row' }, action, prov),
      task,
      incBox,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'primary', on: { click: buildIt } },
          draft ? 'Build from recreation' : 'Build prompt'
        )
      ),
      h(
        'div',
        { class: 'sev-info' },
        'Free path: you paste into the chat site you already use. No API keys, no costs. URL prefill for Claude/ChatGPT is best-effort; the clipboard copy is the dependable path.'
      )
    ),
    out,
    section(
      '2 · Review the reply',
      reply,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'primary', on: { click: doReview } }, 'Validate reply')
      ),
      review
    )
  );
  if (draft) buildIt();
});
