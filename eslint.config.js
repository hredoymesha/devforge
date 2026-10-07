const js = require('@eslint/js');
const globals = require('globals');

const panelGlobals = {
  DF: 'writable',
  h: 'readonly',
  $: 'readonly',
  clear: 'readonly',
  tagEl: 'readonly',
  mono: 'readonly',
  toast: 'readonly',
  status: 'readonly',
  busy: 'readonly',
  exec: 'readonly',
  call: 'readonly',
  activeTab: 'readonly',
  ensureAgent: 'readonly',
  download: 'readonly',
  copy: 'readonly',
  toCSV: 'readonly',
  toMD: 'readonly',
  slug: 'readonly',
  stamp: 'readonly',
  ensureOrigins: 'readonly',
  fetchBytes: 'readonly',
  registerTab: 'readonly',
  registerCommand: 'readonly',
  show: 'readonly',
  errBox: 'readonly',
  section: 'readonly',
  kv: 'readonly',
  table: 'readonly',
  codeBlock: 'readonly',
  loading: 'readonly',
  colorSwatch: 'readonly',
  needsSelection: 'readonly',
  startPick: 'readonly',
  saveToWorkspace: 'readonly',
  NO_ACCESS_MSG: 'readonly',
  RESTRICTED: 'readonly',
  DFZip: 'readonly',
  DFGen: 'readonly',
  DFValidate: 'readonly',
  DFAI: 'readonly',
  DFStore: 'readonly',
  DFSite: 'readonly',
  DFSafe: 'readonly',
  acorn: 'readonly',
  beautifier: 'readonly',
  csvEsc: 'readonly',
  redactUrl: 'readonly',
  redactValue: 'readonly',
  redactBody: 'readonly',
  redactEntry: 'readonly',
  redactHeaders: 'readonly',
  blocksPrivate: 'readonly',
  isPrivateHost: 'readonly',
};

module.exports = [
  { ignores: ['lib/acorn.js', 'lib/beautifier.min.js', 'node_modules/**', 'tests/fixtures/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node, ...panelGlobals },
    },
    rules: {
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  { files: ['eslint.config.js'], languageOptions: { sourceType: 'commonjs' } },
];

module.exports.push({
  files: ['tests/**/*.js'],
  rules: { 'no-control-regex': 'off', 'no-useless-escape': 'off' },
});

module.exports.push({
  files: ['panel/**/*.js'],
  languageOptions: {
    globals: {
      setTheme: 'readonly',
      wf: 'readonly',
      net: 'readonly',
      siteS: 'readonly',
      treeSel: 'writable',
      snaps: 'readonly',
      shot: 'readonly',
      developerReport: 'readonly',
    },
  },
});
