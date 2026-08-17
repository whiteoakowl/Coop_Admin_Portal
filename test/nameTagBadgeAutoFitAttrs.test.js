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
