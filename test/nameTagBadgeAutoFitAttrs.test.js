// Coverage for the server-side half of the badge auto-fit fix (see
// public/js/badge-autofit.js's own header comment for the full story: a
// real bug report showed names and long allergy notes getting clipped
// after a wrap-then-clip failure mode, even on elements the server's own
// fitFontSize estimate thought would fit). name-tag-render-core.js's
// renderTextEl is the one place both the design editor and every print
// route render from, and it's what has to hand badge-autofit.js the
// contract it depends on: a `data-autofit="1"` marker to find the
// element, `data-base-font-size` as the correct value to re-search from
// (not whatever's left behind by a previous shrink pass).
//
// A real later request changed the shape of this contract: "can we not
// update the template so these features of wrap text and shrink to fit
// will always work no matter what we create?" - autoFitText/autoFitWrap
// used to be per-element flags a saved template had to carry, which is
// exactly why this kept recurring (a template saved before a flag
// existed just clipped forever). Every BOUND field (name, adminPosition,
// gradeLevel, allergies, setupCleanupDays, memberCode, ...) now always
// gets autofit+wrap regardless of what's stored, derived from what the
// field IS - see renderTextEl's own comment for the two exceptions
// ('custom' and 'description') that keep the old opt-in toggle.
const test = require('node:test');
const assert = require('node:assert/strict');
const NameTagRenderCore = require('../public/js/name-tag-render-core');

function boundTextEl(overrides) {
  return {
    id: 'name', type: 'text', field: 'name', x: 8, y: 70, width: 320, height: 28,
    fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle',
    ...overrides,
  };
}

// 'custom' (a hand-typed caption) and 'description' (Setup/Cleanup Task
// text / Custom badge Description) are the two fields that keep the old
// opt-in, single-line-only behavior - see renderTextEl's own comment for
// why each is exempt from the "always on" rule above.
function customTextEl(overrides) {
  return {
    id: 'caption', type: 'text', field: 'custom', text: 'Sample', x: 8, y: 70, width: 320, height: 28,
    fontSize: 18, color: '#1c2530', bold: true, align: 'center', valign: 'middle',
    ...overrides,
  };
}

test('a bound field (e.g. name) is always marked data-autofit="1" with its computed font size stamped as data-base-font-size, even with no autoFitText set at all', () => {
  const html = NameTagRenderCore.renderElement(boundTextEl(), { name: 'Jessica Adema' });
  assert.match(html, /data-autofit="1"/);
  const m = /data-base-font-size="([\d.]+)"/.exec(html);
  assert.ok(m, 'data-base-font-size should be present');
});

test('a bound field cannot opt out - autoFitText: false on the saved element is ignored', () => {
  const html = NameTagRenderCore.renderElement(boundTextEl({ autoFitText: false }), { name: 'Jessica Adema' });
  assert.match(html, /data-autofit="1"/, 'a bound field must stay autofit regardless of a stale/explicit false flag in saved data');
});

test('a bound field wraps (overflow-wrap: break-word) rather than forcing a single ever-shrinking line with ellipsis', () => {
  const html = NameTagRenderCore.renderElement(boundTextEl(), { name: 'Alexandria Montgomery-Whitfield' });
  assert.match(html, /overflow-wrap: break-word/);
  assert.doesNotMatch(html, /white-space: nowrap/, 'a bound field must not fall back to the old forced-single-line style');
  assert.doesNotMatch(html, /text-overflow: ellipsis/);
});

test('a bound field starts from its own configured fontSize, not a single-line width estimate (that job is now public/js/badge-autofit.js\'s real-browser height correction alone)', () => {
  const html = NameTagRenderCore.renderElement(boundTextEl({ width: 140 }), { name: 'Alexandria Montgomery-Whitfield' });
  const m = /data-base-font-size="([\d.]+)"/.exec(html);
  assert.equal(Number(m[1]), 18, 'should be the element\'s own configured fontSize');
});

test('a bound field is still marked data-autofit-wrap="1" so badge-autofit.js skips its width-only shrink pass for it', () => {
  const html = NameTagRenderCore.renderElement(boundTextEl(), { name: 'Jessica Adema' });
  assert.match(html, /data-autofit-wrap="1"/);
});

test('the "description" field (Setup/Cleanup Task / Custom badge Description) is exempt from the always-on rule - it still wraps at a fixed size unless explicitly opted in, per a real prior request not to shrink it', () => {
  const html = NameTagRenderCore.renderElement(
    { id: 'description', type: 'text', field: 'description', x: 8, y: 8, width: 320, height: 60, fontSize: 12, color: '#000', bold: false, align: 'left', valign: 'top' },
    { description: 'A long description that should wrap across multiple lines instead of shrinking.' }
  );
  assert.match(html, /overflow-wrap: break-word/);
  assert.doesNotMatch(html, /white-space: nowrap/);
  assert.doesNotMatch(html, /data-autofit="1"/, 'description should not be auto-fit unless explicitly opted in');
});

