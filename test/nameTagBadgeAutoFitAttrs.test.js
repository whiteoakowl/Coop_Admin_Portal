// Coverage for the server-side half of the badge auto-fit fix (see
// public/js/badge-autofit.js's own header comment for the full story: a
// real bug report showed names and long allergy notes getting clipped
// after a wrap-then-clip failure mode, even on elements the server's own
// fitFontSize estimate thought would fit). name-tag-render-core.js's
// renderTextEl is the one place both the design editor and every print
// route render from, and it's what has to hand badge-autofit.js the
// contract it depends on: a `data-autofit="1"` marker to find the
// element, `data-base-font-size` as the correct value to re-search from
// (not whatever's left behind by a previous shrink pass), and
// white-space: nowrap instead of wrapping (so a still-too-wide estimate
// shows up as "still too wide" for the JS to catch, instead of silently
// wrapping onto a second line the box's own fixed height then clips
// away).
const test = require('node:test');
const assert = require('node:assert/strict');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

function autoFitTextEl(overrides) {
  return {
    id: 'name', type: 'text', field: 'name', x: 8, y: 70, width: 320, height: 28,
    fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle',
    autoFitText: true,
    ...overrides,
  };
}

test('an autoFitText element is marked data-autofit="1" with its computed font size stamped as data-base-font-size', () => {
  const html = NameTagRenderCore.renderElement(autoFitTextEl(), { name: 'Jessica Adema' });
  assert.match(html, /data-autofit="1"/);
  const m = /data-base-font-size="([\d.]+)"/.exec(html);
  assert.ok(m, 'data-base-font-size should be present');
  // "Jessica Adema" comfortably fits an 18px font in a 320px box, so the
  // estimate shouldn't have shrunk it at all - the stamped value should
  // equal the element's own configured fontSize.
  assert.equal(Number(m[1]), 18);
});

test('a non-autoFitText element gets neither data-autofit nor data-base-font-size', () => {
  const html = NameTagRenderCore.renderElement(autoFitTextEl({ autoFitText: false }), { name: 'Jessica Adema' });
  assert.doesNotMatch(html, /data-autofit/);
  assert.doesNotMatch(html, /data-base-font-size/);
});

test('an autoFitText element is forced onto a single line (white-space: nowrap) with an ellipsis fallback, not wrap-then-clip', () => {
  const html = NameTagRenderCore.renderElement(autoFitTextEl(), { name: 'Alexandria Montgomery-Whitfield' });
  assert.match(html, /white-space: nowrap/);
  assert.match(html, /text-overflow: ellipsis/);
  assert.doesNotMatch(html, /overflow-wrap: break-word/, 'autoFitText must not fall back to the wrapping style a longer free-text field uses');
});

test('a non-autoFitText field still wraps normally (overflow-wrap: break-word), matching a Class Description-style field', () => {
  const html = NameTagRenderCore.renderElement(
    { id: 'description', type: 'text', field: 'description', x: 8, y: 8, width: 320, height: 60, fontSize: 12, color: '#000', bold: false, align: 'left', valign: 'top' },
    { description: 'A long description that should wrap across multiple lines instead of shrinking.' }
  );
  assert.match(html, /overflow-wrap: break-word/);
  assert.doesNotMatch(html, /white-space: nowrap/);
});

test('data-base-font-size reflects fitFontSize\'s own shrink for a name too long for its box, not the unshrunk configured fontSize', () => {
  const html = NameTagRenderCore.renderElement(autoFitTextEl({ width: 140 }), { name: 'Alexandria Montgomery-Whitfield' });
  const m = /data-base-font-size="([\d.]+)"/.exec(html);
  assert.ok(Number(m[1]) < 18, 'a name that overflows a narrow box should have already been shrunk below the configured 18px by the server estimate');
});

// Coverage for a real follow-up request: a parent's Monday and Wednesday
// setup/cleanup jobs should "share a text space" - ONE element/box -
// instead of sitting as two separately-positioned elements, while each
// line stays individually labeled and individually shrunk to fit. A
// field whose data value is an ARRAY of lines (utils/nameTagData.js's
// setupCleanupJobLabels returns setupCleanupDays that way) renders as one
// .badge-el-text box containing one .badge-el-text-inner span per line,
// each stamped with its OWN data-base-font-size (see public/js/badge-
// autofit.js's shrinkToFit, which now shrinks every line in a box
// independently rather than assuming exactly one).
function multilineEl(overrides) {
  return {
    id: 'setup-cleanup-days', type: 'text', field: 'setupCleanupDays', x: 8, y: 4, width: 320, height: 32,
    fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle',
    autoFitText: true,
    ...overrides,
  };
}

test('an array-valued field renders one .badge-el-text-inner span per line, each in its own single box', () => {
  const html = NameTagRenderCore.renderElement(multilineEl(), { setupCleanupDays: ['Monday: Chairs & Tables', 'Wednesday: —'] });
  const boxOpenTags = html.match(/<div class="badge-el badge-el-text"/g) || [];
  assert.equal(boxOpenTags.length, 1, 'both lines must share ONE box, not two separate elements');
  const spans = html.match(/<span class="badge-el-text-inner"/g) || [];
  assert.equal(spans.length, 2, 'each line gets its own inner span');
  assert.match(html, /Monday: Chairs &amp; Tables/);
  assert.match(html, /Wednesday: —/);
});

test('a multi-line box stacks its lines (flex-direction:column) instead of centering one line on a flex row', () => {
  const html = NameTagRenderCore.renderElement(multilineEl(), { setupCleanupDays: ['Monday: Chairs & Tables', 'Wednesday: —'] });
  assert.match(html, /flex-direction:column/);
});

test('each line in a multi-line autoFitText box gets its own data-base-font-size, shrunk independently', () => {
  // A long Monday line and a short Wednesday placeholder - if they shared
  // one font-size search, the long line would drag the short one down
  // with it for no reason.
  const html = NameTagRenderCore.renderElement(
    multilineEl({ width: 100 }),
    { setupCleanupDays: ['Monday: Chairs & Tables, Snack Duty, Setup Crew', 'Wednesday: —'] }
  );
  const sizes = [...html.matchAll(/data-base-font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(sizes.length, 2, 'both lines should be marked for auto-fit');
  assert.ok(sizes[0] < sizes[1], 'the longer Monday line should have been shrunk further than the short Wednesday placeholder');
});

test('a single-string field (the normal case) is unaffected - still exactly one span, no flex-direction:column', () => {
  const html = NameTagRenderCore.renderElement(autoFitTextEl(), { name: 'Jessica Adema' });
  const spans = html.match(/<span class="badge-el-text-inner"/g) || [];
  assert.equal(spans.length, 1);
  assert.doesNotMatch(html, /flex-direction:column/);
});
