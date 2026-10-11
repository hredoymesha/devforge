# DevForge 4.1.0

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

**Start**

| Panel | What it does |
| --- | --- |
| Home | Shows whether DevForge can work on the current page, one-click entry points for the common jobs (inspect, security check, network capture, performance, tokens, export, snapshot) and your recent Workspace items. New installs open here. |

**Inspect and style**

| Panel | What it does |
| --- | --- |
| Inspect | Element picker, DOM tree, selectors, box model and accessibility info. Includes a component inspector for React, Vue 2/3, Svelte and Angular (dev mode), quick edits with undo/redo, and a layout X-ray. |
| CSS | Matched rules, computed styles and live edits that are checked before they are applied. Emulates `:hover`/`:focus` without the debugger permission. |
| Tokens | Pulls colours, type scale, spacing, radii and shadows from computed styles. Exports CSS variables, SCSS, W3C design-token JSON or a Tailwind theme. |

**Network**

| Panel | What it does |
| --- | --- |
| Network | Live capture of `fetch`, XHR, WebSocket, EventSource and `sendBeacon`. Filters work like DevTools (`status:4xx`, `method:post`, `domain:`, `larger-than:`, `is:mocked`, `-exclude`) plus `header:server[=value]` and security signals: `is:insecure` (http/ws from an HTTPS page), `is:sensitive` (token-like value or credentials in the address) and `is:open-cors`. Flagged rows carry a "security" tag, and the Security tab includes captured requests in its assessment. Also: sortable columns, a waterfall, timing phases (DNS / TCP / TLS / TTFB / download), Server-Timing, GraphQL operation names, edit and replay, copy as cURL / fetch / PowerShell, and HAR 1.2 export. |
| Interception rules | Add latency, set request headers, block, mock a response or redirect. Rules are checked in order for each request and are saved between sessions. You can turn on capture from page start for each site. |

**Performance**

