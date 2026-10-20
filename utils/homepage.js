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
};
