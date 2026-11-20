# DevForge live check

This tool checks the extension ZIP that you plan to upload to the Chrome Web Store. It opens the ZIP in a real
Chromium browser, goes through every panel and writes one report you can read in a browser.

It checks the **ZIP itself**, not the source folder, and it does not change the manifest. That is the point:
you test what the store will receive.

## What it does

1. **Package check.** ZIP and checksum, file list, manifest rules, icons, permissions against the reasons you
   wrote for them, content security policy, remote code, web addresses written into the code.
2. **Live run.** Loads the extension, opens a demo page, then opens every panel in dark and light, wide and
   narrow. It looks for errors, empty panels, text that says `undefined` or `NaN`, controls with no name,
   sideways scrolling, security-policy violations and any request the extension sends to an outside address.
   It also does ten things a person does (pick an element, watch a request, export a ZIP, run a scan and so on).
3. **Report.** `report.html` with a verdict, a list of what needs your attention, and a screenshot of every panel.
4. **Hand check.** `checklist.html` is a list for the part a script cannot do in the normal Chrome (see below).

## Run it on Windows (PowerShell)

You need Node.js 18 or newer. Open PowerShell and run these lines one at a time:

```powershell
cd "C:\Users\mesha\Documents\Github Repo\DevForge-4.4.0-repo\devforge\tools\livecheck"
pwd
npm ci
npx playwright install chromium
node livecheck.js --zip "C:\path\to\DevForge-4.5.0-extension.zip" --headed --slow 150
```

`pwd` must show the folder that holds `livecheck.js`. The tool has its own `package.json` and lockfile
(Playwright 1.63.0 only). They are separate from the extension's: nothing here goes into the extension ZIP,
and the extension's `npm ci` does not install Playwright. `--headed` opens a visible browser window so you can
watch it work. `--slow 150` slows each step down a little. Leave both out for a fast run without a window.

When it finishes it prints the path of `report.html`. Open that file in your browser.

Put the `.sha256` file next to the ZIP (same name plus `.sha256`) and the tool checks it too.

## Other options

| Option | What it does |
| --- | --- |
| `--audit-only` | Only the package check. Takes a second. No browser. |
| `--url https://example.com` | Also loads that page with the extension installed (repeat the option for more pages). The tool only visits addresses you give it. |
| `--out folder` | Where to write the report. |
| `--chrome "C:\path\to\chrome.exe"` | Use a different Chromium or Chrome for Testing build. Normal Chrome 137 and newer will not load the extension this way. |

## Prove that the tool can fail

```powershell
cd "C:\Users\mesha\Documents\Github Repo\DevForge-4.4.0-repo\devforge\tools\livecheck"
pwd
node selftest.js "C:\path\to\DevForge-4.5.0-extension.zip" --live
```

It makes broken copies of your ZIP (a source map, a new permission, an unsafe policy, a console error, a
request to an outside address and so on) and checks that the tool notices every one. All lines must say `ok`.

## What this tool cannot do

- It opens the side panel as a normal browser tab. The real side panel (its width, the toolbar icon, the
  shortcuts, the right-click menu) is only checked by you, with `checklist.html`.
- It runs in Chromium. Chrome stable, Edge and screen readers are not covered.
- It uses a demo page and the pages you name. It cannot know how the extension behaves on every site.
- A passed check is not a promise that the store will accept the extension. The store has its own review.

## Files

`permission-reasons.json` holds the plain reason for each permission. Edit it when the manifest changes; the
package check fails if a permission has no reason, or if the code uses an API without its permission.
