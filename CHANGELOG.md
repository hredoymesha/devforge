# Changelog

## 4.4.2

### Fixed
- A Security scan now stops with a plain message when the page agent returns nothing for the page. It
  showed a raw script error before.
- The Site ZIP records the same plain reason in `_devforge/report.json` and its README when the page agent
  returns nothing for the page. The page data and overview files are left out; every other file is still
  saved.

## 4.4.1

### Fixed
- The SARIF checker no longer stops with an error when a file has an empty or wrongly typed run, rule, result
  or location. It lists the problem instead.
- The page bundle's `_manifest.json` now gives the real size in bytes for text files. It gave the number of
  characters before, which is smaller for text with accents or non-Latin letters.
- Two unused function parameters were removed from the page agent. Nothing changes for users.
- The unit test for odd header names now builds a real `__proto__` key. Its old form only changed the object's
  prototype, so it did not test what its name said.

## 4.4.0

### New
- **Component code.** Export → Selected part → Component code writes a React component, a Vue single-file
  component, a Web Component or a small React project that runs with Vite. The code is built from the
  part's computed styles, not from its original source. Each ZIP has a README that says where it came from.
- **Three widths.** *capture 3 widths* in Export takes a picture of the part at 360, 768 and 1280 pixels by
  resizing this browser window, then puts the window back. `data/media-rules.json` lists the media
  queries of the part and which of them apply at each width.
- **Compare two exports.** Export pairs two ZIPs from Export or Site and lists the files added, removed and
  changed. HTML, CSS and JSON are compared by content. The report saves as Markdown or JSON.
- **Bundle analysis.** The Site tab splits each script that has a source map between its original files and
  lists packages that appear in more than one folder. It says so when no map embeds source text.
- **OpenAPI and types.** The Network tab writes guessed OpenAPI 3.0.3 and TypeScript types from the captured
  JSON. Values are never written out.
- **Storage.** The Storage tab browses, edits, deletes and exports IndexedDB records, browses and exports
  Cache Storage as a ZIP, and unregisters service workers. Every delete asks first.
- **SARIF and ASVS.** Security findings export as SARIF 2.1.0 (no details, no query strings). The coverage
  view groups the findings by OWASP ASVS 4.0.3 chapter, at chapter level.
- **Encrypted export.** The full ZIP can be sealed with a passphrase (PBKDF2-SHA256, AES-GCM).
  `tools/decrypt.html` in the source folder opens it offline.
- **Sites DevForge worked on.** Settings lists the web sites DevForge ran on, with a Clear button. The list
  is kept in session storage: it is not saved to disk and is cleared when the browser closes. In limited
  site access, the Home card offers *Allow this site*.
- **Resources that load later.** Start watching, then export: scripts, styles and images that arrive after
  the first render are saved in `loaded-later/`, and the Site ZIP includes them too. API and XHR calls are
  listed but not sent again.

### Changed
- The page agent is version 15. Pages with an older copy get the new one on their next use.
- Guide cards for Export, Site, Network, Storage, Security and Settings describe the new features.

### Permissions
- No new permission. `<all_urls>` is unchanged, and the debugger permission and `devtools_page` are not used.

### Known limits
- Component code is generated from computed styles. Event handlers, page scripts and state are not copied.
- Window widths need a normal browser window. A maximised or full-screen window is skipped.
- Bundle sizes are estimates from the source map. Indexed source maps are not analysed.
- OpenAPI and TypeScript output are guesses from captured samples. The `.d.ts` file is not compiled here.
- SARIF and ASVS are chapter-level. Requirement numbers are not given.
- The Owner-key option for encrypted exports is not available. The decrypt page works with the passphrase only.
- Resources that load before watching starts are listed only if the browser still has their timing.
## 4.3.0

### New
- **Guide** panel (Start group, after Home): a plain-English manual. It covers the first five minutes,
  one card for every panel, common problems, privacy, shortcuts and a glossary. A unit test fails when a
  panel has no card, when sentences get long, when a technical term has no glossary entry, or when a
  button name in the text no longer exists in the panel code.

