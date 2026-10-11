# Browser support: what is verified and what is not

**Verified:** Chromium 1194 (the build bundled with Playwright in this environment), by `npm run e2e`, which loads
the real extension (a scratch copy with host access added), drives the side-panel page and local fixture sites,
and checks behaviour on the wire. That is the only browser anything was run in.

**Not tested:** Google Chrome stable, Microsoft Edge, Brave, Opera, Vivaldi, Firefox, Safari. No such browser is
installed in the build environment, and loading an extension in them is not automated here. Nothing below should
be read as "supported".

## Why Firefox does not work today (from reading the manifest and the code; MDN was unreachable from the
sandbox, so check the current compatibility tables before acting)

| DevForge uses | Firefox |
| --- | --- |
| `side_panel` + `chrome.sidePanel.open()` (the whole UI) | no such API; Firefox has `sidebar_action` / `sidebarAction` with a different opening model |
| `background.service_worker` (MV3) | Firefox MV3 uses `background.scripts` (event page); a service-worker background is not accepted |
| `chrome.scripting.executeScript` with `world: 'MAIN'`, `registerContentScripts` with `world`, `runAt: 'document_start'`, `persistAcrossSessions` | partly supported in newer versions; `persistAcrossSessions` is Chromium-specific |
| `declarativeNetRequest` session rules with `initiatorDomains` | Firefox supports DNR but behaviour differs for extension-initiated requests; the redirect guard has only been measured in Chromium |
| `optional_host_permissions`, `chrome.permissions` | supported with differences; `minimum_chrome_version` is Chromium-only |
| `chrome.cookies`, `chrome.storage.session`, `chrome.contextMenus`, `chrome.commands` | available |
| `chrome.tabs.captureVisibleTab` | available, different permission rules |

A realistic Firefox port needs a second manifest, a sidebar adapter, a background-script entry and re-measurement of
the capture handshake and the redirect guard. It is not attempted here because it would risk destabilising
the Chromium build for no verified benefit. If you want it, treat it as a separate project with its own tests.

## Chromium-based browsers

Edge, Brave and Opera share Chromium's extension platform and may run the extension, but `chrome.sidePanel`
availability and permission prompts vary by vendor and version. Test each by loading the unpacked folder and running
`npm run e2e` with `CHROME_PATH` pointing at that browser's binary **where it allows `--load-extension`** (branded
Chrome 137+ ignores that flag; use the bundled Chromium or Chrome for Testing).

## How to extend the matrix

1. Load the unpacked folder in the browser, open the panel, run Home → each quick action.
2. `CHROME_PATH=/path/to/browser npm run e2e`.
3. Record the version and the result here. Until then the status stays "not tested".
