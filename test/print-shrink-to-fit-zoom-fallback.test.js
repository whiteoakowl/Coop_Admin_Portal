// A real bug report: "make sure printing works universal for any age
// device like all other programs in the world." public/js/print-shrink-
// to-fit.js (the Class Schedule and Setup/Cleanup Teams print pages' own
// "shrink content to fit one page" logic) used to shrink content purely
// via the CSS `zoom` property - a long-standing Chromium/WebKit/IE
// proprietary property, never a web standard, and one Firefox didn't
// implement at all until version 126 (May 2024). On any older Firefox
// (still common on older/locked-down devices), every `inner.style.zoom =
// scale` line was a silent no-op: content never actually shrank, and the
// surrounding print page's own pagination math (which reads the
// wrapper's real box size, not the never-applied zoom) would be wrong
// for it - the same "pagination doesn't match what should have
// happened" shape as the vh-based bug print-blank-page-regression.test.js
// already guards, just via a different mechanism.
//
// This doesn't (and can't, in this Node test harness - see that other
// file's own acknowledgment of the same limit for real Fullscreen/print
// pagination behavior) actually run Firefox < 126 to verify the fallback
// visually works - that was confirmed live via a real Chromium browser
// with CSS.supports('zoom', ...) monkey-patched to report unsupported
// (Playwright), proving the transform-based fallback converges to the
// exact same final scale/size the zoom path does. What this file DOES
// assert is the source-level contract that fix depends on: the feature
// detection exists, and nothing in the file bypasses it with a raw,
// unconditional `.style.zoom =` write outside the two helper functions
// that branch on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'print-shrink-to-fit.js'), 'utf8');

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