### New (continued)
- **Security tab: Hardening helpers.** *Build a CSP suggestion* writes a `Content-Security-Policy-Report-Only`
  header from what the open page loaded (scripts, styles, images, fonts, fetch and XHR targets, frames,
  form targets), with a SHA-256 hash for each inline script and style and a note for inline event handlers and
  style attributes. *Compute integrity hashes* downloads each third-party script and stylesheet twice, with
  the usual size and time limits and the private-address guard, and offers corrected tags with a SHA-384
  `integrity` and `crossorigin="anonymous"`. It recognises a correct `integrity` attribute, flags a stale one, and
  gives no tag for a file that changes between requests. Both outputs are labelled generated and inferred.
  Inline code is only hashed, never returned. New `lib/csp.js`, `secCspFacts` in `agent/security.js`,
  `panel/securityhelp.js`.

- **Security tab: Check again.** A finding about an exposed path or the page's response headers has a
  **Check again** button. It re-runs only that check, through the same gate as a scan (same site, GET or
  HEAD, no cookies, three requests at most, a pause between them, the ownership confirmation on a public
  site) and answers *Fixed*, *Still present* or *Could not check* with the reason. The saved report is
  not changed. Other findings can only be checked by a new scan. New `lib/recheck.js`.

- **`npm run package`** builds `DevForge-<version>-extension.zip` and `-source.zip` with `.sha256` files, repeatable
  byte for byte. `npm run check` now fails when the manifest, `package.json`, `package-lock.json` and the newest
  changelog heading show different versions.
- **PRIVACY.md** lists what DevForge stores and where, what it sends and when, and the reason for each permission.
  A unit test compares it with the manifest and the code.

- **Capture self-check.** When capture starts on demand, DevForge checks 22 built-ins (`fetch`, `XMLHttpRequest`,
  `JSON`, `Function.prototype` and similar) through a clean frame. If the page replaced any of them first, the
  Network tab shows a warning that names them and recommends "From page start". Frameworks that patch these
  functions trigger it too. New `lib/tamper.js`.
- **Style check** (`scripts/style-check.js`, part of `npm run check`) flags filler wording in the docs, interface
  strings and comments, and Guide sentences averaging over 18 words. Exceptions go in
  `scripts/style-allow.json` with a reason. One phrase was rewritten.

### Changed
- **Saved data is checked before it is used.** Settings, interception rules, performance history and
  Workspace records are validated when they are read (`lib/stored.js`). A value that is missing, the wrong
  type, out of range or too large is replaced by its default, or the record is left out, and Settings has
  a new **Stored data** section that lists what was ignored. Before, a damaged `settings` value was merged
  into the live settings as it was. Settings now carry `schemaVersion` (2); settings written by 4.2.0
  have none and are read as version 1 and migrated. A record over 25 MB or without an id or project is
  left out of the Workspace lists. Nothing is deleted from storage by the check itself.

- **ZIP files are compressed.** Exports, the page bundle, the Site download, recreations and Playground
  ZIPs now deflate their files (`CompressionStream('deflate-raw')`, `DFZip.buildAsync`). Images, fonts, archives,
  audio and video are stored as they are, and so is any file that does not get smaller. Where the browser has
  no `CompressionStream` the files are stored, as before. File names, CRCs and sizes follow the same rules in
  both cases.

### Fixed
- **A hostile stylesheet could freeze the panel.** `rewriteCss` and `discoverCssUrls` (Site download) used
  regular expressions that backtracked badly: 8 KB of `url(` followed by spaces ran for over eight seconds,
  and 20,000 unclosed `url(` for over three. They now read each `url(...)` token in one bounded pass
  (`cssUrlTokens` in `lib/site.js`). `URL(...)` in capital letters is now rewritten too.
- ZIP entry names and Site file names could carry a NUL, which some extractors read as the end of the name
  (`a/..<NUL>b` was read as `a/..`), a colon (a drive-relative path such as `c:x`, or an NTFS data stream),
  trailing dots or spaces that Windows drops (`.. ` acts as `..`), or a direction-override character that
  makes `photo<RLO>gpj.exe` look like `photoexe.jpg`. All are removed or replaced before a name is written.
