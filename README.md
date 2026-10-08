# DevForge 4.0.0

A local-first web development workbench that lives in Chrome's side panel. DevForge sits next to
the page you are working on and gives you an inspector, a network layer you can intercept and
rewrite, Core Web Vitals profiling, a DOM mutation timeline, storage editing and design-token
extraction. Everything runs in your browser. There are no accounts, servers or analytics.

## Why DevForge

Chrome DevTools is the reference, and DevForge does not try to replace it. It covers the work
that DevTools makes slow: mocking an API response without a proxy, seeing which element caused
your LCP, exporting a component with its computed styles, or turning a site's colours into
design tokens. DevForge is a Manifest V3 extension. It asks for the least access it needs, and
it only injects code into a page when you use a tool on that page.

## Panels

The panels are grouped the way you would move through a debugging session.

**Inspect and style**

| Panel | What it does |
| --- | --- |
| Inspect | Element picker, DOM tree, selectors, box model and accessibility info. Includes a component inspector for React, Vue 2/3, Svelte and Angular (dev mode), quick edits with undo/redo, and a layout X-ray. |
| CSS | Matched rules, computed styles and live edits that are checked before they are applied. Emulates `:hover`/`:focus` without the debugger permission. |
| Tokens | Pulls colours, type scale, spacing, radii and shadows from computed styles. Exports CSS variables, SCSS, W3C design-token JSON or a Tailwind theme. |

**Network**

| Panel | What it does |
| --- | --- |
| Network | Live capture of `fetch`, XHR, WebSocket, EventSource and `sendBeacon`. Filters work like DevTools (`status:4xx`, `method:post`, `domain:`, `larger-than:`, `is:mocked`, `-exclude`). Also: sortable columns, a waterfall, timing phases (DNS / TCP / TLS / TTFB / download), Server-Timing, GraphQL operation names, edit and replay, copy as cURL / fetch / PowerShell, and HAR 1.2 export. |
| Interception rules | Add latency, set request headers, block, mock a response or redirect. Rules are checked in order for each request and are saved between sessions. You can turn on capture from page start for each site. |

**Performance**

| Panel | What it does |
| --- | --- |
| Perf | LCP, CLS, INP, FCP and TTFB, each linked to the element that caused it. Slow interactions are split into input delay, processing and presentation. Also shows navigation timing, Long Animation Frame script attribution and a frame-rate profiler. |
| Mutations | A timeline of DOM changes with old and new values. Shows the most-changed elements and the change rate, detects writes that change nothing, can flash changes on the page, and exports to JSON. |
| Audit | Accessibility, performance and passive security checks, run only when you ask. |

**Application**

| Panel | What it does |
| --- | --- |
| Storage | View, edit, add and delete localStorage, sessionStorage and cookies that scripts can read. Also lists IndexedDB, Cache Storage, service workers and quota usage. |
| Data | Pulls links, images, tables, forms and headings from the page into CSV, JSON, Markdown or HTML. |

**Build and ship**

| Panel | What it does |
| --- | --- |
| Export | Exports a component as code, writes a developer report, and takes element, viewport or full-page screenshots (stitched, with sticky bars kept only once). Also compares snapshots pixel by pixel. |
| Site | Detects the site's technology and saves a snapshot of the files the page uses. Recovers the original sources where the site publishes source maps. Never fetches private or loopback addresses. |
| Recreate | Rebuilds an element from its computed styles, then refines the copy until its layout matches the original. |
| Playground | An HTML/CSS/JS scratchpad that runs in a sandboxed page with no access to extension APIs. |
| Automate | Records and replays step-by-step workflows, stored as JSON. |
| AI | Builds a prompt from the selected element or task. You paste it into the AI chat you already use. No API keys are needed, and nothing is sent until you click Send. |
| Workspace | Projects that collect what you save from other panels (elements, components, screenshots, data, workflows, playgrounds, AI tasks), stored in IndexedDB. |

A command palette (`Ctrl+K`), in-panel shortcuts you can rebind, and light, dark and system
themes are available in every panel.

When the side panel is too narrow for every tab, the remaining panels move into an overflow menu.
Its button shows how many panels are hidden, and the menu lists them under the same groups as
above, each with its shortcut if you have bound one in Settings. The menu works from the
keyboard: arrow keys, Home/End, or a panel's first letter to move; Enter to open; Esc to close
and return focus to the button.

## Architecture

```
background.js        Service worker. Opens the panel and passes keyboard and context-menu
                     commands to it. No other work happens here.
sidepanel.html       The workbench UI. Classic scripts that share one scope, in load order:
  lib/               Pure helpers (HAR, ZIP, token maths, redaction, validation, storage).
                     Each also exports itself through module.exports so it can be tested in Node.
  panel/core.js      Shared state, DOM helper, agent injection and messaging.
  panel/*.js         One file per panel, registered with registerTab().
  panel/boot.js      Tab bar, command palette, theming and startup. Loaded last.
agent.js, agent/*    The page agent. Injected on demand into the page's isolated world, never at
                     page load. It is versioned (AGENT_VERSION) so an outdated copy left in a tab
                     is replaced. Values it could not observe directly are tagged:
                     observed | extracted | inferred | generated | unavailable.
netcap.js            Network capture and interception. Runs in the page's MAIN world so it can
                     wrap fetch / XHR / WebSocket / EventSource / sendBeacon. Can be registered
                     at document_start for each site.
sandbox.html/.js     Runs Playground code on an opaque origin with its own strict CSP.
```

Where data is stored: settings and interception rules go in `chrome.storage.local`, a command
waiting for the panel to start goes in `chrome.storage.session`, and Workspace projects go in
IndexedDB. None of it leaves the browser.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Temporary access to the tab you open DevForge on. |
| `scripting` | Injects the inspector and network capture, only when you use them. |
| `sidePanel` | Shows the workbench. |
| `storage` | Saves preferences and interception rules on your machine. |
| `contextMenus` | Adds **Inspect with DevForge** to the right-click menu. |
| `clipboardWrite` | Copies code and prompts when you ask. |
| Site access (optional) | Requested per site, only to export assets, read cross-origin stylesheets or capture from page start. You can revoke it in the extension's details page. |

## Install from source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Pin DevForge and open it with the toolbar icon or `Ctrl+Shift+Y` (`Cmd+Shift+Y` on macOS).
   Press `Ctrl+Shift+U` to pick an element.

Chrome 116 or newer is required.

## Development

The extension has no build step: the files in the repository are exactly what Chrome loads.
Before you commit, run at least a syntax check:

```sh
for f in $(git ls-files '*.js'); do node --check "$f" || exit 1; done
```

For a Chrome Web Store upload, zip the extension files only (leave out `README.md`,
`CHANGELOG.md`, `LICENSE`, `.gitignore` and `.gitattributes`). Keep the manifest `description`
at 132 characters or fewer.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

Released under the [MIT License](LICENSE).

Bundled third-party code, both MIT-licensed by their own authors:
[Acorn](https://github.com/acornjs/acorn) 8.18.0 (`lib/acorn.js`) and
[js-beautify](https://github.com/beautifier/js-beautify) (`lib/beautifier.min.js`).
