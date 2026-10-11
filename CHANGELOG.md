# Changelog

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
- `npm run backup` / `npm run backup:verify`: a complete source ZIP with manifest and SHA-256 list.
  Secret-looking files are left out and listed.
- `docs/SECURITY-REVIEW.md`, `docs/OWNER-MODE.md`, `docs/GIT-IDENTITY-AND-SYNC.md`.

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
- `agent.js` audited line by line (docs/AGENT-AUDIT-LEDGER.md). Fixed: quadratic `url(` and selector regexes, script-free
  page save that still contained live markup, handler stripping bypass, forged events accepted by the picker and recorder,
  unlimited `fetchInPage`, workflow limits, patch/stylesheet comment break-out, `@import` and unparseable-address crashes.
- Accessibility: landmarks, accessible-name fix, contrast fixes; `npm run a11y` (axe-core) reports 0 violations.
- ESLint (flat config, security rules on), a read-only GitHub Actions workflow file (not active until you push it), and
  `docs/AI-WRITE-CONTROLS.md` on who can write to the repository.

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
