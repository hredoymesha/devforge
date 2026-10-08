# Changelog

## 4.0.0

### New
- **Network interception rules**: block, mock a response, add latency, set request headers or
  redirect, for fetch / XHR / sendBeacon made by page scripts. Rules persist across sessions.
- **Network tab rebuilt**: live updates, DevTools-style filter (`status:4xx`, `method:post`,
  `domain:`, `larger-than:`, `is:mocked`, `-exclude`), sortable columns, waterfall, timing phases
  (DNS / TCP / TLS / TTFB / download), Server-Timing, GraphQL operation detection, edit & replay,
  copy as cURL / fetch / PowerShell, HAR 1.2 export, and optional capture from page start.
  WebSocket, EventSource and sendBeacon are captured too.
- **Perf tab**: Core Web Vitals (LCP, CLS, INP, FCP, TTFB) with the responsible elements, slowest
  interactions broken into input delay / processing / presentation, navigation timing, Long
  Animation Frame script attribution and a frame-rate profiler.
- **Mutations tab**: DOM change timeline with old → new values, hot elements, change rate,
  no-op write detection, on-page change flashing and JSON export.
- **Storage tab**: view, edit, add and delete localStorage, sessionStorage and script-visible
  cookies; IndexedDB, Cache Storage, service workers and quota usage.
- **Tokens tab**: extracts colors, type scale, spacing, radii and shadows from computed styles and
  exports CSS variables, SCSS, W3C design-token JSON or a Tailwind theme.
- **Inspect**: framework component inspector (React, Vue 2/3, Svelte, Angular dev mode) showing
  component names and props; quick edits (text, attribute, hide, delete; all undoable); layout X-ray.
- Right-click **Inspect with DevForge**, a "system" theme, a tab overflow menu for narrow panels.

### Fixed
- Ctrl+Shift+U could fail to open the panel (user gesture lost) and the pick command could be lost.
- The selection outline disappeared right after picking, and did not follow scrolling.
- Selecting any custom element (web component) crashed the inspector.
- Failing buttons produced unhandled promise rejections instead of a message.
- Redo after deleting an element always failed; undoing a style edit left `!important` behind.
- `:hover`/`:focus` emulation could produce invalid `!important !important` CSS.
- Recreating a very large element could freeze the page (the node cap was never enforced).
- A reused XHR object wrote later responses into earlier capture records.
- Full-page screenshots hit Chrome's capture rate limit; sticky headers repeated in every slice;
  element screenshots failed inside shadow DOM.
- Data exports could put values under the wrong column; the network redaction toggle did not
  refresh the view; Settings only listed 12 shortcuts and trapped the Tab key.
- Each page call needed three script injections; it now needs one. Agents left over from an older
  extension version are detected and replaced.
- `minimum_chrome_version` raised to 116, which `sidePanel.open()` requires.
