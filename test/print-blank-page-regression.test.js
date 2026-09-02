// Regression guard for the real "bulk printing creates extra blank pages"
// bug (see .team-print-page-fit's own extensive comment in public/css/
// styles.css for the full root-cause story, and the audit that prompted
// this file: every OTHER bulk-print sheet in the app - name tags, schedule
// cards, barcodes, barcode labels, misc badges, QR codes, duplex cards -
// was checked against the same failure shape and confirmed clean).
//
// The confirmed root cause (live Playwright page.pdf({ preferCSSPageSize:
// true }) - the only mode that actually paginates, a continuous on-screen
// scroll under print CSS does NOT reproduce it): a `page-break-before:
// always` (or `break-before: page`) rule applied to EVERY item in a
// repeating list - including the first - pushes the first item onto a
// second physical page, leaving page 1 blank. Every bulk-print sheet in
// this app that needs a break between repeating "pages" (.badge-sheet-
// page, .avery-label-sheet-page, .qr-sheet-page, .roster-archive-print-
// page, .team-print-page-fit) uses `page-break-after` instead, scoped
// `:not(:last-child)` - functionally equivalent for every REAL boundary
// (a break still separates every pair of consecutive items) without ever
// asking the print engine to break before the very first thing in the
// document, so this class of bug can't occur no matter how many items are
// on the sheet. This test locks that choice in file-wide: nothing in
// styles.css may apply page-break-before/break-before unconditionally (or
// to :first-child) - the one legitimate use (:not(:first-child), see
// .team-print-page-fit) is explicitly allowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rawCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments - some spell out the bug in plain English.

test('no page-break-before/break-before rule in styles.css applies to every item (the confirmed blank-first-page bug shape)', () => {
  // Matches a full rule's selector-list + declaration block wherever the
  // declaration block contains page-break-before or break-before, then
  // checks every comma-separated selector in that rule.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const offenders = [];
  let m;
  while ((m = ruleRe.exec(css))) {
    const [, selectorList, body] = m;
    if (!/(^|[^-])page-break-before\s*:|(^|[^-])break-before\s*:/.test(body)) continue;
    selectorList.split(',').forEach((sel) => {
      const trimmed = sel.trim();
      if (!trimmed) return;
      // The one safe shape: scoped to :not(:first-child) (or :not(:first-
      // of-type)) somewhere in the selector - a break-before rule that
      // explicitly excludes the first item can never blank page 1.
      if (/:not\(\s*:first-(child|of-type)\s*\)/.test(trimmed)) return;
      offenders.push(trimmed);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `found a page-break-before/break-before rule with no :not(:first-child) guard - this reproduces the real "first page comes out blank" bug: ${offenders.join(', ')}`
  );
});

test('every repeating bulk-print sheet class breaks AFTER each item (not before), scoped to :not(:last-child)', () => {
  // The actual pattern this app uses everywhere instead of page-break-
  // before - documents/locks in the safe alternative these classes chose.
  const sheetClasses = ['.badge-sheet-page', '.avery-label-sheet-page', '.qr-sheet-page'];
  sheetClasses.forEach((cls) => {
    const escaped = cls.replace('.', '\\.');
    const re = new RegExp(`${escaped}:not\\(:last-child\\)\\s*\\{[^}]*(page-break-after\\s*:\\s*always|break-after\\s*:\\s*page)`);
    assert.match(css, re, `expected ${cls}:not(:last-child) to break AFTER each sheet, scoped away from the last one`);
  });
});
