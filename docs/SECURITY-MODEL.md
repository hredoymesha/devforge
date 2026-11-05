# Security model

How DevForge protects itself, the data it handles and the sites it works on, and where the
protection stops. Each section says what is enforced in code and which test covers it. Where a
limit comes from the browser and cannot be removed by an extension, it says so.

## 1. Network capture channel

The capture script (`netcap.js`) has to run in the page's own JavaScript world, because that is the
only place `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon` can be wrapped.

- The captured log lives in a closure. It is not a global, and there is no `window.__dfNet`
  (`scripts/check.js` fails if that name returns).
- The entry point is a non-enumerable property with a random name. It answers only to a 256-bit
  secret that is handed to the isolated-world `netbridge.js` at document start and from there to the
  panel. Page scripts cannot read the log or change interception rules without the secret.
- The script uses references to built-ins that it takes when it loads (`uncurry`). It never passes
  the secret to a prototype method looked up at call time, so a page that replaces
  `String.prototype.charCodeAt`, `Function.prototype.call`, `JSON` and similar does not receive it.
  `e2e/run.js` ("poisons built-ins") fails if the secret ever reaches a replaced built-in.
- `netcap.js` must not be injected with `injectImmediately`: while a document is still loading, a
  page script could ask for the key. A test fails if that option is ever used.

Limits: on-demand capture starts after the page's own scripts. A page that replaced a built-in
before DevForge was injected can weaken that guarantee. When capture starts on demand, the panel checks
22 built-ins through a clean frame and warns in the Network tab if the page replaced any of them. Capture from page start (Settings) runs
before page scripts and is the stronger mode. Until the document has loaded, a page script can send
`netbridge.js` a fake key; that can only make capture unreachable, it never reveals the real key.

## 2. Downloads of page-derived addresses

Exports, the Site download, source-map recovery and the Subresource Integrity helper fetch addresses that a page chose.

- `blocksPrivate()` (`lib/safe.js`) parses the host (IPv4, IPv6 including IPv4-mapped, NAT64 and
  6to4 forms, special-use ranges, trailing dots, malformed literals) and refuses private, loopback
  and link-local targets that the page is not itself on. The page's own host is allowed on its own
  port and on ordinary development ports, but not on well-known local administration ports. An
  unknown page address fails closed.
- Redirects are not followed unless the user turns that on. When they do, a block-only
  `declarativeNetRequest` session rule (`lib/netguard.js`, limited to requests started by the
  extension) stops every redirect hop to a private destination before the request is sent. If the
  rule cannot be installed, following redirects is refused.
- Every fetch has a size and time limit, uses `credentials: 'omit'` unless same-origin is required,
  and revalidates instead of trusting a cached copy.

Limit: a public-looking name that resolves to a private address (DNS rebinding) cannot be seen by
an extension, so host-name checks and the redirect rule do not catch it.

## 3. Page data is untrusted

- Extension pages build their DOM with the `h()` helper (text nodes). Page or network data never
  goes through `innerHTML`.
- The extension-page content security policy is `script-src 'self'` with `require-trusted-types-for 'script'`.
  The browser refuses a plain string at an HTML or script-URL sink (`innerHTML`, `srcdoc`, `DOMParser`,
  `<script src>`). Two named policies exist (`lib/trusted.js`): `devforge-html` for the sandboxed Recreate
  preview and Site's HTML rewrite, and `devforge-url`, which accepts only a relative path to a saved
  file. The manifest lists those two names and no others. `test/trusted.test.js` fails if a file
  writes to a sink, and every browser suite records Trusted Types violations. Only the Playground
  sandbox page allows `eval`, and it runs on an opaque origin with no extension APIs. It accepts a run
  message only from the panel that embeds it.
- Anything from page data that ends up in a saved file passes through the agent's
  `neutralizeTree`, `escapeRawText` and `cssUrls` helpers. Event handlers, `javascript:` addresses
  and raw-text end tags are removed or escaped, including obfuscated forms such as `java<TAB>script:`.
  The "standalone" HTML in an element export uses this neutralised copy.
- Messages sent to the panel are validated (sender is the extension itself, message type, tab and
  handle format). Saved security reports are normalised before they are shown.
- Detectors and rewriters that read hostile text use bounded quantifiers or one-pass scanners. Seeded
  fuzz tests with time budgets (`test/fuzz.test.js`, and the Fuzz block of `e2e/features.js` for the page
  agent and the Site rewrite) guard against catastrophic backtracking and against unsafe output.
- Exports (ZIPs, single files, AI prompts) are checked for credential-like values before they are saved
  (`lib/exportguard.js`). Matches are masked, kept with a warning or left out, as the user chooses. The
  check is on shape and is not a guarantee.
- Network data is redacted by default (`lib/safe.js`). Keys are matched by word, so `authToken` and
  `client_secret` are masked while `author` is not. CSV exports neutralise spreadsheet formulas.

