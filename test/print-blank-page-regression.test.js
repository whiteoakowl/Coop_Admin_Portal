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

// A real bug report: "on an older desktop with outdated Google Chrome,
// the 2nd page being printed always starts on the first page" - every
// other device/browser prints it fine. A second confirmed shape of the
// same underlying class of bug this file already guards above: this one
// traced to .print-page's own `min-height: 100vh` in @media print - a
// break-before block whose real height lands very close to (or, with
// `vh`, resolves inconsistently around) the page's true full usable
// height confuses a browser's real print-pagination engine, worse and
// differently on older/less up-to-date print engines (see .badge-sheet-
// page.badge-sheet's own comment in styles.css, which this file already
// fixed the same way: an explicit value with real margin below the
// page's usable height instead of a vh-based one flush against it).
test('.print-page never uses a vh unit for its own print height/min-height (the confirmed cross-engine blank/misplaced-page bug shape)', () => {
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const offenders = [];
  let m;
  while ((m = ruleRe.exec(css))) {
    const [, selectorList, body] = m;
    if (!/\.print-page\b/.test(selectorList)) continue;
    if (!/(height|min-height)\s*:\s*[\d.]+vh\b/.test(body)) continue;
    offenders.push(selectorList.trim());
  }
  assert.deepEqual(offenders, [], `found a vh-based height/min-height on .print-page - this reproduces the real cross-engine pagination bug: ${offenders.join(', ')}`);
});

test('.print-page keeps a real safety margin below every print view\'s own usable page height (never within half an inch of it)', () => {
  const match = /\.print-page\s*\{\s*min-height:\s*([\d.]+)in;\s*\}/.exec(css);
  assert.ok(match, 'expected a plain `.print-page { min-height: <N>in; }` override inside @media print');
  const minHeight = parseFloat(match[1]);
  // The smallest usable page height across every view using .print-page
  // (admin-setup.ejs, admin-volunteer-teams.ejs: 0.5in @page margins on
  // an 11in letter page = 10in usable) - half an inch of real margin
  // below that, matching the cushion .team-print-page-fit's own comment
  // establishes for this exact bug class (9.2in against a 9.8in need).
  const smallestUsableHeight = 10;
  assert.ok(minHeight <= smallestUsableHeight - 0.5, `.print-page's min-height (${minHeight}in) is too close to the smallest usable page height (${smallestUsableHeight}in) - risks the same pagination bug this is meant to avoid`);
});

// A real bug report: "printing works... all other devices. Make sure
// printing works universal for any age device." An audit for this report
// found .schedule-print-card (the single-member Schedule print page's own
// per-class card) using `break-inside: avoid` with no legacy `page-break-
// inside: avoid` alongside it - an older browser's print engine only
// understands the legacy property, so that card could still split across
// a page break there even though every other break-inside rule in this
// file already carries both (see .class-schedule-print-card's own
// comment on exactly why). This locks that pairing in for every current
// and future break-inside rule file-wide, not just this one case.
test('every break-inside rule in styles.css also carries the legacy page-break-inside pairing, for older print engines', () => {
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const offenders = [];
  let m;
  while ((m = ruleRe.exec(css))) {
    const [, selectorList, body] = m;
    if (!/(^|[^-])break-inside\s*:/.test(body)) continue;
    if (/(^|[^-])page-break-inside\s*:/.test(body)) continue;
    offenders.push(selectorList.trim());
  }
  assert.deepEqual(
    offenders,
    [],
    `found a break-inside rule with no paired legacy page-break-inside - older print engines won't honor it: ${offenders.join(', ')}`
  );
});
