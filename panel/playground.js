registerTab('play', 'Playground', async (v) => {
  const pg = (DF.state.pg = DF.state.pg || {
    html: '<h1>Hello</h1>\n<button id="b">Click</button>',
    css: 'body{font-family:system-ui;padding:1rem}\nbutton{padding:.4rem .8rem}',
    js: "document.getElementById('b').onclick = () => console.log('clicked', new Date().toISOString());",
  });
  const mk = (k, label) => {
    const ta = h('textarea', { rows: 7, 'aria-label': label, spellcheck: 'false' });
    ta.value = pg[k];
    ta.addEventListener('input', () => {
      pg[k] = ta.value;
      sched();
    });
    return ta;
  };
  const eh = mk('html', 'HTML'),
    ec = mk('css', 'CSS'),
    ej = mk('js', 'JavaScript');
  const frame = h('iframe', {
    class: 'preview',
    title: 'Preview',
    sandbox: 'allow-scripts allow-modals allow-forms allow-popups',
  });
  const con = h('pre', { id: 'con', style: { maxHeight: '140px' } }, '');
  const paused = !!DF.state.pgPaused;
  let t;
  const sched = () => {
    clearTimeout(t);
    if (!DF.state.pgPaused) t = setTimeout(run, 350);
  };
  // Reload the sandbox on every run. document.open() drops the page's own message listener,
  // so re-running in place would silently do nothing.
  let runSeq = 0;
  const run = () => {
    con.textContent = '';
    const my = ++runSeq;
    const onLoad = () => {
      frame.removeEventListener('load', onLoad);
      if (my === runSeq && frame.contentWindow)
        frame.contentWindow.postMessage({ df: 'run', html: pg.html, css: pg.css, js: pg.js }, '*');
    };
    frame.addEventListener('load', onLoad);
    frame.src = 'sandbox.html?r=' + my;
  };
  if (!paused) setTimeout(run, 0);
  const onMsg = (e) => {
    if (e.data && e.data.df === 'console' && e.source === frame.contentWindow) {
      con.textContent += `[${e.data.level}] ${e.data.args.join(' ')}\n`;
      con.scrollTop = con.scrollHeight;
    }
  };
  window.removeEventListener('message', DF._pgMsg);
  DF._pgMsg = onMsg;
  window.addEventListener('message', onMsg);
  const fmt = (k, ta, how) => {
    try {
      const B = beautifier;
      ta.value = pg[k] =
        how === 'min'
          ? k === 'css'
            ? ta.value
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\s+/g, ' ')
                .replace(/\s*([{}:;,])\s*/g, '$1')
                .replace(/;}/g, '}')
                .trim()
            : k === 'html'
              ? ta.value
                  .replace(/<!--[\s\S]*?-->/g, '')
                  .replace(/>\s+</g, '><')
                  .trim()
              : (() => {
                  throw new Error(
                    'JS minification needs a minifier library; not included. Use Beautify for readability.'
                  );
                })()
          : (k === 'js' ? B.js : k === 'css' ? B.css : B.html)(ta.value, { indent_size: 2 });
      sched();
    } catch (e) {
      toast(e.message);
    }
  };
  const tools = (k, ta) =>
    h(
      'div',
      { class: 'row' },
      h('button', { on: { click: () => fmt(k, ta, 'beauty') } }, 'Beautify'),
      h('button', { on: { click: () => fmt(k, ta, 'min') } }, 'Minify')
    );
  const find = h('input', { placeholder: 'find', 'aria-label': 'Find' }),
    rep = h('input', { placeholder: 'replace', 'aria-label': 'Replace' });
  v.append(
    h(
      'div',
      { class: 'row' },
      find,
      rep,
      h(
        'button',
        {
          on: {
            click: () => {
              if (!find.value) return;
              let n = 0;
              [
                ['html', eh],
                ['css', ec],
                ['js', ej],
              ].forEach(([k, ta]) => {
                const parts = ta.value.split(find.value);
                n += parts.length - 1;
                ta.value = pg[k] = parts.join(rep.value);
              });
              toast(n + ' replacement(s)');
              sched();
            },
          },
        },
        'Replace all'
      ),
      h(
        'button',
        {
          on: {
            click: () => {
              const hits = ['html', 'css', 'js'].map(
                (k) => k + ': ' + (pg[k].split(find.value).length - 1)
              );
              toast('Matches - ' + hits.join(', '));
            },
          },
        },
        'Search'
      )
    ),
    section('HTML', eh, tools('html', eh)),
    section('CSS', ec, tools('css', ec)),
    section('JavaScript', ej, tools('js', ej)),
    paused
      ? h(
          'div',
          { class: 'card sev-warn' },
          h('b', null, 'Not running: '),
          'this code came from an import, a saved item or an AI reply. Read it, then press Run. (The preview is also offline: network requests are blocked by its CSP.)'
        )
      : '',
    section('Preview (sandboxed, offline, no extension access)', frame),
    section(
      'Console / errors',
      con,
      h(
        'div',
        { class: 'row' },
        h('button', { on: { click: () => (con.textContent = '') } }, 'Clear'),
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: () => {
                DF.state.pgPaused = false;
                run();
                show('play');
              },
            },
          },
          'Run'
        ),
        h(
          'button',
          {
            on: {
              click: () =>
                download(
                  'playground-' + stamp() + '.zip',
                  DFZip.build([
                    {
                      path: 'index.html',
                      data: `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head><body>\n${pg.html}\n<script src="script.js"></script></body></html>`,
                    },
                    { path: 'style.css', data: pg.css },
                    { path: 'script.js', data: pg.js },
                  ]),
                  'application/zip'
                ),
            },
          },
          'Export ZIP'
        ),
        h(
          'button',
          {
            on: {
              click: () =>
                saveToWorkspace('playground', 'playground', {
                  html: pg.html,
                  css: pg.css,
                  js: pg.js,
                }),
            },
          },
          'Save'
        ),
        h(
          'button',
          {
            on: {
              click: () => {
                const i = document.createElement('input');
                i.type = 'file';
                i.accept = '.html,.css,.js,.json,.txt';
                i.onchange = async () => {
                  const f = i.files[0];
                  const text = await f.text();
                  const k = /\.css$/.test(f.name) ? 'css' : /\.js$/.test(f.name) ? 'js' : 'html';
                  pg[k] = text;
                  DF.state.pgPaused = true;
                  show('play');
                };
                i.click();
              },
            },
          },
          'Import file'
        )
      )
    )
  );
});
