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

// A real bug report, reproduced live: "an older desktop with outdated
// Chrome, the 2nd page being printed always starts on the first page[,]
// continues overlapping on the wrong pages" - for name tags, badges, every
// print page in the app, not any one page in particular. Root cause: a
// bare, completely unscoped `@page { size: landscape; margin: 1cm; }` used
// to sit in this file with no selector to scope it with (CSS gives @page
// no class/attribute selector) - this stylesheet is shared by literally
// every page in the app (every view links it via partials/head.ejs), so an
// unscoped @page rule here is a global default for ALL of them, not just
// whichever one feature it was meant for. Several print views never
// declared their own @page override at all, so for those this was a
// guaranteed landscape default on ANY browser; for the ones that DO
// override it with their own `<style>@page{...}</style>`, correctness
// depended on every browser engine resolving the shared-stylesheet-vs-
// inline-style cascade identically - exactly the kind of cross-engine
// inconsistency an older browser is most likely to get wrong. Confirmed
// live via Playwright (page.pdf) that this stray rule alone was enough to
// flip a portrait badge sheet to a landscape physical page, overflowing
// its content onto a spurious extra page mid-sheet - the exact reported
// symptom. The real fix is architectural (every @page override belongs in
// its own view's <style> tag, never the shared stylesheet - see
// admin-name-tag-print.ejs and friends for the established pattern this
// restores), so the regression to guard against is simply this shared
// file ever declaring an @page rule of its own again, for any reason.
test('the shared stylesheet never declares its own @page rule', () => {
  assert.doesNotMatch(
    css,
    /@page\s*(\w+\s*)?\{/,
    'public/css/styles.css is linked by every single page in the app - an @page rule here is a global default for all of them, not just whichever feature it was meant for. Put it in that view\'s own <style> tag instead (see admin-name-tag-print.ejs and friends)'
  );
});

// A real request: "shrink table to fit properly in mobile view" (Main
// Admin > Events > Event Registration Log). Confirmed live via Playwright
// that long family/member/event names rendered overlapping, illegible
// text until two things were both true: table-layout:fixed (so the
// browser respects the table's own declared width instead of growing it
// to fit content), AND an explicit white-space:normal override that
// comes AFTER .roster-table th/td's own sitewide white-space:nowrap rule
// in the file - the two selectors are exactly equal specificity (one
// class + one element each), so whichever is written LATER in the file
// wins a tied cascade, not whichever "looks like" the more specific
// override. A version of this same rule placed earlier in the file (by
// line number) lost that tie and the overlap bug came right back despite
// looking identical on paper - this guards the actual relative order,
// not just that the rule exists somewhere.
test('the Event Registration Log print table\'s white-space override comes after .roster-table th/td\'s own nowrap rule (equal specificity - source order decides)', () => {
  const baseRuleIndex = css.indexOf('.roster-table th, .roster-table td {');
  const overrideIndex = css.indexOf('.event-reglog-print-table th, .event-reglog-print-table td');
  assert.ok(baseRuleIndex !== -1, 'expected to find the sitewide .roster-table th/td base rule');
  assert.ok(overrideIndex !== -1, 'expected to find the .event-reglog-print-table white-space override');
  assert.ok(
    overrideIndex > baseRuleIndex,
    'the .event-reglog-print-table white-space:normal override must come AFTER .roster-table th/td\'s own white-space:nowrap in the file - equal specificity means a tie goes to whichever is written later, so moving this rule earlier (even with identical selector text) silently loses the cascade and brings back the overlapping-text bug'
  );
});

// Same regression, same reasoning, for Co-op Admin > Classes > Class
// Registration Log's own print table (routes/admin-schedule.js) - a
// separate class/CSS rule from the Event Registration Log's, but built
// from the exact same real request and the exact same cascade trap.
test('the Class Registration Log print table\'s white-space override comes after .roster-table th/td\'s own nowrap rule (equal specificity - source order decides)', () => {
  const baseRuleIndex = css.indexOf('.roster-table th, .roster-table td {');
  const overrideIndex = css.indexOf('.class-reglog-print-table th, .class-reglog-print-table td');
  assert.ok(baseRuleIndex !== -1, 'expected to find the sitewide .roster-table th/td base rule');
  assert.ok(overrideIndex !== -1, 'expected to find the .class-reglog-print-table white-space override');
  assert.ok(
    overrideIndex > baseRuleIndex,
    'the .class-reglog-print-table white-space:normal override must come AFTER .roster-table th/td\'s own white-space:nowrap in the file - equal specificity means a tie goes to whichever is written later'
  );
});
