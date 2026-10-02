// A real bug report: "communication page, mobile, orange menu bar at the
// bottom disappears when scrolling the page." The bottom bar
// (.admin-mobile-tabs) already carries a forced-compositing-layer
// hardening for this exact "iOS Safari drops a persistently-positioned
// element mid-scroll" bug, first reported on Chat - but the sticky TOP
// bar (.admin-mobile-topbar) never got the same treatment, leaving one
// persistently-positioned element on the page still able to trigger it
// on a page with enough content to genuinely scroll (Communication's own
// rich-text announcement editor). Static CSS-content check only (no
// Playwright devDependency here to drive a real WebKit compositing bug -
// see printCss.test.js's own note) - keeps the specific fix from quietly
// regressing back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rawCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

test('.admin-mobile-topbar is hardened onto its own compositing layer, same as .admin-mobile-tabs already is', () => {
  // .admin-mobile-topbar also has an earlier, unrelated desktop-default
  // rule (`{ display: none; }`) outside the mobile media query - this
  // test needs the real, mobile one, inside @media (max-width: 860px).
  const mobileBlockStart = css.indexOf('@media (max-width: 860px)');
  assert.ok(mobileBlockStart >= 0, 'expected the mobile nav media query');
  const mobileBlock = css.slice(mobileBlockStart);

  const topbarMatch = /\.admin-mobile-topbar\s*\{([^}]*)\}/.exec(mobileBlock);
  assert.ok(topbarMatch, 'expected the mobile .admin-mobile-topbar rule');
  assert.match(topbarMatch[1], /transform:\s*translateZ\(0\)/, '.admin-mobile-topbar must be forced onto its own compositing layer');
  assert.match(topbarMatch[1], /backface-visibility:\s*hidden/);

  const tabsMatch = /\.admin-mobile-tabs\s*\{([^}]*)\}/.exec(mobileBlock);
  assert.ok(tabsMatch, 'expected the .admin-mobile-tabs rule this test mirrors');
  assert.match(tabsMatch[1], /transform:\s*translateZ\(0\)/, 'the bottom bar\'s own existing hardening must still be in place');
});