test('a "custom" caption still opts in/out of the old single-line-forced behavior via autoFitText, unaffected by the always-on rule', () => {
  const off = NameTagRenderCore.renderElement(customTextEl({ autoFitText: false }), {});
  assert.doesNotMatch(off, /data-autofit/, 'a custom caption with autoFitText off should get no autofit markers');

  const on = NameTagRenderCore.renderElement(customTextEl({ autoFitText: true }), {});
  assert.match(on, /data-autofit="1"/);
  assert.match(on, /white-space: nowrap/, 'a custom caption opted into autoFitText (without autoFitWrap) still forces a single shrinking line, unlike a bound field');
  assert.match(on, /text-overflow: ellipsis/);
  assert.doesNotMatch(on, /data-autofit-wrap/);
});

test('a "custom" caption can further opt into wrap mode via autoFitWrap, same as a bound field defaults to', () => {
  const html = NameTagRenderCore.renderElement(customTextEl({ autoFitText: true, autoFitWrap: true }), {});
  assert.match(html, /overflow-wrap: break-word/);
  assert.match(html, /data-autofit-wrap="1"/);
});

// Coverage for a real follow-up request: a parent's Monday and Wednesday
// setup/cleanup jobs should "share a text space" - ONE element/box -
// instead of sitting as two separately-positioned elements, while each
// line stays individually labeled. A field whose data value is an ARRAY
// of lines (utils/nameTagData.js's setupCleanupJobLabels returns
// setupCleanupDays that way) renders as one .badge-el-text box containing
// one .badge-el-text-inner span per line.
function multilineEl(overrides) {
  return {
    id: 'setup-cleanup-days', type: 'text', field: 'setupCleanupDays', x: 8, y: 4, width: 320, height: 32,
    fontSize: 10, color: '#1c2530', bold: true, align: 'left', valign: 'middle',
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

test('every line in a multi-line bound field starts from the SAME configured fontSize - badge-autofit.js\'s height correction shrinks them together in lockstep, not each to its own independent width estimate', () => {
  // A long Monday line and a short Wednesday placeholder - both should
  // start identically; it's public/js/badge-autofit.js's real-browser
  // height correction (verified live via Playwright separately) that
  // brings them down together if the long one ends up needing to wrap.
  const html = NameTagRenderCore.renderElement(
    multilineEl({ width: 100 }),
    { setupCleanupDays: ['Monday: Chairs & Tables, Snack Duty, Setup Crew', 'Wednesday: —'] }
  );
  const sizes = [...html.matchAll(/data-base-font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(sizes.length, 2, 'both lines should be marked for auto-fit');
  assert.deepEqual(sizes, [10, 10], 'both lines should start at the element\'s own configured fontSize, identically');
});

test('a single-string field (the normal case) is unaffected - still exactly one span, no flex-direction:column', () => {
  const html = NameTagRenderCore.renderElement(boundTextEl(), { name: 'Jessica Adema' });
  const spans = html.match(/<span class="badge-el-text-inner"/g) || [];
  assert.equal(spans.length, 1);
  assert.doesNotMatch(html, /flex-direction:column/);
});

// Coverage for a live bug report, screenshot: a longer single Admin
// Position ("Community Service Coordinator") wrapped onto 2-3 lines and
// got clipped at the box's own top edge - public/js/badge-autofit.js's
// real-browser height correction (already proven for 2+ actual stacked
// positions) is what keeps however many lines it wraps to inside the box,
// shrinking the font until they fit. Now the default for every bound
// field, admin position included.
function adminPositionEl(overrides) {
  return {
    id: 'position', type: 'text', field: 'adminPosition', x: 8, y: 110, width: 320, height: 40,
    fontSize: 16, color: '#1c2530', bold: false, align: 'center', valign: 'middle',
    ...overrides,
  };
}

test('the admin position field wraps (overflow-wrap: break-word) instead of forcing nowrap+ellipsis', () => {
  const html = NameTagRenderCore.renderElement(adminPositionEl(), { adminPosition: 'Community Service Coordinator' });
  assert.match(html, /overflow-wrap: break-word/);
  assert.doesNotMatch(html, /white-space: nowrap/);
  assert.doesNotMatch(html, /text-overflow: ellipsis/);
});

test('the admin position field is marked both data-autofit="1" and data-autofit-wrap="1"', () => {
  const html = NameTagRenderCore.renderElement(adminPositionEl(), { adminPosition: 'Community Service Coordinator' });
  assert.match(html, /data-autofit="1"/);
  assert.match(html, /data-autofit-wrap="1"/);
});

test('the admin position field starts from its own configured fontSize (not a single-line width estimate)', () => {
  const html = NameTagRenderCore.renderElement(adminPositionEl(), { adminPosition: 'Community Service Coordinator' });
  const m = /data-base-font-size="([\d.]+)"/.exec(html);
  assert.ok(m, 'data-base-font-size should still be present so badge-autofit.js has a value to reset to');
  assert.equal(Number(m[1]), 16, 'should be the box\'s own configured fontSize, not shrunk by a single-line width estimate');
});