- A `<style>` inside `<math>` lost its child elements in the rewritten `index.html` of a Site download.
- **A page could break the page agent, or freeze its own tab, by naming form controls after DOM
  properties.** `<input name="getAttribute">` made reads throw (the accessibility and security audits,
  `fullDom`, form data, Security facts), and `<input name="parentElement">` sent the Performance audit
  into an endless loop. The agent now reads elements through the prototypes (`dom` in `agent.js`),
  ESLint enforces it, and `AGENT_VERSION` is 13.
- An inline script with the id `__df_bridge` was left out of the scripts list, the Site and Export
  downloads and the Security scan, so a page could hide code from them by using that id.
- Pick mode stayed on after the panel was closed, and kept swallowing the page's mouse events until Esc.
  The page agent now ends it when the panel goes away.
- The browser tests failed on GitHub with Chrome 158 although they passed on older Chrome: newer Chrome
  reports every inline event handler attribute it sees while parsing a page, even in a copy that never runs
  it. The Site rewrite and the exports parse page markup on purpose, so those two test sessions now set
  these reports apart (`e2e/violations.js`, with its own unit test). Every other refusal still fails the
  test, and the panel itself is unchanged.
- The Owner passphrase-change test no longer fails when the message box is briefly missing.
- Test failures now say where each CSP refusal came from (source, line, column).
- Development only: `minimatch` is pinned to 11.0.5 with an npm override. ESLint pulled in 10.2.6, which has
  a published advisory (denial of service from crafted patterns). DevForge never passes untrusted patterns to
  it, and nothing of it ships in the extension.

### Tests
- New property and fuzz tests with seeded hostile input and time budgets (`test/fuzz.test.js`,
  `e2e/fuzzgen.js`): the private-address check against a CIDR table for every spelling the URL parser
  accepts (IPv4 and IPv6, including mapped, NAT64 and 6to4 forms), CSS rewriting, ZIP and Site paths,
  secret detectors and probe signatures. In the browser, hostile pages go through `fullDom`
  (`neutralizeTree`, `escapeRawText`) and the Site HTML rewrite. A failing run prints its seed; replay it
  with `FUZZ_SEED=<n> FUZZ_ROUNDS=<n>`.

### Security
- **Supply chain.** Every action in the CI workflow is pinned to a full commit SHA (a test fails on a
  tag or branch reference), and the workflow is still read-only. `npm run check` now verifies the
  SHA-256 of the two vendored files, `lib/acorn.js` and `lib/beautifier.min.js`. Both match the
  published npm packages byte for byte (Acorn 8.18.0; js-beautify 1.15.3 and 1.15.4 ship the same
  file). The README records the versions and how to update them.
- **Secrets check before an export.** ZIPs (selected part, page bundle, Site, Workspace project), single
  exported files and AI prompts are scanned for credential-like values (AWS, Stripe, GitHub, Slack,
  SendGrid, Google API keys, private keys, JWTs, hard-coded password/token/secret assignments, in script
  or JSON form). If something matches, a dialog lists the kind, file and line, never the value, and asks:
  mask the values with `[REDACTED:type]`, keep the files with a warning note, leave those files out, or
  cancel. The ZIP gets `_devforge-secrets.md` with the same list. The matching is on shape, so it can
  miss real secrets and flag harmless ones. New `lib/exportguard.js`, `scanSecretSpans` in
  `lib/secprobe.js`, `panel/exportguard.js`.
- Extension pages now enforce Trusted Types (`require-trusted-types-for 'script'`). A plain string at an
  HTML or script-URL sink is refused by the browser. Two named policies exist and the manifest allows no
  other: `devforge-html` (Recreate preview, Site HTML rewrite) and `devforge-url` (only a relative path to
  a saved file). A unit test fails when a file writes to a sink, and the browser suites record every
  violation.

## 4.2.0

