// Public Homepage block builder (Main Admin > Settings > Public Homepage)
// - a real request: "edit the entire homepage like you would on Spotify
// or wix. Drag and drop images and text of different size choices. Add
// buttons and links." homepage_blocks (supabase/migrations/
// 20261118010000_homepage_builder.sql) is an ordered list of blocks
// (text/image/button) rendered in order on the public homepage
// (views/public-home.ejs) between the fixed header and the Announcements/
// FAQ/CTA sections - those three stay driven by their own existing
// systems, unchanged.
const db = require('../db');
const { createStorageClient, publicUrl } = require('./storage');
const { formatFriendlyTimestamp } = require('./dates');
const { publicShowcaseClasses } = require('./classSchedule');

// Same local-disk-vs-Supabase-Storage shape as utils/events.js's own
// eventImageUrl - a bare key resolves to a Storage public URL when
// configured, or the local /uploads/homepage/<key> path otherwise.
const HOMEPAGE_IMAGES_BUCKET = 'homepage-images';
function homepageImageUrl(key) {
  if (!key) return null;
  return createStorageClient() ? publicUrl(HOMEPAGE_IMAGES_BUCKET, key) : `/uploads/homepage/${key}`;
}

async function listBlocks() {
  const blocks = await db.prepare('SELECT * FROM homepage_blocks ORDER BY position, id').all();
  for (const b of blocks) b.imageUrl = homepageImageUrl(b.image_key);
  return blocks;
}

async function getBlock(id) {
  const block = await db.prepare('SELECT * FROM homepage_blocks WHERE id = ?').get(id);
  if (block) block.imageUrl = homepageImageUrl(block.image_key);
  return block;
}

