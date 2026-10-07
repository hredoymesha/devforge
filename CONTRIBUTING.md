# Contributing

Bug reports and pull requests are welcome.

## Before you open a pull request

```sh
npm ci
npm run format
npm run lint
npm run test:unit
```

For changes that touch the panel or the page agent, also run the end-to-end tests (see the README).
They load the real extension in Chromium, so they take a few minutes.

## Guidelines

- Anything that comes from a web page is untrusted. Set it with `textContent` or attributes, never
  `innerHTML`, and never build HTML or CSS by string concatenation without escaping.
- Add a test for every bug you fix. Hostile-input cases belong in `tests/unit_site.js` or
  `tests/test_site.py`.
- Keep the permission list as small as it is. A new permission needs a reason in the README table.
- A result that is a guess must be labelled as inferred, not shown as fact.
