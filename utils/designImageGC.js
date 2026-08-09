// Cleans up uploaded design background images (name tags, misc badges,
// schedule cards) once a layout stops referencing them - a layout can be
// edited to remove or replace an image element any number of times, with
// no simple "old path -> new path" transition to hook cleanup onto the
// way member photos have (see routes/admin-members.js's deletePhotoFile).
// Instead this re-derives, from scratch, every image path any *current*
// layout still references, and removes anything left over in the upload
// directory that isn't one of them - a sweep, not a diff.
const fs = require('fs');
const path = require('path');
const db = require('../db');

// Extracts every image element's `src` across a set of saved layouts,
// tolerating both shapes layout_json has ever been stored in: the
// current { background, elements } object, and an older bare elements
// array (see utils/nameTagData.js's own normalization for why both
// exist). An unparseable row is skipped, not treated as "references
// nothing" - a transient bad row should never cause a sweep to delete
// images a normal row right next to it still needs.
function referencedImagePaths(layoutJsonRows) {
  const referenced = new Set();
  for (const layoutJson of layoutJsonRows) {
    let parsed;
    try {
      parsed = JSON.parse(layoutJson);
    } catch (err) {
      continue;
    }
    const elements = Array.isArray(parsed) ? parsed : parsed && parsed.elements;
    if (!Array.isArray(elements)) continue;
    for (const el of elements) {
      // A falsy src (missing, or '') is the app's own established "no
      // image placed yet" state for an image element - see
      // public/js/name-tag-render-core.js's renderImageEl, which renders
      // an empty placeholder box for exactly this case rather than an
      // <img>. Adding '' to the referenced set here would make it look
      // like a file literally named '' is still in use and can never be
      // swept, which is never actually true.
      if (el && el.type === 'image' && el.src) referenced.add(el.src);
    }
  }
  return referenced;
}

// Deletes every file directly under `dir` whose web path
// (`${urlPrefix}/filename`) isn't in `referenced`. Never touches a
// directory that doesn't exist yet (nothing uploaded there), and only
// ever looks at files, not any nested structure - these directories are
// flat, multer-generated-filename uploads.
function sweepUnreferencedImages(dir, urlPrefix, referenced) {
  if (!fs.existsSync(dir)) return;
  for (const filename of fs.readdirSync(dir)) {
    const filePath = path.join(dir, filename);
    if (!fs.statSync(filePath).isFile()) continue;
    if (!referenced.has(`${urlPrefix}/${filename}`)) fs.rmSync(filePath, { force: true });
  }
}

// UPLOADS_DIR is overridable the same way utils/backup.js's own copy of
// it is (same env var, so a test overriding one overrides both) - so
// tests never touch the real public/uploads/ directories.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
const NAME_TAG_DIR = path.join(UPLOADS_DIR, 'name-tags');
const SCHEDULE_CARD_DIR = path.join(UPLOADS_DIR, 'schedule-cards');

// name_tag_templates (student/parent) and misc_badge_templates
// (setupCleanup/custom) share one upload directory and editor (see
// admin-name-tag.js's shared POST /name-tag/design-image route) - both
// need scanning together before sweeping it, or an image still used by
// one type would look unreferenced and get deleted because only the
// other type's templates were checked.
function sweepNameTagImages() {
  const nameTagRows = db.prepare('SELECT layout_json FROM name_tag_templates').all().map((r) => r.layout_json);
  const miscBadgeRows = db.prepare('SELECT layout_json FROM misc_badge_templates').all().map((r) => r.layout_json);
  sweepUnreferencedImages(NAME_TAG_DIR, '/uploads/name-tags', referencedImagePaths([...nameTagRows, ...miscBadgeRows]));
}

function sweepScheduleCardImages() {
  const rows = db.prepare('SELECT layout_json FROM schedule_card_templates').all().map((r) => r.layout_json);
  sweepUnreferencedImages(SCHEDULE_CARD_DIR, '/uploads/schedule-cards', referencedImagePaths(rows));
}

module.exports = { sweepNameTagImages, sweepScheduleCardImages, referencedImagePaths };