async function addBlock(data) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM homepage_blocks').get()).p) + 1;
  const info = await db
    .prepare(
      `INSERT INTO homepage_blocks (position, block_type, text_body, text_size, image_key, image_size, image_alt, button_label, button_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(position, data.blockType, data.textBody || null, data.textSize || null, data.imageKey || null, data.imageSize || null, data.imageAlt || null, data.buttonLabel || null, data.buttonUrl || null);
  return info.lastInsertRowid;
}

async function updateBlock(id, data) {
  await db
    .prepare(
      `UPDATE homepage_blocks SET
         text_body = ?, text_size = ?, image_key = ?, image_size = ?, image_alt = ?, button_label = ?, button_url = ?,
         updated_at = now_text()
       WHERE id = ?`
    )
    .run(data.textBody || null, data.textSize || null, data.imageKey || null, data.imageSize || null, data.imageAlt || null, data.buttonLabel || null, data.buttonUrl || null, id);
}

async function deleteBlock(id) {
  const block = await db.prepare('SELECT image_key FROM homepage_blocks WHERE id = ?').get(id);
  await db.prepare('DELETE FROM homepage_blocks WHERE id = ?').run(id);
  return block;
}

// Same "only ever the final on-screen order is sent" reorder shape as
// utils/events.js's own setEventSections/every other drag-reorder route
// in this app (public/js/lesson-drag-reorder.js's own comment).
async function reorderBlocks(blockIds) {
  await db.withTransaction(async (tx) => {
    for (let i = 0; i < blockIds.length; i++) {
      await tx.prepare('UPDATE homepage_blocks SET position = ? WHERE id = ?').run(i, blockIds[i]);
    }
  });
}

// Homepage Menu - a real request: "Should be able to edit or add menu
// tabs to the homepage." An ordered list of label+URL links shown in
// the public homepage's own header (views/public-home.ejs) - same
// ordered-list-managed-by-a-drag-canvas shape as homepage_blocks above,
// just a much simpler row (no block_type/text/image/button fields to
// branch on).
async function listMenuItems() {
  return db.prepare('SELECT * FROM homepage_menu_items ORDER BY position, id').all();
}

async function getMenuItem(id) {
  return db.prepare('SELECT * FROM homepage_menu_items WHERE id = ?').get(id);
}

async function addMenuItem({ label, url }) {
  const position = Number((await db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM homepage_menu_items').get()).p) + 1;
  const info = await db.prepare('INSERT INTO homepage_menu_items (position, label, url) VALUES (?, ?, ?)').run(position, label, url);
  return info.lastInsertRowid;
}

async function updateMenuItem(id, { label, url }) {
  await db.prepare('UPDATE homepage_menu_items SET label = ?, url = ?, updated_at = now_text() WHERE id = ?').run(label, url, id);
}

async function deleteMenuItem(id) {
  await db.prepare('DELETE FROM homepage_menu_items WHERE id = ?').run(id);
}

async function reorderMenuItems(menuItemIds) {
  await db.withTransaction(async (tx) => {
    for (let i = 0; i < menuItemIds.length; i++) {
      await tx.prepare('UPDATE homepage_menu_items SET position = ? WHERE id = ?').run(i, menuItemIds[i]);
    }
  });
}

// Homepage Theme Settings - a real request: "Main admin portal, settings
// gear, public homepage. Should have the exact webpage editing features
// as Shopify." Shopify keeps a handful of site-wide theme settings
// (colors, fonts, logo/favicon, announcement bar) separate from the
// page's own content blocks above - this is that settings row
// (homepage_theme_settings, supabase/migrations/
// 20261225010000_homepage_theme_settings.sql), one singleton row (id=1)
// for the whole co-op.

// Deliberately small (this app has no custom-font-upload infra, per a
// real constraint of this feature): 'open_sans'/'montserrat' are the two
// Google Fonts already loaded site-wide (views/partials/head.ejs), so
// picking them here adds no new network request; the rest are plain
// web-safe stacks every browser already has.
const FONT_CHOICES = [
  { key: 'system', label: 'System Default', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { key: 'open_sans', label: 'Open Sans', stack: "'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { key: 'montserrat', label: 'Montserrat', stack: "'Montserrat', 'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" },
  { key: 'georgia', label: 'Georgia (Serif)', stack: "Georgia, 'Times New Roman', serif" },
  { key: 'times', label: 'Times New Roman (Serif)', stack: "'Times New Roman', Times, serif" },
  { key: 'arial', label: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
];
const FONT_SIZE_BASE_PX = { small: '15px', medium: '16px', large: '18px' };

// Mirrors the migration's own column defaults exactly - used by both the
// "Reset theme to defaults" action and the form-validation fallbacks
// below, so there's exactly one place either could ever drift from the
// shipped migration.
const THEME_DEFAULTS = {
  colorPrimary: '#E7AA7B',
  colorAccent: '#79BAEC',
  colorBackground: '#FFFFFF',
  colorCards: '#FFFFFF',
  colorText: '#1C2530',
  fontHeading: 'montserrat',
  fontBody: 'open_sans',
  fontSizeBase: 'medium',
  announcementEnabled: false,
  announcementText: '',
};

function fontStack(key) {
  return (FONT_CHOICES.find((f) => f.key === key) || FONT_CHOICES[0]).stack;
}

function themeRowToObject(row) {
  return {
    colorPrimary: row.color_primary,
    colorAccent: row.color_accent,
    colorBackground: row.color_background,
    colorCards: row.color_cards,
    colorText: row.color_text,
    fontHeading: row.font_heading,
    fontBody: row.font_body,
    fontSizeBase: row.font_size_base,
    logoKey: row.logo_key,
    logoUrl: homepageImageUrl(row.logo_key),
    faviconKey: row.favicon_key,
    faviconUrl: homepageImageUrl(row.favicon_key),
    announcementEnabled: !!row.announcement_enabled,
    announcementText: row.announcement_text || '',
  };
}

async function getThemeSettings() {
  const row = await db.prepare('SELECT * FROM homepage_theme_settings WHERE id = 1').get();
  return themeRowToObject(row);
}

async function saveThemeSettings(data) {
  await db
    .prepare(
      `UPDATE homepage_theme_settings SET
         color_primary = ?, color_accent = ?, color_background = ?, color_cards = ?, color_text = ?,
         font_heading = ?, font_body = ?, font_size_base = ?,
         logo_key = ?, favicon_key = ?,
         announcement_enabled = ?, announcement_text = ?,
         updated_at = now_text()
       WHERE id = 1`
    )
    .run(
      data.colorPrimary,
      data.colorAccent,
      data.colorBackground,
      data.colorCards,
      data.colorText,
      data.fontHeading,
      data.fontBody,
      data.fontSizeBase,
      data.logoKey || null,
      data.faviconKey || null,
      data.announcementEnabled ? 1 : 0,
      data.announcementText || null
    );
}

// Reset theme to defaults - a real request: a confirm-gated action that
// "restores the global theme settings (colors/typography/logo/
// announcement bar) to their shipped defaults, leaving page content
// blocks untouched." Returns the row's PREVIOUS logo_key/favicon_key so
// the caller (routes/admin-website.js) can delete those now-orphaned
// uploaded files, same "caller deletes the file, this module only ever
// touches the row" split every other image-owning column in this module
// already uses.
async function resetThemeSettings() {
  const existing = await db.prepare('SELECT logo_key, favicon_key FROM homepage_theme_settings WHERE id = 1').get();
  await db
    .prepare(
      `UPDATE homepage_theme_settings SET
         color_primary = ?, color_accent = ?, color_background = ?, color_cards = ?, color_text = ?,
         font_heading = ?, font_body = ?, font_size_base = ?,
         logo_key = NULL, favicon_key = NULL,
         announcement_enabled = ?, announcement_text = NULL,
         updated_at = now_text()
       WHERE id = 1`
    )
    .run(
      THEME_DEFAULTS.colorPrimary,
      THEME_DEFAULTS.colorAccent,
      THEME_DEFAULTS.colorBackground,
      THEME_DEFAULTS.colorCards,
      THEME_DEFAULTS.colorText,
      THEME_DEFAULTS.fontHeading,
      THEME_DEFAULTS.fontBody,
      THEME_DEFAULTS.fontSizeBase,
      THEME_DEFAULTS.announcementEnabled ? 1 : 0
    );
  return existing;
}

// Live preview (Main Admin > Settings > Public Homepage's own Desktop/
// Mobile iframe) - a real request: "a live preview pane... which
// visibly updates as settings change." Rather than persisting a second
// "draft" copy of every theme field (a whole extra table/sync path to
// keep honest), routes/admin-website.js's own /preview route just
// overrides the SAVED theme with whatever fields are present on the
// query string for that one render - nothing is ever written to the
// database here, so the real saved site (this table, and the real
// /welcome route) is never touched by previewing. Logo/favicon can't
// travel over a query string, so previewing a chosen-but-not-yet-saved
// logo/favicon isn't supported - Save still works instantly for those
// two fields exactly like every other file upload in this app.
function withThemeOverrides(theme, query) {
  if (!query) return theme;
  const next = { ...theme };
  for (const key of ['colorPrimary', 'colorAccent', 'colorBackground', 'colorCards', 'colorText']) {
    if (typeof query[key] === 'string' && /^#[0-9a-fA-F]{6}$/.test(query[key])) next[key] = query[key];
  }
  if (typeof query.fontHeading === 'string' && FONT_CHOICES.some((f) => f.key === query.fontHeading)) next.fontHeading = query.fontHeading;
  if (typeof query.fontBody === 'string' && FONT_CHOICES.some((f) => f.key === query.fontBody)) next.fontBody = query.fontBody;
  if (typeof query.fontSizeBase === 'string' && FONT_SIZE_BASE_PX[query.fontSizeBase]) next.fontSizeBase = query.fontSizeBase;
  if (typeof query.announcementEnabled === 'string') next.announcementEnabled = query.announcementEnabled === '1';
  if (typeof query.announcementText === 'string') next.announcementText = query.announcementText;
  return next;
}

// Built once per render and dropped straight into the public homepage's
// own <body style="..."> (views/public-home.ejs) - every value here is
// either hex-validated (saveThemeSettings/withThemeOverrides above) or
// drawn from this module's own FONT_CHOICES list, never raw admin text,
// so this is safe to interpolate unescaped into a style attribute.
function themeStyleAttr(theme) {
  const vars = {
    '--hp-primary': theme.colorPrimary,
    '--hp-accent': theme.colorAccent,
    '--hp-background': theme.colorBackground,
    '--hp-cards': theme.colorCards,
    '--hp-text': theme.colorText,
    '--hp-font-heading': fontStack(theme.fontHeading),
    '--hp-font-body': fontStack(theme.fontBody),
    '--hp-font-size-base': FONT_SIZE_BASE_PX[theme.fontSizeBase] || FONT_SIZE_BASE_PX.medium,
  };
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

// Shared by routes/public-site.js's real /welcome page and
// routes/admin-website.js's own /preview route - the exact same content
// (blocks, menu, showcase classes, public announcements/FAQs) renders
// under both, so this is the one place that data gets assembled instead
// of two copies drifting apart.
async function loadPublicPageData() {
  const announcementRows = await db
    .prepare("SELECT * FROM announcements WHERE is_public = 1 AND (expires_at IS NULL OR expires_at > now_text()) ORDER BY published_at DESC LIMIT 3")
    .all();
  const announcements = announcementRows.map((a) => ({ ...a, publishedLabel: formatFriendlyTimestamp(a.published_at) }));
  const faqs = await db.prepare('SELECT * FROM faqs WHERE is_public = 1 ORDER BY position, id').all();
  const blocks = await listBlocks();
  const menuItems = await listMenuItems();
  const showcaseClasses = (await publicShowcaseClasses()).map((c) => ({
    ...c,
    timeLabel: c.startTime ? c.startTime + (c.endTime ? ` – ${c.endTime}` : '') : null,
  }));
  return { announcements, faqs, blocks, menuItems, showcaseClasses };
}

module.exports = {
  HOMEPAGE_IMAGES_BUCKET,
  homepageImageUrl,
  listBlocks,
  getBlock,
  addBlock,
  updateBlock,
  deleteBlock,
  reorderBlocks,
  listMenuItems,
  getMenuItem,
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  reorderMenuItems,
  FONT_CHOICES,
  THEME_DEFAULTS,
  getThemeSettings,
  saveThemeSettings,
  resetThemeSettings,
  withThemeOverrides,
  themeStyleAttr,
  loadPublicPageData,
};
