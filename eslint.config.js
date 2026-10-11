// ESLint (flat config). DevForge is plain classic scripts that share one global scope per context,
// so `no-undef` needs to know the names other files define. Rather than keeping a hand-written list
// (which rots), the names are collected from the source itself with the vendored Acorn parser: every
// top-level function/class/const/let/var in lib/ and panel/ is a known global for those files.
// Vendored third-party code (lib/acorn.js, lib/beautifier.min.js) is not linted.
const fs = require('node:fs');
const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');
const acorn = require('./lib/acorn.js');

const root = __dirname;
const VENDORED = ['lib/acorn.js', 'lib/beautifier.min.js'];

const list = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js')).map((f) => dir + '/' + f);

function topLevelNames(files) {
  const names = {};
  for (const f of files) {
    if (VENDORED.includes(f)) continue;
    let ast;
    try {
      ast = acorn.parse(fs.readFileSync(path.join(root, f), 'utf8'), { ecmaVersion: 'latest', sourceType: 'script' });
    } catch (_) {
      continue; // a syntax error is reported by `npm run check`, not here
    }
    for (const n of ast.body) {
      if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') names[n.id.name] = 'readonly';
      // let/var are meant to be reassigned from other files; const is not.
      if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.id.type === 'Identifier') names[d.id.name] = n.kind === 'const' ? 'readonly' : 'writable';
    }
  }
  return names;
}

// lib/safe.js copies its helpers onto window (Object.assign(window, DFSafe)); beautifier is vendored.
const safeExports = Object.fromEntries(Object.keys(require('./lib/safe.js')).map((k) => [k, 'readonly']));

const PANEL_FILES = [...list('lib'), ...list('panel')].filter((f) => !VENDORED.includes(f));
const panelGlobals = topLevelNames(PANEL_FILES);
const agentGlobals = topLevelNames(['agent.js', ...list('agent')]);

// Rules that matter for the security model (CLAUDE.md): no dynamic code, no script: URLs.
const security = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
  'no-extend-native': 'error',
  'no-proto': 'error',
  'no-caller': 'error',
  'no-with': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'backups/**', 'lib/acorn.js', 'lib/beautifier.min.js', 'scratch/**', 'scratchpad/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  {
    // Every extension page script and library: classic scripts in the panel's shared scope.
    files: PANEL_FILES,
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly', module: 'readonly', require: 'readonly', ...safeExports, beautifier: 'readonly', acorn: 'readonly', ...panelGlobals },
    },
    rules: {
      ...security,
      // Top-level declarations are shared with other files on purpose.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', vars: 'local', ignoreRestSiblings: true }],
      'no-redeclare': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Style rule (re-throwing with `cause`); this codebase shows users plain messages instead.
      'preserve-caught-error': 'off',
    },
  },
  {
    // Page agent: injected into the page's isolated world.
    files: ['agent.js', 'agent/*.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 'latest', globals: { ...globals.browser, chrome: 'readonly', ...agentGlobals } },
    rules: { ...security, 'preserve-caught-error': 'off', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', vars: 'local', ignoreRestSiblings: true }], 'no-empty': ['error', { allowEmptyCatch: false }] },
  },
  {
    // Scripts that run in the page's own world, and the sandbox runner.
    files: ['netcap.js', 'netbridge.js', 'sandbox.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 'latest', globals: { ...globals.browser } },
    rules: { ...security, 'preserve-caught-error': 'off', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }], 'no-empty': ['error', { allowEmptyCatch: false }] },
  },
  {
    // Service worker.
    files: ['background.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 'latest', globals: { ...globals.serviceworker, chrome: 'readonly' } },
    rules: { ...security },
  },
  {
    // Node tooling: scripts, tests, the e2e driver and this file.
    files: ['scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 'latest', globals: { ...globals.node } },
    rules: { ...security, 'preserve-caught-error': 'off', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-script-url': 'off' /* tests feed javascript: URLs to the validators on purpose */ },
  },
  {
    // The e2e driver is Node code, but most of its callbacks are serialised and run inside the panel
    // or the page, so those names are known too.
    files: ['e2e/**/*.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 'latest', globals: { ...globals.node, ...globals.browser, chrome: 'readonly', ...safeExports, ...panelGlobals } },
    rules: { ...security, 'preserve-caught-error': 'off', 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }], 'no-script-url': 'off' },
  },
];
