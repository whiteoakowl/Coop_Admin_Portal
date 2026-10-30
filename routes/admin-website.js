// Main Admin's own Public Homepage builder - mounted at
// /main-admin/website (server.js, same URL the old plain Website
// settings page used, kept so no existing bookmark/link breaks). A real
// request: "Settings gear, website. Should say public homepage. Here you
// can edit the entire homepage like you would on Spotify or wix. Drag
// and drop images and text of different size choices. Add buttons and
// links." Replaces the old single "Homepage Content" form (one textarea
// per fixed Hero/About/Benefits section) with homepage_blocks - an
// ordered list of text/image/button blocks the admin can add, edit,
// delete, and drag-reorder freely (views/main-admin-website.ejs). The
// public homepage (views/public-home.ejs, routes/public-site.js) renders
// them in that same order.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requirePortalPermission } = require('../middleware/portalAuth');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, deleteFile, generateKey } = require('../utils/storage');
const homepage = require('../utils/homepage');

router.use(requirePortalPermission('manage_website'));

const HOMEPAGE_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'homepage');
if (!createStorageClient() && !fs.existsSync(HOMEPAGE_IMAGE_DIR)) {
  try {
    fs.mkdirSync(HOMEPAGE_IMAGE_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${HOMEPAGE_IMAGE_DIR}:`, err.message);
  }
}

// Same real bug class as routes/admin-events.js's own uploadEventImage -
// an over-limit file makes upload.single() itself throw a MulterError
// before any route handler runs, which would otherwise fall through to
// the generic 500 page instead of a friendly redirect.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });
function uploadBlockImage(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect('/main-admin/website?error=' + encodeURIComponent(`That image is too large - images are limited to ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`));
    }
    next(err);
  });
}

// Shared by Add Block and Edit Block - stores a new file (if one was
// chosen) and deletes whatever the block's own previous image_key was,
// same "store this file, delete the old one, return the new key" shape
// as routes/admin-events.js's own saveEventImage. Returns the existing
// key unchanged when no new file was chosen (editing a text/button block,
// or an image block whose photo isn't being replaced).
async function saveBlockImageIfProvided(file, existingKey) {
  if (!file) return existingKey || null;
  const client = createStorageClient();
  let key;
  if (client) {
    key = await uploadFile(client, homepage.HOMEPAGE_IMAGES_BUCKET, file.buffer, file.originalname, file.mimetype);
  } else {
    key = generateKey(file.originalname);
    fs.writeFileSync(path.join(HOMEPAGE_IMAGE_DIR, key), file.buffer);
  }
  if (existingKey) {
    if (client) await deleteFile(client, homepage.HOMEPAGE_IMAGES_BUCKET, existingKey);
    else {
      const oldPath = path.join(HOMEPAGE_IMAGE_DIR, existingKey);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
  }
  return key;
}

async function deleteBlockImageFile(key) {
  if (!key) return;
  const client = createStorageClient();
  if (client) return deleteFile(client, homepage.HOMEPAGE_IMAGES_BUCKET, key);
  const oldPath = path.join(HOMEPAGE_IMAGE_DIR, key);
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
}

router.get('/', async (req, res) => {
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const blocks = await homepage.listBlocks();
  const menuItems = await homepage.listMenuItems();
  const theme = await homepage.getThemeSettings();
  res.render('main-admin-website', {
    title: 'Public Homepage',
    settings,
    blocks,
    menuItems,
    theme,
    fontChoices: homepage.FONT_CHOICES,
    notice: req.query.notice || null,
    error: req.query.error || null,
  });
});

// Live preview pane (views/main-admin-website.ejs's own iframe) - a real
// request: "a live preview pane on the right showing the actual
// rendered homepage... which visibly updates as settings change."
// Renders the exact same public-home template/content the real
// /welcome route does, but with the SAVED theme overridden by whatever
// theme fields are present on the query string (homepage.withThemeOverrides)
// - nothing here ever reads req.body or writes to the database, so an
// admin fiddling with colors before hitting Save never affects the real
// public site. noindex since this is never meant to be a second public
// URL for the homepage, just this editor's own preview frame.
router.get('/preview', async (req, res) => {
  const settings = await db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const savedTheme = await homepage.getThemeSettings();
  const theme = homepage.withThemeOverrides(savedTheme, req.query);
  const pageData = await homepage.loadPublicPageData();
  res.set('X-Robots-Tag', 'noindex');
  res.render('public-home', {
    title: settings.org_name,
    settings,
    theme,
    themeStyle: homepage.themeStyleAttr(theme),
    isPreview: true,
    ...pageData,
  });
});

// Org Name/Contact Email/Contact Phone - the only homepage-related fields
// that AREN'T a drag-and-drop block, since the header/footer that
// actually render them are fixed chrome around the block canvas, not
// content a block could be dragged into or out of. Tagline and the old
// Hero/About/Benefits fields are no longer read here - views/main-admin-
// website.ejs has no inputs for them any more (tagline never rendered
// anywhere on the public site even before this; the rest moved to
// homepage_blocks, seeded there once by this feature's own migration) -
// same "retired but not dropped column" treatment as any other column a
// form stops touching elsewhere in this app.
router.post('/settings', async (req, res) => {
  await db
    .prepare('UPDATE site_settings SET org_name = ?, contact_email = ?, contact_phone = ?, updated_at = now_text() WHERE id = 1')
    .run((req.body.org_name || '').trim(), (req.body.contact_email || '').trim(), (req.body.contact_phone || '').trim());
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Site info saved.'));
});

// Theme Settings (Colors/Typography/Logo & Favicon/Announcement Bar) - a
// real request: "Should have the exact webpage editing features as
// Shopify." logo + favicon share one multipart form with the color/font/
// announcement fields (both optional - most saves touch neither file),
// same MAX_IMAGE_BYTES/imageFileFilter guard as uploadBlockImage above.
const themeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES }, fileFilter: imageFileFilter });
function uploadThemeImages(req, res, next) {
  themeUpload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'favicon', maxCount: 1 },
  ])(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.redirect('/main-admin/website?error=' + encodeURIComponent(`That image is too large - images are limited to ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`));
    }
    next(err);
  });
}

function themeDataFromBody(body) {
  const hex = (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(value || '') ? value : fallback);
  const font = (value, fallback) => (homepage.FONT_CHOICES.some((f) => f.key === value) ? value : fallback);
  return {
    colorPrimary: hex(body.colorPrimary, homepage.THEME_DEFAULTS.colorPrimary),
    colorAccent: hex(body.colorAccent, homepage.THEME_DEFAULTS.colorAccent),
    colorBackground: hex(body.colorBackground, homepage.THEME_DEFAULTS.colorBackground),
    colorCards: hex(body.colorCards, homepage.THEME_DEFAULTS.colorCards),
    colorText: hex(body.colorText, homepage.THEME_DEFAULTS.colorText),
    fontHeading: font(body.fontHeading, homepage.THEME_DEFAULTS.fontHeading),
    fontBody: font(body.fontBody, homepage.THEME_DEFAULTS.fontBody),
    fontSizeBase: ['small', 'medium', 'large'].includes(body.fontSizeBase) ? body.fontSizeBase : homepage.THEME_DEFAULTS.fontSizeBase,
    announcementEnabled: body.announcementEnabled === 'on' || body.announcementEnabled === '1',
    announcementText: (body.announcementText || '').trim(),
  };
}

router.post('/theme-settings', uploadThemeImages, async (req, res) => {
  const existing = await homepage.getThemeSettings();
  const data = themeDataFromBody(req.body);
  const logoFile = req.files && req.files.logo && req.files.logo[0];
  const faviconFile = req.files && req.files.favicon && req.files.favicon[0];
  data.logoKey = await saveBlockImageIfProvided(logoFile, existing.logoKey);
  data.faviconKey = await saveBlockImageIfProvided(faviconFile, existing.faviconKey);
  await homepage.saveThemeSettings(data);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Theme settings saved.'));
});

// Reset theme to defaults - a real request: a confirm-gated action
// (views/main-admin-website.ejs's own data-confirm) that "restores the
// global theme settings... to their shipped defaults, leaving page
// content blocks untouched." homepage_blocks/homepage_menu_items are
// never touched here - only the one homepage_theme_settings row.
router.post('/theme-settings/reset', async (req, res) => {
  const old = await homepage.resetThemeSettings();
  if (old) {
    await deleteBlockImageFile(old.logo_key);
    await deleteBlockImageFile(old.favicon_key);
  }
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Theme reset to defaults.'));
});

function blockDataFromBody(body) {
  return {
    blockType: body.blockType,
    textBody: (body.textBody || '').trim(),
    textSize: ['small', 'medium', 'large'].includes(body.textSize) ? body.textSize : 'medium',
    imageSize: ['small', 'medium', 'large', 'full'].includes(body.imageSize) ? body.imageSize : 'medium',
    imageAlt: (body.imageAlt || '').trim(),
    buttonLabel: (body.buttonLabel || '').trim(),
    buttonUrl: (body.buttonUrl || '').trim(),
  };
}

router.post('/blocks', uploadBlockImage, async (req, res) => {
  const data = blockDataFromBody(req.body);
  if (data.blockType === 'image') data.imageKey = await saveBlockImageIfProvided(req.file, null);
  await homepage.addBlock(data);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Block added.'));
});

router.post('/blocks/:id/update', uploadBlockImage, async (req, res) => {
  const id = req.params.id;
  const existing = await homepage.getBlock(id);
  if (!existing) return res.status(404).render('404', { title: 'Not Found' });
  const data = blockDataFromBody({ ...req.body, blockType: existing.block_type });
  if (existing.block_type === 'image') data.imageKey = await saveBlockImageIfProvided(req.file, existing.image_key);
  await homepage.updateBlock(id, data);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Block saved.'));
});

router.post('/blocks/:id/delete', async (req, res) => {
  const deleted = await homepage.deleteBlock(req.params.id);
  if (deleted) await deleteBlockImageFile(deleted.image_key);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Block removed.'));
});

// Drag-reorder, AJAX - same "only ever the final on-screen order is sent"
// shape as public/js/lesson-drag-reorder.js's own reorder endpoints.
router.post('/blocks/reorder', express.json(), async (req, res) => {
  const blockIds = [].concat(req.body.blockIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await homepage.reorderBlocks(blockIds);
  res.json({ ok: true });
});

// Homepage Menu - a real request: "Should be able to edit or add menu
// tabs to the homepage." A plain label+URL row, reusing the exact same
// drag-reorder mechanism (public/js/homepage-block-reorder.js is generic
// over any container/row carrying its own data-homepage-block-row/
// data-homepage-blocks-container attributes - menu rows just point their
// own data-reorder-url at this route instead of /blocks/reorder).
router.post('/menu-items', async (req, res) => {
  const label = (req.body.label || '').trim();
  const url = (req.body.url || '').trim();
  if (!label || !url) return res.redirect('/main-admin/website?error=' + encodeURIComponent('A label and a URL are required.'));
  await homepage.addMenuItem({ label, url });
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Menu tab added.'));
});

router.post('/menu-items/:id/update', async (req, res) => {
  const existing = await homepage.getMenuItem(req.params.id);
  if (!existing) return res.status(404).render('404', { title: 'Not Found' });
  const label = (req.body.label || '').trim();
  const url = (req.body.url || '').trim();
  if (!label || !url) return res.redirect('/main-admin/website?error=' + encodeURIComponent('A label and a URL are required.'));
  await homepage.updateMenuItem(req.params.id, { label, url });
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Menu tab saved.'));
});

router.post('/menu-items/:id/delete', async (req, res) => {
  await homepage.deleteMenuItem(req.params.id);
  res.redirect('/main-admin/website?notice=' + encodeURIComponent('Menu tab removed.'));
});

router.post('/menu-items/reorder', express.json(), async (req, res) => {
  const menuItemIds = [].concat(req.body.blockIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  await homepage.reorderMenuItems(menuItemIds);
  res.json({ ok: true });
});

module.exports = router;
