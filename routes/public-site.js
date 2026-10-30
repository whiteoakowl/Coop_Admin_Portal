// The public marketing homepage - a separate front door for prospective
// and current families, distinct from the kiosk and the operational
// Co-op Admin Portal. Mounted at /welcome, not the site root - a real
// request: "homepage should still be kiosk screen for now" (see server.js's
// own note on that). Read-only for everyone; Main Admin edits the
// underlying site_settings/announcements/faqs rows from /main-admin/website.
const express = require('express');
const router = express.Router();
const db = require('../db');
const homepage = require('../utils/homepage');

router.get('/', async (req, res) => {
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  // A real request: "Should have the exact webpage editing features as
  // Shopify." theme (homepage_theme_settings, utils/homepage.js) holds
  // the site-wide colors/fonts/logo/favicon/announcement-bar settings an
  // admin picks once from Main Admin > Settings > Public Homepage - its
  // own data is separate from the page's content blocks below, same
  // split Shopify's own theme editor makes. loadPublicPageData is the
  // exact same content-loading this route always did, just pulled into
  // utils/homepage.js so routes/admin-website.js's own /preview route
  // (same admin screen's live preview pane) can render identically
  // without a second, drifting copy of this query logic.
  const theme = await homepage.getThemeSettings();
  const pageData = await homepage.loadPublicPageData();

  res.render('public-home', {
    title: settings.org_name,
    settings,
    theme,
    themeStyle: homepage.themeStyleAttr(theme),
    isPreview: false,
    ...pageData,
  });
});

module.exports = router;
