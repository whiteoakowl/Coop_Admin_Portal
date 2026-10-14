// A real bug report: "make sure printing works universal for any age
// device like all other programs in the world" - and the follow-up that
// found this file alone wasn't the whole story: "this issue happens for
// all printing of name tags, schedule cards etc. as well." Two
// INDEPENDENT scripts turned out to share the identical gap:
// public/js/print-shrink-to-fit.js (the Class Schedule and Setup/Cleanup
// Teams print pages' own "shrink content to fit one page" logic) and
// public/js/print-auto.js (the on-screen print-preview shrink-to-fit-the-
// viewport logic shared by EVERY print-preview page with a .badge-sheet-
// page/.print-page/.avery-label-sheet-page - Name Tags and Schedule Cards
// included). Both shrank content purely via the CSS `zoom` property - a
// long-standing Chromium/WebKit/IE proprietary property, never a web
// standard, and one Firefox didn't implement at all until version 126
// (May 2024). On any older Firefox (still common on older/locked-down
// devices), every `.style.zoom = scale` line in either file was a silent
// no-op - for print-shrink-to-fit.js that meant the print page's own
// pagination math (which reads the wrapper's real box size, not the
// never-applied zoom) would be wrong; for print-auto.js it meant the
// on-screen preview itself could still bleed off a narrow/mobile
// viewport, the exact bug print-auto.js exists to prevent in the first
// place, just for a different slice of browsers than it was originally
// written against.
//
// This doesn't (and can't, in this Node test harness - see print-blank-
// page-regression.test.js's own acknowledgment of the same limit for
// real Fullscreen/print pagination behavior) actually run Firefox < 126
// to verify either fallback visually works - both were confirmed live in
// a real Chromium browser with CSS.supports('zoom', ...) monkey-patched
// to report unsupported (Playwright), proving the transform-based
// fallback converges to the exact same final scale/size the zoom path
// does in each file. What this file DOES assert is the source-level
// contract those fixes depend on: the feature detection exists in both,
// and nothing in either file bypasses it with a raw, unconditional
// `.style.zoom =` write outside the helper(s) that branch on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'print-shrink-to-fit.js'), 'utf8');
const printAutoSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'print-auto.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');

test('feature-detects zoom support via CSS.supports rather than assuming every browser has it', () => {
  assert.match(src, /CSS\.supports\s*\(\s*['"]zoom['"]/, 'expected a CSS.supports(\'zoom\', ...) feature check');
});

test('every scale application goes through the shared helpers, none bypass the zoom/transform branch directly', () => {
  // Exactly 4 real (non-comment) direct writes to .style.zoom/.style.
  // transform should exist in the whole file: the two branches inside
  // applyVisualScale (one zoom, one transform) and the two inside
  // resetScale (same pair, for cleanup) - anywhere else writing either
  // style directly would silently skip the fallback branch entirely for
  // whatever calls it that way, the same class of gap this fix exists to
  // close. Counting (rather than trying to regex out the two function
  // bodies, fragile against nested braces) is the robust version of the
  // same assertion.
  const codeLines = src.split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line));
  const directWrites = codeLines.filter((line) => /\.style\.(zoom|transform)\s*=/.test(line));
  assert.equal(directWrites.length, 4, `expected exactly 4 direct .style.zoom/.style.transform writes (inside applyVisualScale/resetScale only), found ${directWrites.length}:\n${directWrites.join('\n')}`);
});

test('fitGroup reads each wrap\'s own scale from fitOne\'s return value, not by reading inner.style.zoom back off the element', () => {
  // Reading inner.style.zoom back after the fact (the old approach) is
  // exactly the trap this fix closes - it reports nothing at all once a
  // page is running the transform fallback instead, silently leveling
  // every page in a Setup/Cleanup Teams print group to a wrong (NaN ->
  // always 1, i.e. "never shrink anyone") scale on that class of browser.
  assert.doesNotMatch(src, /const\s+zoom\s*=\s*parseFloat\(\s*inner\.style\.zoom\s*\)/, 'fitGroup must not read the scale back off inner.style.zoom');
  assert.match(src, /const\s+scale\s*=\s*fitOne\(\s*wrap\s*\)/, 'expected fitGroup to use fitOne\'s own return value instead');
});

// print-auto.js - the on-screen print-preview shrink-to-fit-the-viewport
// script shared by every .badge-sheet-page/.print-page/.avery-label-
// sheet-page print preview (Name Tags, Schedule Cards, Class Schedule,
// Setup/Cleanup Teams, barcode sheets, all of it) - had the identical gap
// as print-shrink-to-fit.js above, completely independently.

test('print-auto.js feature-detects zoom support via CSS.supports rather than assuming every browser has it', () => {
  assert.match(printAutoSrc, /CSS\.supports\s*\(\s*['"]zoom['"]/, 'expected a CSS.supports(\'zoom\', ...) feature check');
});

test('print-auto.js: every scale application goes through the shared applyPageScale helper, none bypass it directly', () => {
  const codeLines = printAutoSrc.split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line));
  const directWrites = codeLines.filter((line) => /\.style\.(zoom|transform)\s*=/.test(line));
  assert.equal(directWrites.length, 2, `expected exactly 2 direct .style.zoom/.style.transform writes (inside applyPageScale only, one per branch), found ${directWrites.length}:\n${directWrites.join('\n')}`);
});

test('print-auto.js: fitOne and resetAll both call the shared applyPageScale helper, not an inline zoom/transform assignment of their own', () => {
  assert.match(printAutoSrc, /applyPageScale\(page,\s*1\)/, 'expected the reset paths to call applyPageScale(page, 1)');
  assert.match(printAutoSrc, /applyPageScale\(page,\s*scale\)/, 'expected the shrink path to call applyPageScale(page, scale)');
});

// The @media print `zoom: 1 !important` hard floor (this file's own
// comment on the real bug it guards: beforeprint not firing in time on
// some mobile/embedded print flows, leaking the on-screen shrink into the
// real printout) only ever protected against a leftover zoom - a browser
// running the transform fallback instead needed the identical floor for
// its own inline transform, or the same beforeprint-didn't-fire-in-time
// risk reproduces on exactly the browsers this whole fix is for.
test('the @media print zoom:1 !important floor is paired with an equivalent transform:none !important floor, for the transform fallback', () => {
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const offenders = [];
  let m;
  while ((m = ruleRe.exec(stylesCss))) {
    const [, selectorList, body] = m;
    if (!/zoom\s*:\s*1\s*!important/.test(body)) continue;
    if (/transform\s*:\s*none\s*!important/.test(body)) continue;
    offenders.push(selectorList.trim());
  }
  assert.deepEqual(offenders, [], `found a zoom:1 !important print floor with no paired transform:none !important - a browser running the transform fallback has no equivalent hard floor: ${offenders.join(', ')}`);
});