## 4. Security checker limits

The checker only makes requests that satisfy every rule in `secRequest` (`agent/security.js`):
same origin, GET or HEAD, no cookies, no custom headers, no bodies, redirects not followed, a
request budget, a minimum pause, a timeout and a byte cap. The ceiling of 200 requests and the
100 ms minimum pause are enforced in the agent, not only in the interface. Findings never contain
secret values; they carry a type, a masked prefix and a length.

## 5. Owner mode key handling

Owner mode is described in [OWNER-MODE.md](OWNER-MODE.md). The cryptography:

| Area | Design |
| --- | --- |
| Key derivation | PBKDF2-HMAC-SHA256, 600,000 iterations, random 16-byte salt, NFKC-normalised passphrase. |
| One derivation, two uses | 512 bits are derived once. The first 32 bytes are the stored verifier, the last 32 are the AES key. The key is never stored. |
| Downgrade | `unlock()` refuses a stored record that asks for fewer iterations than the code's minimum. |
| Encryption | AES-256-GCM with a fresh 96-bit IV per seal and authenticated context (`ws:id|project|kind|created`, `origins`), so a record cannot be moved or relabelled without failing to open. |
| Key lifetime | A non-extractable `CryptoKey` in a closure, dropped on lock, on idle (5, 10, 30 or 60 minutes) and when the panel closes. |
| Guessing | Four free attempts, then 30 s doubling to 15 min, for unlock, re-verification and passphrase change alike. |
| Re-verification | Sensitive actions ask for the passphrase again if it was last typed more than 5 minutes ago. |

Limits: anyone who copies the profile's storage can guess passphrases offline, limited only by the
cost of PBKDF2, so the passphrase has to be strong (twelve characters is the minimum; four unrelated
words is better). PBKDF2 is not memory-hard, and WebCrypto offers nothing stronger. Some metadata
(item id, project, kind, date) stays readable, though it is authenticated. While unlocked, code in an
extension page can use the key, and anyone who can replace the extension's files can read the
passphrase as it is typed. There is no recovery from a forgotten passphrase.

Per-site history (performance readings, acknowledged findings) is stored under salted-hash keys so
the list of sites worked on is not readable in plain text in the profile. That hides names; it is not
encryption.

## 6. What a website can notice

An extension cannot be fully invisible to the page it works on. What DevForge does to reduce its
footprint, and what remains:

- The page agent runs in an isolated world; its objects cannot be reached by page scripts. Element
  highlights are DOM nodes whose ids start with `__df_`, and they are removed when you finish. The
  Prototype tab applies changes through `document.adoptedStyleSheets` and adds no element.
- Capture keeps per-request state in WeakMaps and adds no property to the page's
  `XMLHttpRequest`, `WebSocket` or `navigator` objects. The wrapped functions are Proxies that keep
  `name`, `length`, the prototype chain and a native-looking `toString()`. Stack traces shown in the
  Network tab drop DevForge's own frames.
- Still visible while capture runs: one non-enumerable `window` property with a random name (it
  answers nothing without the key) and one symbol on `XMLHttpRequest.prototype`. A determined
  fingerprinting script can tell a Proxy from a native function in some engines, and capture adds a
  little time to each request. A response mocked or delayed by your own rule is mocked or delayed
  (mocked responses carry an `x-devforge-mock` header so you can tell).
- DevForge declares no web-accessible resources.

DevForge does not block trackers, spoof fingerprints or hide from the browser. Settings → "What
websites can see of DevForge" runs a check in the page's own world, the way a page script would, and
lists what it found. The Owner tab has a probe that confirms the capture channel cannot be driven
without the key.

## 7. Not covered

Reviewed in Chromium only; see [BROWSER-SUPPORT.md](BROWSER-SUPPORT.md). Not tested: screen readers,
a real ten-minute idle lock (a shortened timer was used), behaviour against real third-party sites,
and secret-field redaction in the workflow recorder.

Fixed in 4.3.0 and covered by tests (`e2e/features.js`, blocks "Page agent against hostile names" and
"Pick mode and the panel"):

- A form answers to the names of its controls before its own properties, so a page could name an input
  `getAttribute` or `parentElement` and break an agent read, or make a loop that walks `parentElement`
  run forever and freeze the tab. The agent now reads elements through `dom` (see `agent.js`), and
  ESLint stops new code from calling the shadowable properties directly.
- The agent no longer skips an inline script because its id is `__df_bridge`. DevForge stopped using
  that id long ago, so the check only let a page hide code from the scripts list, the Site download and
  the Security scan.
- Pick mode ends when the panel closes. The agent holds a port to the panel while picking.

Still open: DevForge removes its own highlight elements from a saved page by the id prefix `__df_`, so a
page can leave one of its own elements out of a saved copy by using that prefix. `dom` covers the
properties the agent reads; others, such as `id`, `className` and `style`, can still be shadowed on a
form and give a wrong string, never an error.
