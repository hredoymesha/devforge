# Contributing

Thank you for helping with DevForge. Open an issue before starting large changes so the approach
can be agreed first.

## Set up

DevForge is plain JavaScript loaded as classic scripts. There is no bundler and no runtime
dependency, so there is nothing to build.

```sh
npm ci                # dev tools only: ESLint and axe-core
npm run verify:all    # lint, static checks, unit tests
```

To try a change, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and
select the repository folder. Reload the extension after each change.

The browser suites (`npm run e2e`, `e2e:features`, `e2e:exports`, `a11y`) need Playwright and a
Chromium build; see the README. Run them after changing `panel/`, `agent/`, `agent.js` or
`sidepanel.css`.

## Layout

| Path | Purpose |
| --- | --- |
| `background.js` | Service worker. Opens the panel and forwards commands. Keep it small. |
| `sidepanel.html`, `sidepanel.css` | Panel shell. Scripts load in a fixed order at the bottom of the HTML. |
| `panel/<tab>.js` | One file per tab, registered with `registerTab(id, label, render)`. Add new tabs to `ORDER` and `TAB_GROUPS` in `panel/boot.js` and a `<script>` tag to the HTML. |
| `lib/*.js` | Pure helpers with no browser APIs. Each is an IIFE assigned to a `DF…` constant and exported with `module.exports` so Node tests can load it. |
| `agent.js`, `agent/*.js` | The page agent, injected on demand. |
| `netcap.js`, `netbridge.js` | Network capture in the page's own world, and its handshake. |
| `test/` | Unit tests (`node --test`). |
| `e2e/` | Browser tests and local training sites. |

`lib/acorn.js` and `lib/beautifier.min.js` are vendored third-party code. Do not edit them.

## Rules that matter

- Put logic that can be pure in `lib/` and test it. Keep `panel/` for rendering and wiring.
- Build DOM with `h()`. Never use `innerHTML` with page or network data.
- When the agent's API changes, bump `AGENT_VERSION` in both `agent.js` and `panel/core.js`, and add
  new agent files to `AGENT_FILES`. `npm run check` fails if they differ.
- Do not add permissions without a written reason in the pull request, a README row and a
  changelog entry. Request site access at runtime, from a user gesture.
- Extension pages allow only `script-src 'self'`: no inline scripts, no `eval`.
- Fetches of page-derived addresses must pass `blocksPrivate()`, omit credentials unless same-origin
  is required, and have a size and time limit (`fetchBytes`).
- A new Security checker probe needs a content signature (not just HTTP 200) and a negative test
  showing that a single-page app that answers every path with 200 does not trigger it. The checker
  must stay same-origin, read-only and budgeted.
- Fix a bug at its root and add a test that fails without the fix. Do not skip or weaken tests.
- Code style: two spaces, single quotes, semicolons, about 100 columns. Comments explain intent or
  non-obvious browser behaviour, not what a line does.
- User-visible text is plain and concrete: say what happened and what to do.
- Update `README.md` and `CHANGELOG.md` when behaviour, permissions or commands change.

## Pull requests

Describe what changed and why, and say which of the checks above you ran. Include a screenshot for
interface changes (light and dark theme, narrow panel).
