// Text for the Guide tab. Data only, so a Node test can check it: every tab has a card, the
// sentences stay short, and every button name written as [Name] still exists in the panel code.
// Write for a beginner. Short sentences, no term without a one-line meaning in GLOSSARY.
const DFGuide = (() => {
  const WHAT = [
    'DevForge is a toolbox that opens in the side of Chrome, next to the page you are working on.',
    'You can look inside the page, watch its network calls, measure its speed and save parts of it as code.',
    'Everything runs in your browser. There are no accounts and no analytics.',
  ];

  const FIRST_STEPS = [
    'Open a web page you are working on. A local page or your own site is a good start.',
    'Click the DevForge icon in the Chrome toolbar, or press Ctrl+Shift+Y. The panel opens at Home.',
    'Press Ctrl+Shift+U, then click any element on the page. This is called picking.',
    'The panel switches to Inspect. Read the selectors, the size and the styles of what you picked.',
    'Open Export and click [Download everything (ZIP)]. You get the element as code in one ZIP file.',
    'To watch the page talk to its server, open Network and click [Start capture]. Then use the page.',
  ];

  // One card per tab. `steps` are exactly three. A name in [square brackets] is a button or
  // label in the panel. The test fails if the name is no longer in the panel code.
  const CARDS = [
    {
      id: 'home',
      name: 'Home',
      does: 'Shows whether DevForge can work on this page. It also gives one-click starts for common jobs.',
      steps: ['Open DevForge on a web page.', 'Read the status cards at the top.', 'Click a tile to start that job.'],
      cannot: 'It does not change anything by itself.',
    },
    {
      id: 'guide',
      name: 'Guide',
      does: 'This page. It explains each tab in plain words.',
      steps: ['Read First 5 minutes.', 'Find the card for the tab you want.', 'Click the Open button on the card.'],
      cannot: 'It does not run anything on your page.',
    },
    {
      id: 'inspect',
      name: 'Inspect',
      does: 'Shows what is inside one element: selectors, box model, styles and accessibility facts.',
      steps: ['Click [Pick] in the top bar.', 'Click the element on the page.', 'Read the details. Use [Copy selector] to reuse them.'],
      cannot: 'It cannot see inside a closed shadow DOM or in frames from other sites.',
    },
    {
      id: 'css',
      name: 'CSS',
      does: 'Shows the style rules that apply to the picked element. You can try new values on the live page.',
      steps: ['Pick an element.', 'Type a property and a value.', 'Click [Apply]. Use [Export JSON] to keep your changes.'],
      cannot: 'Your edits change only the open page. They never change the site.',
    },
    {
      id: 'tokens',
      name: 'Tokens',
      does: 'Finds the colours, font sizes, spacing and shadows a page uses. It can also check colour contrast.',
      steps: ['Click [Scan design tokens].', 'Read the colours and sizes it found.', 'Copy them, or download them as CSS variables or JSON.'],
      cannot: 'It reads the page as drawn. It does not read your source files.',
    },
    {
      id: 'network',
      name: 'Network',
      does: 'Records the calls a page makes with fetch, XHR, WebSocket and similar tools. You can mock, delay and replay them.',
      steps: ['Click [Start capture].', 'Use the page, so it makes requests.', 'Click a row to see its headers and body.'],
      cannot: 'It does not list images, scripts or style files that the HTML loads. Calls made before you started are missed.',
    },
    {
      id: 'perf',
      name: 'Perf',
      does: 'Measures how fast the page feels. Each Core Web Vitals number points to the element behind it.',
      steps: ['Open Perf on the page.', 'Use the page, then click [Refresh vitals].', 'Read each number with its element. Use [Export JSON] to keep it.'],
      cannot: 'It measures this page on your computer only. It does not test other devices or slow networks.',
    },
    {
      id: 'mutations',
      name: 'Mutations',
      does: 'Records every change to the page structure, with the old and new values.',
      steps: ['Click [Start tracking].', 'Use the page.', 'Read the timeline. Use the filter to find one element.'],
      cannot: 'It records only while tracking is on.',
    },
    {
      id: 'audit',
      name: 'Audit',
      does: 'Runs checks for accessibility, performance, scripts and responsive layout, only when you ask.',
      steps: ['Open Audit.', 'Click one check, such as [Accessibility].', 'Read the list of issues.'],
      cannot: 'Automatic checks find only some problems. A person still has to test with a keyboard and a screen reader.',
    },
    {
      id: 'security',
      name: 'Security',
      does: 'Looks for common security problems on a site you own, have permission to test, or run locally. It can also draft a CSP policy and integrity tags.',
      steps: ['Open Security on one of those sites.', 'Choose a scan level and click [Start scan].', 'Read the findings. Click [Check again] on one after you fix it.'],
      cannot: 'It cannot test your server, your TLS setup or log-in strength. It never attacks the site.',
    },
    {
      id: 'owner',
      name: 'Owner',
      does: 'Lets you protect the detailed scan record with a passphrase you choose. It is optional.',
      steps: ['Click [Set up Owner mode].', 'Pick a strong passphrase of at least 12 characters.', 'Unlock it when you want to read sealed data.'],
      cannot: 'A forgotten passphrase cannot be recovered. It never raises a scan limit.',
    },
    {
      id: 'storage',
      name: 'Storage',
      does: 'Shows and edits what the page keeps in your browser: localStorage, sessionStorage and cookies that scripts can read.',
      steps: ['Open Storage.', 'Click [Edit] on a row and change it.', 'Use [Delete] to remove it, or [Export] to save a copy.'],
      cannot: 'It cannot read HttpOnly cookies. Browsers hide them from extensions.',
    },
    {
      id: 'data',
      name: 'Data',
      does: 'Pulls links, images, tables, forms and headings out of the page into CSV, JSON, Markdown or HTML.',
      steps: ['Open Data.', 'Choose what to pull, such as Links or Tables.', 'Download or copy the result.'],
      cannot: 'It reads only what is on the page right now.',
    },
    {
      id: 'export',
      name: 'Export',
      does: 'Saves the picked part of a page as a ZIP of HTML, CSS, scripts, images and a README. It also makes page bundles and screenshots.',
      steps: ['Pick an element.', 'Open Export and choose [Selected part] or [Page bundle].', 'Click [Download everything (ZIP)].'],
      cannot: 'It cannot save server code. It cannot list the click handlers that scripts add after the page loads.',
    },
    {
      id: 'site',
      name: 'Site',
      does: 'Detects what the site is built with and saves the files the page uses as a ZIP.',
      steps: ['Click [Scan this page].', 'Check the list of files.', 'Click [Download all site code].'],
      cannot: 'It never downloads private or local addresses. It stops at 1,500 files or 150 MB.',
    },
    {
      id: 'recreate',
      name: 'Recreate',
      does: 'Rebuilds an element from its computed styles, then adjusts the copy until its layout matches.',
      steps: ['Pick an element.', 'Click [Recreate & compare].', 'Click [Download ZIP] or [Save to workspace].'],
      cannot: 'It rebuilds the look. It does not copy the original code.',
    },
    {
      id: 'proto',
      name: 'Prototype',
      does: 'Lets you try new styles on the live page with a visual dashboard or with code.',
      steps: ['Click [Analyse page and selection].', 'Change a style, then click [Apply (Ctrl+Enter)].', 'Click [Reset page] to undo everything.'],
      cannot: 'Your changes affect only your open tab. They never reach the site.',
    },
    {
      id: 'play',
      name: 'Playground',
      does: 'A scratchpad for HTML, CSS and JavaScript. It runs in a sealed page.',
      steps: ['Type your code.', 'Click [Run].', 'Use [Beautify] to tidy it or [Save] to keep it.'],
      cannot: 'The sealed page cannot use DevForge features or read your open page.',
    },
    {
      id: 'auto',
      name: 'Automate',
      does: 'Records the steps you do on a page and replays them. Workflows are stored as JSON.',
      steps: ['Click [Start recording] and do the steps.', 'Click [Stop & import].', 'Click [▶ Run] to replay them.'],
      cannot: 'Passwords are never recorded. A page that navigates away can interrupt a run.',
    },
    {
      id: 'ai',
      name: 'AI',
      does: 'Builds a prompt from the picked element or a task. You read it, then use it in the AI chat you already use.',
      steps: ['Pick an element or choose a task.', 'Read the prompt. Click [Copy only], or [Copy & open] to open the chat site too.', 'Paste the reply back and click [Validate reply].'],
      cannot: 'It needs no API key and cannot read the chat. [Copy & open] may put the prompt in the web address of the AI site, so read the prompt first.',
    },
    {
      id: 'work',
      name: 'Workspace',
      does: 'Keeps what you save from other tabs, such as elements, screenshots and workflows, in projects.',
      steps: ['Click [Create] to make a project.', 'Use [Save to workspace] in other tabs.', 'Click [Open] on an item to see it again.'],
      cannot: 'Items are not encrypted unless you turn on Owner mode encryption.',
    },
    {
      id: 'settings',
      name: 'Settings',
      does: 'Changes the theme, which sites DevForge may work on, shortcuts and automatic clean-up.',
      steps: ['Open Settings.', 'Click [Allow the current site] to add the site you are on.', 'Click a shortcut box and press the keys you want.'],
      cannot: 'The two Chrome shortcuts change at chrome://extensions/shortcuts, not here.',
    },
  ];

  const PROBLEMS = [
    { q: 'DevForge says it cannot run on this page.', a: 'Chrome does not let extensions run on some pages, such as chrome:// pages. Open a normal web page. For a local file, switch on Allow access to file URLs in chrome://extensions.' },
    { q: 'DevForge says the site is not on my list.', a: 'You limited DevForge to chosen sites. Open Settings and click [Allow the current site], or allow all sites again.' },
    { q: 'Network shows nothing.', a: 'Capture records only after you click [Start capture]. Click it, then use the page. To catch the first requests too, tick [From page start] in the Network tab.' },
    { q: 'Network shows a warning that the page replaced built-in functions.', a: 'A script on the page changed functions such as fetch before DevForge started. Tick [From page start] in the Network tab and reload the page, so capture starts first.' },
    { q: 'The Security scan will not start on a public site.', a: 'You must confirm that you own the site or have permission to test it. The confirmation lasts until you close the browser.' },
    { q: 'My Export has no preview picture.', a: 'The picture needs the tab to stay visible for a moment. Keep the tab in front while the export runs.' },
    { q: 'The Site ZIP is missing some files.', a: 'Open _devforge/report.json in the ZIP. It lists every file that was saved, failed or skipped, and why.' },
    { q: 'A Secrets check window opened before my export.', a: 'DevForge found text that looks like a password, key or token. The window lists the kind, file and line. Choose Mask to replace the values, or Cancel to save nothing.' },
    { q: 'A message says some saved data was ignored.', a: 'DevForge checks what it saved before it uses it. It replaced a damaged setting with the default, or left out a damaged record. Open Settings and read Stored data for the list. Nothing else is lost.' },
    { q: 'My selected element is gone.', a: 'The selection is cleared when the page reloads or you switch tabs. Pick the element again.' },
    { q: 'Some tabs are hidden.', a: 'The panel is too narrow for every tab. Use the menu button at the end of the tab bar, or make the panel wider.' },
  ];

  const PRIVACY = [
    'DevForge has no accounts, servers or analytics.',
    'Your settings and Network rules stay in Chrome storage on this computer.',
    'Workspace items and saved security reports stay in this browser, in IndexedDB.',
    'Downloads for Export and Site come from the sites that serve those files. They are not sent anywhere else.',
    'The AI tab sends nothing until you click. [Copy only] stays on your computer.',
    '[Copy & open] opens the AI site. For some sites it puts the prompt in the web address, so read the prompt first.',
    'Saved security reports describe a site’s weak points. Treat them like any sensitive file.',
  ];

  const SHORTCUTS = [
    { keys: 'Ctrl+Shift+Y', does: 'Open DevForge (Cmd+Shift+Y on a Mac).' },
    { keys: 'Ctrl+Shift+U', does: 'Pick an element on the page (Cmd+Shift+U on a Mac).' },
    { keys: 'Ctrl+K', does: 'Open the command palette. Type to find any action.' },
    { keys: 'Esc', does: 'Cancel picking, or close the palette.' },
    { keys: 'Ctrl+Enter', does: 'Apply your change in the Prototype tab.' },
  ];

  const GLOSSARY = [
    { term: 'DOM', meaning: 'The page as the browser holds it, a tree of elements.' },
    { term: 'CSS', meaning: 'The rules that set how elements look.' },
    { term: 'Selector', meaning: 'A short text that points to an element, such as #menu.' },
    { term: 'Element', meaning: 'One piece of the page, such as a button or a heading.' },
    { term: 'Shadow DOM', meaning: 'A hidden part inside an element, which DevForge cannot read if it is closed.' },
    { term: 'Request', meaning: 'A message a page sends to a server to get or send data.' },
    { term: 'fetch / XHR', meaning: 'Two ways a page sends a request from its scripts.' },
    { term: 'WebSocket', meaning: 'A connection that stays open so a page and a server can talk at any time.' },
    { term: 'Header', meaning: 'Extra information that travels with a request or a reply.' },
    { term: 'HAR', meaning: 'A file format that stores a list of network requests.' },
    { term: 'Mock', meaning: 'A fake reply that you set, so you can test without the real server.' },
    { term: 'Core Web Vitals', meaning: 'Three numbers about speed and stability: LCP, CLS and INP.' },
    { term: 'LCP', meaning: 'How long the biggest visible item takes to show.' },
    { term: 'CLS', meaning: 'How much the page layout jumps while it loads.' },
    { term: 'INP', meaning: 'How fast the page reacts when you click or type.' },
    { term: 'Accessibility', meaning: 'How well people with different needs can use the page.' },
    { term: 'Contrast', meaning: 'How different a text colour is from its background.' },
    { term: 'Design token', meaning: 'A named value, such as a brand colour, that a design reuses.' },
    { term: 'Cookie', meaning: 'A small piece of data a site keeps in your browser.' },
    { term: 'HttpOnly', meaning: 'A cookie flag that hides the cookie from page scripts.' },
    { term: 'localStorage', meaning: 'Browser storage that a page keeps until it is cleared.' },
    { term: 'sessionStorage', meaning: 'Browser storage that is cleared when the tab closes.' },
    { term: 'IndexedDB', meaning: 'A bigger database that a page can keep in your browser.' },
    { term: 'Source map', meaning: 'A file that links shipped code back to the original source.' },
    { term: 'TLS', meaning: 'The lock that keeps a web connection private.' },
    { term: 'Finding', meaning: 'One thing the Security tab reports, with its evidence and a fix.' },
    { term: 'Owner mode', meaning: 'An optional passphrase that protects sealed scan data.' },
    { term: 'Workspace', meaning: 'Your saved items, grouped in projects.' },
    { term: 'ZIP', meaning: 'One file that holds many files.' },
    { term: 'JSON', meaning: 'A plain text format for data.' },
    { term: 'API', meaning: 'The way one program asks another for data.' },
    { term: 'Side panel', meaning: 'The strip at the side of Chrome where DevForge lives.' },
  ];

  // Terms that need a GLOSSARY entry when a guide text uses them.
  const JARGON = ['DOM', 'CSS', 'HAR', 'JSON', 'API', 'TLS', 'LCP', 'CLS', 'INP', 'XHR', 'WebSocket', 'IndexedDB', 'localStorage', 'sessionStorage', 'HttpOnly', 'Core Web Vitals', 'source map', 'shadow DOM', 'design token', 'cookie'];

  const sentences = (text) =>
    String(text)
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const words = (s) => s.split(/\s+/).filter(Boolean);

  // Every guide text except the glossary meanings, for the reading checks.
  function allText() {
    const out = [...WHAT, ...FIRST_STEPS, ...PRIVACY];
    for (const c of CARDS) out.push(c.does, ...c.steps, c.cannot);
    for (const p of PROBLEMS) out.push(p.q, p.a);
    for (const s of SHORTCUTS) out.push(s.does);
    return out;
  }

  function readingStats(texts = allText()) {
    let count = 0;
    let total = 0;
    let longest = 0;
    for (const t of texts) {
      for (const s of sentences(t)) {
        const n = words(s).length;
        count++;
        total += n;
        longest = Math.max(longest, n);
      }
    }
    return { sentences: count, words: total, average: count ? total / count : 0, longest };
  }

  // [Name] marks a panel label in running text. Split it so the panel can draw it as a label.
  function parts(text) {
    const out = [];
    let last = 0;
    for (const m of String(text).matchAll(/\[([^\]]+)\]/g)) {
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ label: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  const labels = () => [...new Set(allText().flatMap((t) => [...t.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1])))];

  return { WHAT, FIRST_STEPS, CARDS, PROBLEMS, PRIVACY, SHORTCUTS, GLOSSARY, JARGON, sentences, readingStats, allText, parts, labels };
})();
if (typeof module !== 'undefined') module.exports = DFGuide;