### New
- **Export → Selected part** now gives everything that can be read for the part you picked, not only
  HTML and CSS: outer, inner and standalone HTML, each inline SVG, the CSS rules that apply (with media
  queries, animations, fonts and the custom properties they read), the resolved values of the outer
  element, inline event handlers, inline-script code and pieces of the page's script files that refer to
  the part (found by parsing the script, not by searching text), the element tree, forms, links, images,
  visible text, JSON-LD, downloaded assets and a README that describes the part in plain words.
  Separate buttons download Outer HTML, Inner HTML, CSS, JavaScript, Documentation or Metadata.
- The part export also writes: `in-context.html` (the part inside its ancestors), declarative shadow DOM
  HTML and the styles inside open shadow roots, matched rules and inherited styles (which ancestor sets
  each inherited property), generated `::before`/`::after` content, selectors with XPath and a JS path,
  accessibility facts, framework attributes, a preview picture, and formatted code (switchable).
  Asset collection now covers every `srcset` candidate, `<picture>` sources, video posters and sources,
  tracks, lazy-load attributes, CSS mask/border/list/generated-content images and open shadow roots;
  frames and linked documents are listed but not downloaded.
- Selecting the whole page exports the page instead: rendered HTML, scripts, styles, source maps,
  manifest and service worker scripts, with a README and a list of anything that could not be read.
- **Site → Download all site code** adds the web app manifest and service worker scripts, page data
  (title, meta tags, headings, forms, links, structured data), a README with real counts and the files
  that failed, and an overview of the page.
- `docs/EXPORTS.md` describes every export. New browser suite `npm run e2e:exports`.

### Fixed
- Colour contrast: a ratio that only rounded up to the AA limit (4.496:1 shown as 4.50) was reported as
  passing. Grading now uses the exact ratio in the Tokens tab, the scan and the audit.
- Scan trend: the same check firing on two addresses was counted as one finding. The address is now part
  of a finding's identity.
- ZIP files: entry names can no longer escape the extraction folder, repeated names get a suffix
  instead of producing two entries, and a count the format cannot hold is refused. First unit tests for
  the ZIP writer.
- `npm run e2e` no longer needs a Git history to run; it checks the fixed behaviours directly.
- `npm run check` and the version in `package-lock.json` agree with the manifest.

### Changed
- Documentation rewritten and shortened. The security notes are in `docs/SECURITY-MODEL.md`.
- Project files that only recorded how earlier releases were produced were removed.

## 4.1.1

