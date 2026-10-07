# DevForge

A Chromium side-panel extension for looking inside web pages: inspect elements, read the CSS that
actually applies, export or recreate a component, audit a page, and save a copy of a site's code.

Everything runs in your browser. There is no server, no account and no API key. The only time
data leaves your machine is when you click something that says it will (for example, opening an AI
chat site with a prompt you reviewed).

## Features

| Tab        | What it does                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect    | DOM tree (open shadow roots, same-origin iframes), box model, stacking context, accessible name, selectors and XPath ranked by how stable they look |
| CSS        | Matched rules with specificity, cascade winners, variables, fonts, keyframes; live edits with undo/redo and a patch export                          |
| Export     | Component ZIP (HTML, CSS, related scripts, assets), full DOM, resource map, screenshots, before/after diff, audit report                            |
| Site       | Scans a page and downloads its HTML snapshot, CSS, JS, images, fonts, inline code and recovered source-map sources as a ZIP                         |
| Recreate   | Rebuilds a component as HTML/CSS, React, Vue, Svelte or Tailwind from computed styles and reports how closely it matches                            |
| Network    | fetch / XHR / WebSocket capture with filtering, redaction and export                                                                                |
| Audit      | Accessibility, performance, passive security checks, scripts, responsive overflow                                                                   |
| Data       | Links, images, tables, forms, headings and repeated cards to JSON / CSV / Markdown                                                                  |
| AI         | Builds a structured prompt from the selected element and checks the reply you paste back                                                            |
| Playground | HTML / CSS / JS sandbox with no network access                                                                                                      |
| Automate   | Record and replay clicks, typing and text extraction                                                                                                |
| Workspace  | Local project storage (IndexedDB)                                                                                                                   |

`Ctrl+K` opens a command palette. `Ctrl+Shift+U` picks an element.

## Install

DevForge is not on the Chrome Web Store. Load it as an unpacked extension:

1. Download or clone this repository.
2. Open `chrome://extensions` and switch on **Developer mode**.
3. Click **Load unpacked** and choose the repository folder.
4. Open any normal web page and click the DevForge icon.

Works in Chrome, Edge and Brave 114 or newer. Firefox is not supported (it has no `sidePanel` API).

## What it cannot do

The browser does not expose some things to any extension, so DevForge does not pretend to:

- Server-side code (PHP, SQL), private APIs and credentials.
- Original source for minified code, unless the site publishes source maps with embedded sources.
- Listeners added with `addEventListener`, closed shadow roots, cross-origin iframe contents.
- Real `:hover` / `:focus` forcing and console capture (both need the `debugger` permission,
  which this extension does not request).

Results that are guesses, such as detected frameworks or the scripts that seem to belong to a
component, are labelled **inferred** in the panel and in exports.

## Permissions

| Permission                    | Why                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`, `scripting`      | Run the inspector in the tab you opened the panel on, only when you use it                                                                                           |
| `sidePanel`                   | Show the panel                                                                                                                                                       |
| `storage`                     | Remember theme and shortcuts                                                                                                                                         |
| `downloads`, `clipboardWrite` | Save exports and copy code or prompts when you ask                                                                                                                   |
| optional: all sites           | Asked only if you want cross-origin assets, screenshots without clicking the icon each time, or site downloads that include other hosts. Revoke any time in Settings |

## Development

```sh
npm ci
npm run lint
npm run format:check
npm run test:unit          # pure-function tests, no browser needed
```

End-to-end tests drive a real Chromium with the extension loaded:

```sh
pip install -r tests/requirements.txt
python -m playwright install chromium
npm run test:e2e
```

`npm run pack` writes `dist/devforge-<version>.zip` with only the runtime files.

### Layout

```
agent.js        injected into the page on demand (inspection, CSS engine, audits, site scan)
netcap.js       optional network hook, injected into the page's own JavaScript world
panel/          the side panel: core.js, boot.js and one file per tab
lib/            pure helpers: ZIP writer, code generators, validators, path/redaction utilities
sandbox.*       offline preview page used by the Playground
tests/          unit tests, Playwright end-to-end tests and fixture pages
```

The panel scripts share one global scope on purpose (they are plain scripts, not modules), so
load order in `sidepanel.html` matters.

## Known limits

- The end-to-end tests grant host access directly. Clicking the toolbar icon (which grants
  `activeTab`) and Chrome's side-panel hosting are not covered by automated tests.
- The site download is tested against a purpose-built two-origin fixture, not against arbitrary
  sites. Login walls, hotlink protection and strict origin checks show up as per-file failures
  in `_devforge/report.json` inside the ZIP.
- Recreate captures one viewport width and the current state: no hover styles, media-query
  variants or JavaScript behaviour.
- Network capture runs in the page's own context, so a hostile page can alter what it records.

Use the site downloader only on sites you are allowed to copy. A snapshot contains whatever you can
see in your session, including personal data.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).
Privacy details: [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE). Bundled libraries are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
