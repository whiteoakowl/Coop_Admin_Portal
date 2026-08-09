// Regression guard for a real bug: the print-mode rule that swaps the
// Members page's interactive table for its print-only counterpart used to
// target the bare, widely-shared `.members-table` styling class instead of
// a page-specific one. `.members-table` is reused all over the app purely
// for its look (the Allergies/Medical Log, the Setup/Cleanup task list
// print view, every tab on the Logs page) - none of those have their own
// `.members-print-table` counterpart to swap in, so a bare
// `.members-table { display: none }` in the print media block silently
// blanked out every one of them when printed. Verified live with a real
// headless browser under print-media emulation before fixing; this test
// can't do that (no browser in CI - see eslint.config.js/README's own
// notes on why Playwright isn't a devDependency here), but it can at
// least keep the specific selector from quietly regressing back to the
// bare, over-broad one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rawCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
// Strip comments before matching - this file's own comments (including
// the one on the fix this test guards, a few lines above the real rule)
// use the exact phrase being checked for as plain English, which a naive
// match against the raw text would trip over.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

test('the Members print-swap rule is scoped to the page-specific class', () => {
  // Scans the whole file rather than trying to isolate "the" @media print
  // block first - there are actually two in styles.css, plus a comment
  // that happens to contain the phrase "@media print" itself, which made
  // an earlier version of this test locate the wrong span entirely. The
  // exact rule text being matched for is specific enough on its own not
  // to need scoping to a block.
  assert.match(
    css,
    /\.members-list-table\s*\{\s*display:\s*none;?\s*\}/,
    'expected a rule hiding .members-list-table (the Members page\'s own on-screen table) - most likely in the @media print block'
  );

  // The bare, unscoped selector is the actual regression to guard
  // against - `.members-table` (no trailing class, no other selector
  // sharing the rule) directly followed by `{ display: none`.
  assert.doesNotMatch(
    css,
    /(^|[^-\w])\.members-table\s*\{\s*display:\s*none/,
    'no rule should hide every .members-table sitewide - that blanks out every other page reusing that class for styling (see git history for the real bug this caught)'
  );
});