### New
- **Security tab**
  - A banner at the top of every results view (Overview, Findings, Paths, Plan, Coverage, Export) with the
    scanned site, scan level, checks skipped (and partial or failed), requests used and save state. It stays
    in view while you switch tabs.
  - **Scan trend**: a finished scan is compared with the last saved scan of the same site ("2 new findings
    since the last scan. Net: 3 fewer findings than last time"), with what is new, resolved, more or less
    severe. A first scan shows nothing and no error. If the earlier scan used another level, it says so.
  - **Select findings**: a checkbox on every finding, "select all shown", and a toolbar that appears on
    selection with **Acknowledge** (optional note), **Remove acknowledgement**, **Export selected** (.md and
    .json) and **Copy**. A review-state filter (all / not acknowledged / acknowledged).
  - Scans are saved to the Workspace automatically (Settings → Scan history), newest N per site; reports you
    save yourself are never removed.
- **Network**: save the current capture (redacted) and **compare two captures** (or one against the live
  capture): added, removed and changed requests, with status, size, timing, header and body differences, noisy
  headers ignored, Markdown/JSON output. **Copy cURL** on every request, plus Python (requests) and Node snippets.
- **Perf**: a history chart per page (LCP, FCP, TTFB, INP, CLS) with good/poor limits, change since the
  previous check, best/worst/median and a table of recent readings.
- **Tokens**: a colour readability checker (WCAG 2.x ratio, AA/AAA for normal and large text, UI 3:1, APCA
  for information, nearest passing colour, colour-vision simulation), a scan of every text colour pair on the
  page with fixes, and a palette contrast matrix.
- **Export → Page bundle**: pick any mix of rendered HTML, scripts, stylesheets, source maps, WebAssembly,
  manifest, service worker scripts, network payloads and HAR, cookies, localStorage, sessionStorage,
  IndexedDB overview, selected-element HTML/CSS, resolved rules, computed styles and box model, and saved
  Workspace items. Download one ZIP or separate files. A manifest lists what could not be read and why.
- **Prototype tab**: try front-end changes on the live page without editing it. A visual dashboard with
  controls that fit the element's layout (flex, grid, text) and the site's theme variables, and a code editor
  for CSS (and JavaScript, off until you allow it). Variants, show-original toggle, Reset, export as CSS,
  console snippet or userscript. The override is held in the tab's memory and added without any element in
  the page's DOM.
- **Recreate**: an advanced token-aware build (shared colours and fonts as custom properties, identical rules
  merged, optional rem) that is measured against the original.
- **Owner**: **step-up re-verification** (the passphrase is asked again for sensitive actions after 5
  minutes), a manual re-verify, **change passphrase** (re-seals everything), and a notice when the session
  locks itself.
- **Home**: status cards for site access, Owner session, the current site's security trend, the page's
  performance and stored data, and shortcuts to the new tools.
- **Settings**: Allow DevForge on all sites (on by default) with an allow list when off; network capture
  size limits; scan history; temporary data and clean-up with a storage report; a self-test that shows what a
  web page can see of DevForge.

### Changed
- All-sites access is a required host permission, so DevForge works anywhere without a per-site prompt.
  `debugger` is still not requested. `scripts/check.js` enforces that.
- Network capture hides its state from pages: nothing is added as a property of the page's XHR, WebSocket or
  navigator objects, wrapped functions keep their native look, and the marker carries no product name.
  Limits (entries, body size, total memory) are configurable.
- Per-site performance history and acknowledgements are stored under salted-hash keys, not site addresses.

### Fixed
- The first acknowledgement in a session was not shown until the tab was reopened.
- Applying a prototype while "Show original" was on did not show it.
- A pending auto-apply could switch the prototype back on right after "Show original".
- "Save capture" refused when the panel had not polled the page since the last request.

## 4.1.0

### New
- **Security tab, rebuilt as a layered assessment** for sites you own, have permission to test, or
  run locally. Three levels: Passive (page + headers, 3 requests), Standard (low-impact checks,
  60 requests) and Advanced (longer path list, 150 requests, extra confirmation on public sites).
  Findings carry severity, confidence and a status (Confirmed / Potential / Needs manual
  verification / Informational), with evidence, impact, safe verification steps and fixes.
  Checks: headers and CSP, HSTS, mixed content, cookies, forms, third-party code, exposed files
  (`.git`, `.env`, backups, dumps, logs, directory listings, debug and admin tools), credential-like
  values in scripts (masked), source maps, vulnerable library versions, polyfill.io, error output,
  reflected parameters, open-redirect and IDOR indicators, CORS, `security.txt`, `robots.txt`.
  Adds potential attack paths, a prioritised remediation plan, scan coverage (done / skipped /
  failed / not testable), filters, search, sorting, grouping, related-finding links, Markdown and JSON
  reports, Workspace save and reopen, and an editable disclosure message.
- **Scoped request gate**: every scan request is same-origin, GET/HEAD, cookie-free, budgeted,
  paced, cancellable, and logged in the report. Redirects are not followed.
- **Optional `cookies` permission**, requested only from the Security tab, for exact HttpOnly,
  Secure and SameSite checks. Values are never read.
- **Home tab** with page-access status, quick actions, first-run guidance and recent items.
- **Icons on every tab** and a compact tab bar below ~640 px (only the selected tab shows its name),
  icons in the overflow menu, a refreshed brand mark, and new Home/Security styling.
- **Network**: `header:name[=value]`, `is:insecure`, `is:sensitive` and `is:open-cors` filters, a
  "security" tag on flagged rows, a Security shortcut, and captured requests feed the Security tab.
- `package.json` with `npm run check`, `npm test`, `npm run verify` and `npm run e2e`; 67 unit tests
  and a Chromium end-to-end suite (`e2e/`) with local training sites. No dependencies.

- **Owner mode** (Owner tab): a local passphrase seals a scan's detailed technical diagnostics;
  the ordinary report never contains them. Redacted export by default, lockout on repeated wrong
  passphrases, reset that destroys data. It changes no scan limit or authorisation rule.
- `docs/OWNER-MODE.md` and a security review document.

### Security (second pass)
- **Capture secret could be read by hostile pages** that replace built-ins such as `String.prototype.charCodeAt`
  (reproduced); the entry point now uses references bound at load. New browser test.
- **Redirects are stopped at the network layer** when following is enabled: a `declarativeNetRequest` session rule
  (new permission, block-only, scoped to this extension's own requests) blocks every hop to a private, loopback,
  link-local or internal destination before the request is sent. Measured in Chromium with a control.
- Private-host check now parses addresses (IPv4, IPv6 with embedded IPv4, NAT64, 6to4, special-use ranges, trailing dots);
  well-known local admin ports are refused even on the page's own host.
- Downloads and in-page file fetches revalidate (`no-cache`) instead of trusting any cached copy.
- The old "target=_blank without noopener" finding is gone (browsers isolate it); `rel=opener` and named targets are reported.
- **Workspace encryption (optional, Owner mode)** with verified in-place migration, reversible, tamper-evident listing fields.
- **Owner mode:** authorised-site list, idle-lock choice, header lock indicator, revoke approvals, typed confirmation before a
  reset that would orphan encrypted data.
- `agent.js` reviewed line by line. Fixed: quadratic `url(` and selector regexes, script-free
  page save that still contained live markup, handler stripping bypass, forged events accepted by the picker and recorder,
  unlimited `fetchInPage`, workflow limits, patch/stylesheet comment break-out, `@import` and unparseable-address crashes.
- Accessibility: landmarks, accessible-name fix, contrast fixes; `npm run a11y` (axe-core) reports 0 violations.
- ESLint (flat config, security rules on) and a read-only GitHub Actions workflow.

### Security
- The Network capture log is no longer readable from the page (`window.__dfNet` is gone): it is
  closure-private behind a secret handshake with the new `netbridge.js`.
- Page-derived downloads no longer follow redirects by default (Settings → Saving files). When the option is on, a new `declarativeNetRequest` session rule (new permission, block-only) stops any redirect hop to a private, loopback or link-local address before the request is sent; redirects are refused if the rule cannot be installed. Verified in Chromium with a measured control. Unrecognised: public names that resolve to private addresses (DNS rebinding).
- The private-address guard failed open when the page address was unknown; it now fails closed.
- Two detector regexes could stall on hostile pages (ReDoS); bounded and tested.
- Messages to the panel and saved reports are validated before use.
- `localhost.` (with a trailing dot) is now treated as a private address.
- The agent no longer offers the unused "replace HTML" edit, and the Playground sandbox only runs code sent by its own panel.
- Dark-theme primary buttons now meet text contrast (6.4:1, was 3.0:1); light-theme accent, OK and warning colours were darkened slightly.

### Fixed
- Network redaction matched sensitive words anywhere in a key, hiding harmless fields such as
  `author`, `design` or `shipping`. Keys are now matched by word; `authToken`, `client_secret` and
  `X-Api-Key` are still redacted.
- Downloads of page-derived URLs could follow a redirect from a public address into a private or
  loopback one. The final address is now checked again and the body is never read.
- "Fetch blocked stylesheets" lacked the private-address guard used by Export and Site.
- An XHR aborted while a latency rule was holding it was still sent (or threw) when the rule
  expired.
- Pasted Automate workflows could contain a `navigate` step with any URL scheme. Only http and
  https are accepted now (the extension's CSP already stopped `javascript:` from running, so this is
  hardening).
- The old header check reported every protection as missing on servers that reject HEAD (405). The
  Security tab retries with GET; the old Audit security button now opens the Security tab, and the
  unused `fetchHeaders` agent call was removed.
- The manifest description now mentions security checks.

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
