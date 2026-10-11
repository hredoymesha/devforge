# Accessibility: what was checked, what was found, what is still manual

## Automated (ran, results recorded)

`npm run a11y` (`e2e/a11y.js`, axe-core 4.14.0) loads the real extension in Chromium and scans **every panel** (20 of
them: the tab list in `panel/boot.js`) in **dark and light** themes at **1280 px and 360 px** wide, in each panel's
initial state. Against WCAG 2.x A/AA rules axe can decide automatically it first found **4 problems**, all fixed:

| Found | Fix |
| --- | --- |
| Command-palette button's accessible name did not contain its visible text "⌘K" (WCAG 2.5.3) | name is now "⌘K Command palette" |
| No `main` landmark (`<main>` had `role=tabpanel`), and content outside landmarks (`<nav role=tablist>` lost its navigation role) | `<main>` contains a `div[role=tabpanel]`; the tab strip lives in a real `<nav aria-label="Panels">` |
| Network rows set apart by fading to 75 % opacity gave 3.4–4.0:1 text | set apart by italics instead; full-strength text |
| (also computed) dark-theme primary buttons: white on blue 3.0:1; light-theme accent/ok/warn on tinted backgrounds 4.3:1 | dark text on the accent (6.4:1); darker accent, ok and warning colours (≥ 5:1) |

Result after the fixes: **0 violations** (the `a11y` run exits non-zero on serious/critical ones). The e2e suite also
checks, for every panel at **320 px** (WCAG 1.4.10 reflow): every control has a name, ids are unique, no positive
`tabindex`, no horizontal scroll; plus: tab strip names/icons, `aria-selected` as strings, `role=alert` on Owner and
Security messages, focus returns to the field after a rejected passphrase, `[hidden]` honoured, narrow tab bar. The overflow menu's keyboard model (arrows, Home/End, Esc, focus return) is
implemented in `panel/boot.js` but is **not** covered by an automated test.

`prefers-reduced-motion` is honoured in `sidepanel.css`.

## Not covered (be honest about these)

* **No screen reader was run** (NVDA, JAWS, VoiceOver, TalkBack). Axe cannot judge whether labels make sense when
  spoken, reading order, or live-region politeness.
* axe sees only what is on screen when it runs: panel **initial** states. Results tables, the Security report, Owner
  unlocked, error and loading states were checked by the e2e assertions above, not by axe.
* Colour contrast is computed for the theme tokens and for what axe sees; hover/focus/active/disabled state colours
  and every badge were not individually measured.
* Browser zoom to 200–400 % and OS text-scaling in the real side panel were not exercised (only narrow widths).
* Touch-target sizes were not measured.

## Manual checklist (about 20 minutes)

1. Unplug the mouse. From the address bar, reach the panel, then use only Tab / Shift+Tab / arrows / Enter / Esc to open
   each tab, the overflow menu, the command palette (Ctrl+K), Settings, the Security setup, a scan, a finding's details, and
   the Owner tab. Focus must always be visible and never trapped; Esc must close menus and dialogs and return focus.
2. With a screen reader: each tab announces name and "selected"; errors and scan progress are announced without moving
   focus; icon-only buttons have names; the report's severity is spoken as text, not colour.
3. Zoom the panel to 200 % and set a 24 px minimum text size: no clipped controls, no sideways scrolling.
4. Turn on "reduce motion" and "high contrast / forced colours": nothing disappears.
5. Repeat in both themes.