| Panel | What it does |
| --- | --- |
| Perf | LCP, CLS, INP, FCP and TTFB, each linked to the element that caused it. Slow interactions are split into input delay, processing and presentation. Also shows navigation timing, Long Animation Frame script attribution and a frame-rate profiler. |
| Mutations | A timeline of DOM changes with old and new values. Shows the most-changed elements and the change rate, detects writes that change nothing, can flash changes on the page, and exports to JSON. |
| Audit | Accessibility, performance, script and responsive checks, run only when you ask. Its old security button now opens the Security tab. |
| Security | A layered website security assessment for sites you own, have permission to test, or run locally: passive reading, low-impact checks, and an opt-in advanced level. Findings have a severity, a confidence level and a status (Confirmed, Potential, Needs manual verification), with evidence, impact, safe verification steps and fixes. Includes potential attack paths, a remediation plan, scan coverage and Markdown/JSON reports. See [Security checker](#security-checker). |

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
themes are available in every panel. Every tab has an icon. Below about 640 px only the selected
tab shows its name, so more panels fit before the rest move into the overflow menu.

When the side panel is too narrow for every tab, the remaining panels move into an overflow menu.
Its button shows how many panels are hidden, and the menu lists them under the same groups as
above, each with its shortcut if you have bound one in Settings. The menu works from the
keyboard: arrow keys, Home/End, or a panel's first letter to move; Enter to open; Esc to close
and return focus to the button.

## Security checker

The Security tab is for defensive review of sites you own, sites you have permission to test, and
local or training environments. It reports what it could observe, how sure it is, and what it could
not check. It does not attack anything.

**Scan levels**

| Level | What it does | Request budget |
| --- | --- | --- |
| Passive | Reads the open page (forms, scripts, frames, links, cookies and storage key *names*, mixed content) and its response headers, plus `security.txt`. Includes requests captured in the Network tab. | 3 |
| Standard | Adds low-impact checks: how the site answers a path that cannot exist, `robots.txt`, a short list of well-known sensitive files and admin paths, the page's own scripts (scanned for credential-like values, library versions and source maps). | 60, 250 ms apart |
| Advanced | A longer path list (backups, configuration and debug files, directory listings) and more scripts. Needs a second, explicit confirmation on public sites. | 150, 150 ms apart |

Local and private addresses (`localhost`, `192.168.x.x`, `*.test`, ...) can be scanned directly.
Any other site needs a confirmation that you own it or have permission; the confirmation lasts for
the browser session. You can lower the request limit and raise the pause, but never exceed 200
requests or go below 100 ms.

**What is enforced in code** (`agent/security.js`, not just in the interface)

- Every request goes through one gate: same origin as the page only, `GET`/`HEAD` only, no cookies,
  no custom headers, no request bodies, no credentials in addresses.
- Probe paths are plain absolute paths (no query, no `..`, no `//`). Redirects are not followed, so
  a redirect off the site is reported and never contacted.
- A request budget, a minimum pause, a timeout, a cap on bytes read, and cancellation.
- The scan stops if you switch tabs or navigate, and every request is listed in the report with
  its purpose.

**What it checks**

- Transport and headers: HTTPS, mixed content, CSP quality, HSTS, framing, nosniff, referrer and
  permissions policy, CORS, version disclosure, cache headers on sign-in pages.
- Cookies: names and flags. Without the optional `cookies` permission only script-readable cookies
  are visible, so HttpOnly cannot be judged; with it, HttpOnly, Secure, SameSite, lifetime and
  Domain scope are exact. Values are never read.
- Client-side exposure: credential-like values in scripts (AWS, Stripe, GitHub, Slack, SendGrid,
  private keys, JWTs with their claims checked, generic assignments), exposed source maps, token-like
  web-storage keys, HTML comments, generator banners, error output and debug pages.
- Code patterns that may indicate XSS: risky DOM functions, URL parameters echoed in scripts or
  attributes, inline handlers, `javascript:` URLs, third-party scripts without Subresource Integrity,
  unsandboxed frames, scripts from `polyfill.io`, and library versions with known advisories
  (offline list, versions read from file names).
- Exposure: `.git`, `.env` and variants, `.svn`, `.htaccess`, backups and database dumps, log and
  configuration files, directory listings, phpinfo, Spring Actuator, Werkzeug and Laravel debug
  tools, API documentation, admin interfaces. A hit needs a content signature, not just HTTP 200, so
  single-page apps that answer every path with 200 are not flagged.
- Indicators that need a person: open-redirect style parameters, sequential IDs (possible IDOR),
  POST forms without a CSRF token field, upload forms, CORS behaviour that cannot be tested from an
  extension. These are labelled **Needs manual verification** with safe steps.

**Evidence and honesty**

- *Severity* (how bad if real) and *confidence* (how sure the evidence is) are separate. Status is
  **Confirmed** (the condition itself was observed; this does not mean it is exploitable),
  **Potential**, **Needs manual verification** or **Informational**.
- Secret values are never kept: findings show a type, a masked prefix and a length. Cookie, storage
  and URL-parameter values are not read into reports. Every string in a report also passes a last
  scrubbing step for credential-shaped values.
- Credential-like values are never tried against any service.
- Potential **attack paths** combine findings (for example no CSP + risky DOM code + a script-readable
  session cookie). Each lists the steps, the conditions that must still be verified, and how to break
  the path, and is always labelled potential.
- A remediation plan groups fixes by priority and effort, with copy-paste examples.
- The coverage tab lists every check as done, partial, skipped or failed (with the reason) and what
  a browser extension cannot test: TLS configuration, injection and XSS execution, access control,
  authentication strength, CORS reflection, rate limiting, other subdomains and DNS. There is no
  overall score, on purpose.
- Reports export as Markdown or JSON, save to Workspace (and reopen from there), and a disclosure
  message template can be edited before you send it.

**Limits that come from the browser**: `Set-Cookie` headers and HttpOnly cookies are hidden from
extensions, TLS details are not available, and server-side flaws need controlled testing that
DevForge does not do. Library versions come from file names and can be wrong.

### Owner mode

An optional **Owner** tab (under Security) lets you protect the detailed technical record of a scan
with a passphrase you choose: scan configuration, timings, response header values, probe results,
the request log and extension state are encrypted (AES-GCM, PBKDF2-SHA256) in this browser and can be
opened or exported (redacted by default) only after unlocking. Unlocked, it can also encrypt your Workspace items,
remember sites you have authorised (so the per-site ownership tick is pre-filled until it locks), and lets you pick the
idle-lock time. It never raises a scan limit, never widens a scan beyond the tab's site, never skips the Advanced
confirmation, and does not prove your identity to anyone. Read
[docs/OWNER-MODE.md](docs/OWNER-MODE.md) for the trust boundary before relying on it.

## Architecture

```
background.js        Service worker. Opens the panel and passes keyboard and context-menu
                     commands to it. No other work happens here.
sidepanel.html       The workbench UI. Classic scripts that share one scope, in load order:
  lib/               Pure helpers (HAR, ZIP, token maths, redaction, validation, storage, guarded
                     fetching in net.js, and the security checker: secprobe.js detectors and
                     probe catalog, secscan.js analyzers, secreport.js attack paths, plan,
                     coverage and exports).
                     Each also exports itself through module.exports so it can be tested in Node.
  panel/core.js      Shared state, DOM helper, agent injection and messaging.
  panel/icons.js     Icon set used by the tab bar, Home and Security.
  panel/owner.js     Owner mode: passphrase session, sealed technical diagnostics (see
                     docs/OWNER-MODE.md; lib/owner.js holds the crypto).
  panel/*.js         One file per panel, registered with registerTab(). The Security tab is
                     split into securityrun.js (scan runner) and security.js (interface).
  panel/boot.js      Tab bar, command palette, theming and startup. Loaded last.
agent.js, agent/*    The page agent (agent/security.js reads the page for the Security panel and
                     owns the scoped request gate). Injected on demand into the page's isolated
                     world, never at page load. It is versioned (AGENT_VERSION) so an outdated copy left in a tab
                     is replaced. Values it could not observe directly are tagged:
                     observed | extracted | inferred | generated | unavailable.
netbridge.js         Isolated-world half of the capture handshake (holds the entry secret).
netcap.js            Network capture and interception. Runs in the page's MAIN world so it can
                     wrap fetch / XHR / WebSocket / EventSource / sendBeacon. Can be registered
                     at document_start for each site.
sandbox.html/.js     Runs Playground code on an opaque origin with its own strict CSP.
```

Where data is stored: settings and interception rules go in `chrome.storage.local`, a command
waiting for the panel to start and the Security tab's per-site confirmations go in
`chrome.storage.session` (cleared when the browser closes), and Workspace projects, including saved
security reports, go in IndexedDB. None of it leaves the browser. Workspace data is not encrypted,
so treat saved security reports (which describe a site's weaknesses) like any other sensitive file.

Network capture isolation: the capture log lives in a closure inside the page's own JavaScript
world (the only place `fetch` and XHR can be wrapped), but it is not exposed as a global. A random,
non-enumerable entry function guarded by a 256-bit secret is handed to the isolated-world
`netbridge.js` and then to the panel at page start, so page scripts cannot read the log or change
its rules. Code that runs in the page before DevForge can still tamper with built-ins; see
[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Temporary access to the tab you open DevForge on. |
| `scripting` | Injects the inspector and network capture, only when you use them. |
| `sidePanel` | Shows the workbench. |
| `declarativeNetRequest` | Installs a session rule that blocks DevForge's own downloads from reaching private, loopback or link-local addresses, including at any step of a redirect chain. It only blocks; it cannot read or change pages, and its rules apply to requests started by this extension, not to the sites you visit. No install warning is shown for it. |
| `storage` | Saves preferences and interception rules on your machine. |
| `contextMenus` | Adds **Inspect with DevForge** to the right-click menu. |
| `clipboardWrite` | Copies code and prompts when you ask. |
| Site access (optional) | Requested per site, only to export assets, read cross-origin stylesheets or capture from page start. You can revoke it in the extension's details page. |
| `cookies` (optional) | Requested only from the Security tab's "Allow cookie flag checks" button, for one site. Lets DevForge read whether cookies are HttpOnly, Secure and SameSite. Cookie values are never read into reports. Revocable in the Security tab or the extension's details page. |

## Install from source

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Pin DevForge and open it with the toolbar icon or `Ctrl+Shift+Y` (`Cmd+Shift+Y` on macOS).
   Press `Ctrl+Shift+U` to pick an element.

Chrome 116 or newer is required.

## Development

The extension has no build step: the files in the repository are exactly what Chrome loads.
Before you commit, run the checks:

```sh
npm run verify     # syntax, manifest and file-reference checks, then the unit tests (no install needed)
npm run verify:all # ESLint first (needs `npm ci`; Node 20.19+ or 22.13+), then verify
npm run e2e        # optional: drives the real extension in Chromium against local training sites
npm run a11y       # optional: axe-core over every panel, both themes, 1280 px and 360 px
```

`npm run check` and `npm test` run the two halves of `verify` separately. The extension has no runtime dependencies
and `verify` needs no install: it uses only Node (18 or newer) and its built-in test runner. The pinned dev dependencies
(`eslint`, `@eslint/js`, `globals`, `axe-core`) are only for `lint` and `a11y`. Unit tests
live in `test/` and cover the pure modules in `lib/`.

`.github/workflows/ci.yml` runs lint, verify, the backup tool and the Chromium suites on pull requests, with read-only
permissions (`test/ci.test.js` keeps it that way). It has no effect until you commit and push it. See
[docs/BROWSER-SUPPORT.md](docs/BROWSER-SUPPORT.md) (only Chromium is verified), [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md),
[docs/AGENT-AUDIT-LEDGER.md](docs/AGENT-AUDIT-LEDGER.md) and [docs/AI-WRITE-CONTROLS.md](docs/AI-WRITE-CONTROLS.md).

Backups of the working tree (not a commit, nothing is pushed):

```sh
npm run backup          # backups/DevForge-v<version>-Complete-Source-Backup.zip + .sha256
npm run backup:verify -- backups/<file>.zip   # checks CRCs, manifest SHA-256s, required files
```

The archive contains every tracked and untracked non-ignored file, `BACKUP-README.md`,
`BACKUP-MANIFEST.json`, `SHA256SUMS.txt` and `GIT-STATE.txt`. Secret-looking files (`.env`, keys)
are left out and listed with a reason. `backups/` is git-ignored.

`npm run e2e` needs Playwright and a Chromium build (set `PLAYWRIGHT_MODULE` and `CHROME_PATH` if
they are not found; it is not an extension dependency). It starts three local servers
(`e2e/fixtures.js`: an intentionally weak site, a clean single-page app that answers every path with
200, and a "private" target that redirects must never reach), loads a scratch copy of the extension
with host access added, and checks scan scope on the wire (methods, cookies, request counts,
spacing), findings, redaction, the authorisation flow, the report interface, the compact tab bar,
accessibility basics, and before/after behaviour of fixed bugs against the original 4.0.0 commit.
`node e2e/run.js --shots <dir>` also saves screenshots.

For a Chrome Web Store upload, zip the extension files only (leave out `README.md`,
`CHANGELOG.md`, `CLAUDE.md`, `LICENSE`, `.gitignore`, `.gitattributes`, `package.json`, `docs/`,
`scripts/`, `test/` and `e2e/`). Keep the manifest `description`
at 132 characters or fewer.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

Released under the [MIT License](LICENSE).

Bundled third-party code, both MIT-licensed by their own authors:
[Acorn](https://github.com/acornjs/acorn) 8.18.0 (`lib/acorn.js`) and
[js-beautify](https://github.com/beautifier/js-beautify) (`lib/beautifier.min.js`).
