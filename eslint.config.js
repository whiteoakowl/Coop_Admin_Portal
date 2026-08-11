// Minimal lint setup: eslint:recommended plus manual global declarations,
// not an opinionated style guide (no Airbnb/Standard) - the goal is
// catching real mistakes (unused vars, unreachable code, accidental
// `var` leakage, loose `==`), not enforcing a formatting convention on
// top of an already-consistent hand-written codebase.
const js = require('@eslint/js');
const globals = require('globals');

// 'error' (not 'warn') - the CI lint step only fails the build on errors,
// and unused-vars is the rule most likely to actually catch something
// (see the audit this config was built from: several genuinely dead
// imports). A 'warn' here would silently stop enforcing itself in CI.
const unusedVarsRule = ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }];

module.exports = [
  {
    // node_modules/data are implicitly ignored by eslint's defaults; data/
    // is the gitignored runtime SQLite DB directory, listed here anyway in
    // case a stray .js ever ends up in it.
    ignores: ['data/**', 'public/js/vendor/**'],
  },
  js.configs.recommended,
  {
    // Server-side: server.js, db/, middleware/, routes/, utils/, netlify/
    // (the Netlify Functions wrapper - same plain CommonJS Node code,
    // just invoked by Netlify's runtime instead of `node server.js`
    // directly), scripts/ (one-off ops scripts like the Supabase data
    // migration, run by hand via `node scripts/...`, never imported by
    // the app itself), and this config file itself - plain CommonJS Node,
    // no bundler/transpiler. .stylelintrc.js belongs here too, for the
    // same reason: it's a CommonJS config file Node loads directly, not
    // browser code.
    files: ['server.js', 'eslint.config.js', '.stylelintrc.js', 'db/**/*.js', 'middleware/**/*.js', 'routes/**/*.js', 'utils/**/*.js', 'test/**/*.js', 'a11y/**/*.js', 'netlify/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // A caught error that's deliberately unused (e.g. a fallback catch)
      // is a normal pattern in this codebase - only flag genuinely unused
      // top-level/function-scoped variables and args.
      'no-unused-vars': unusedVarsRule,
    },
  },
  {
    // Client-side: public/js/*.js - runs in the browser via a plain
    // <script src>, no bundler, so `require`/`module` don't exist here
    // and `fetch`/`document`/`window` do.
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: globals.browser,
    },
    rules: {
      'no-unused-vars': unusedVarsRule,
    },
  },
  {
    // name-tag-render-core.js is deliberately dual-environment (see its
    // own header comment) - loaded via <script> by the browser-side
    // design editor AND via require() by the Node print routes, so it
    // needs both global sets, not just one.
    files: ['public/js/name-tag-render-core.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-unused-vars': unusedVarsRule,
    },
  },
  {
    // Service worker (public/sw.js) - its own global scope
    // (ServiceWorkerGlobalScope), not window/document.
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: globals.serviceworker,
    },
    rules: {
      'no-unused-vars': unusedVarsRule,
    },
  },
];
