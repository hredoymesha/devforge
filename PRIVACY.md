# Privacy

DevForge has no account, no server of its own and no analytics. It does not phone home. Its code
contains no address to send usage data to. This page says what it keeps on your computer, what it
sends and when, and why it asks for each permission. Each claim was checked against the code.

## What DevForge keeps, and where

Everything stays in your browser profile.

| Where | What | Cleared by |
| --- | --- | --- |
| `chrome.storage.local` | Your settings (`settings`); interception rules (`netRules`); performance readings per page (`perfHistory`, under a hashed key, not the address); acknowledged Security findings (`secFindingAcks`); a random salt for those keys (`installSalt`); the time of the last clean-up. With Owner mode: the sealed passphrase check, sealed scan records, the sealed list of sites you authorised and the idle-lock choice. | Settings, Stored data and clean-up buttons; removing the extension |
| `chrome.storage.session` | Short-lived state: the list of sites DevForge worked on (`siteLog`, web addresses without paths; in memory only, cleared when the browser closes, never written to disk), a command waiting for the panel (`pendingCommand`), the capture channel's key for a tab, the per-site ownership confirmations for the Security checker (`secAcknowledged`), Owner scan approvals. | Closing the browser |
| IndexedDB, database `devforge` | Workspace projects and the items you save (elements, components, screenshots, data, workflows, playgrounds, AI tasks, Security reports). | Deleting items or projects in Workspace; removing the extension |

Workspace items and saved Security reports are **not encrypted** unless you turn on Owner mode
encryption. A Security report describes a site's weak points, so treat it like any sensitive file.
Network captures live in the page's memory while capture is on. Saved bodies and headers are redacted
by default.

When DevForge reads this data back, it checks it first (`lib/stored.js`). Anything not valid is ignored
and listed in Settings, under Stored data.

To delete everything: use the clean-up buttons in Settings, delete your projects in Workspace, then
remove the extension. Removing the extension deletes its storage and its IndexedDB database.

## Page content

DevForge reads the content of the pages you use it on: the DOM, styles, scripts, storage and the network
requests it records. It handles that content on your computer. The developer of DevForge never receives it.
DevForge sends page content in one case only, when you start it: a request you replay from the Network tab
goes to the address in that request. An AI prompt goes to an AI site only when you paste it there yourself.
Exports, reports and captures are saved as files on your computer.

## What DevForge sends, and when

Only requests that you start:

- **Exports, the Site download and source-map recovery** download the files a page uses, from the sites
  that serve them. They omit credentials, refuse private and loopback addresses that the page is not on,
  and have size and time limits.
- **The Security checker** sends `GET` and `HEAD` requests to the site in the open tab only, without
  cookies, within a request budget. **Check again** and the integrity-hash helper work the same way; the
  integrity helper also downloads the page's third-party scripts and stylesheets.
- **Network tab replay and mocks** send the request you chose to replay, to the address in it.
- **AI tab.** It only builds a prompt. *Copy only* and *Copy & open* put it on your clipboard; *Copy & open*
  also opens the start page of the AI site you picked (claude.ai, chatgpt.com, gemini.google.com or
  copilot.microsoft.com). Nothing is put in that page's address. The site receives the prompt only when you
  paste it there and send it. Before the prompt is copied, DevForge checks it for credential-like values and
  offers to mask them.
- **Exports** are checked for credential-like values before they are saved, and nothing is uploaded.

One web address in the code is not used by DevForge itself: `cdn.tailwindcss.com` in `lib/gen.js`. It is
text written into the `index.html` of a Tailwind export, so that page loads Tailwind when you open it.
DevForge never loads it.

DevForge does not send your settings, saved items, browsing history or page contents anywhere else.
Pages you work on can see the traces listed in [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) section 6.

## Permissions and why

| Permission | Why |
| --- | --- |
| `scripting` | Puts DevForge's page agent and network recorder into the page you work on, only when a tool needs them. |
| `sidePanel` | Shows DevForge in the browser's side panel. |
| `storage` | Keeps your settings, interception rules, performance history and scan records on this computer. |
| `contextMenus` | Adds "Inspect with DevForge" to the right-click menu. |
| `clipboardWrite` | Copies code, selectors and prompts when you click a Copy button. Chrome lists it as "Modify data you copy and paste"; DevForge only writes to the clipboard and never reads it. |
| `declarativeNetRequest` | Blocks DevForge's own downloads from reaching private, loopback or link-local addresses, at every redirect step. It only blocks. It cannot read or change pages. Chrome lists it as "Block content on any page"; DevForge's rule blocks only its own requests. |
| Site access (all sites) | Lets DevForge work on the page in front without asking for each site. Settings → Site access can limit DevForge to sites you list. Chrome's own Site access setting for the extension still applies. |
| `cookies` (optional) | Asked for only from the Security tab, for one site, to read whether cookies are HttpOnly, Secure and SameSite. Cookie values are never read into reports. |

The `debugger` permission is not requested.

## Third-party code

DevForge bundles Acorn and js-beautify (see the README). They run inside the extension and make no
network requests of their own.

## Questions

Open an issue in the repository. Do not include secrets in it.
