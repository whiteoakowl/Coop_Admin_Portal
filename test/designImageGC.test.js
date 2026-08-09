// Real unit + integration coverage for the design-image garbage
// collector (see utils/designImageGC.js's own comment for why a sweep,
// not a diff, is the right approach here).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Both overridable the same way db/index.js's DB_PATH and
// utils/backup.js's UPLOADS_DIR already are - point them at private,
// throwaway locations so this test never touches whatever
// data/attendance.db or public/uploads/ a developer or CI run already
// has.
const testDbPath = path.join(os.tmpdir(), `design-gc-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `design-gc-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;

const { referencedImagePaths, sweepNameTagImages, sweepScheduleCardImages } = require('../utils/designImageGC');
const db = require('../db');

const nameTagDir = path.join(testUploadsDir, 'name-tags');
const scheduleCardDir = path.join(testUploadsDir, 'schedule-cards');

function writeUpload(dir, filename, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content);
}

test('referencedImagePaths', async (t) => {
  await t.test('finds image srcs in the current { background, elements } shape', () => {
    const layout = JSON.stringify({
      background: '#ffffff',
      elements: [
        { id: 'a', type: 'text' },
        { id: 'b', type: 'image', src: '/uploads/name-tags/one.jpg' },
        { id: 'c', type: 'image', src: '/uploads/name-tags/two.png' },
      ],
    });
    const refs = referencedImagePaths([layout]);
    assert.deepEqual([...refs].sort(), ['/uploads/name-tags/one.jpg', '/uploads/name-tags/two.png']);
  });

  await t.test('finds image srcs in the older bare elements-array shape', () => {
    const layout = JSON.stringify([{ id: 'a', type: 'image', src: '/uploads/name-tags/legacy.jpg' }]);
    assert.deepEqual([...referencedImagePaths([layout])], ['/uploads/name-tags/legacy.jpg']);
  });

  await t.test('ignores non-image elements and elements with no src', () => {
    const layout = JSON.stringify({
      elements: [{ type: 'text' }, { type: 'shape' }, { type: 'image' }, { type: 'image', src: '' }],
    });
    assert.deepEqual([...referencedImagePaths([layout])], []);
  });

  await t.test('skips an unparseable row rather than throwing or treating it as empty', () => {
    const good = JSON.stringify({ elements: [{ type: 'image', src: '/uploads/name-tags/keep.jpg' }] });
    assert.deepEqual([...referencedImagePaths(['not json', good])], ['/uploads/name-tags/keep.jpg']);
  });

  await t.test('de-duplicates the same image referenced by more than one layout', () => {
    const layout = JSON.stringify({ elements: [{ type: 'image', src: '/uploads/name-tags/shared.jpg' }] });
    assert.deepEqual([...referencedImagePaths([layout, layout])], ['/uploads/name-tags/shared.jpg']);
  });
});

test('sweepNameTagImages / sweepScheduleCardImages', async (t) => {
  t.after(() => {
    fs.rmSync(testUploadsDir, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${testDbPath}${suffix}`, { force: true });
  });

  await t.test('keeps a referenced image and removes an unreferenced one (name tags + misc badges share this directory)', () => {
    writeUpload(nameTagDir, 'kept.jpg', 'kept');
    writeUpload(nameTagDir, 'orphan.jpg', 'orphan');

    db.prepare(
      "INSERT INTO name_tag_templates (member_type, layout_json) VALUES ('student', ?) ON CONFLICT(member_type) DO UPDATE SET layout_json = excluded.layout_json"
    ).run(JSON.stringify({ elements: [{ type: 'image', src: '/uploads/name-tags/kept.jpg' }] }));
    // A misc badge template referencing nothing shouldn't matter to
    // whether the OTHER type's referenced image survives - both need
    // scanning together, not just whichever one was just saved.
    db.prepare(
      "INSERT INTO misc_badge_templates (badge_type, layout_json) VALUES ('setupCleanup', ?) ON CONFLICT(badge_type) DO UPDATE SET layout_json = excluded.layout_json"
    ).run(JSON.stringify({ elements: [] }));

    sweepNameTagImages();

    assert.equal(fs.existsSync(path.join(nameTagDir, 'kept.jpg')), true);
    assert.equal(fs.existsSync(path.join(nameTagDir, 'orphan.jpg')), false);
  });

  await t.test('an image referenced by a misc badge template (not a name tag one) still survives', () => {
    writeUpload(nameTagDir, 'badge-image.jpg', 'badge image');
    db.prepare("UPDATE misc_badge_templates SET layout_json = ? WHERE badge_type = 'setupCleanup'").run(
      JSON.stringify({ elements: [{ type: 'image', src: '/uploads/name-tags/badge-image.jpg' }] })
    );

    sweepNameTagImages();

    assert.equal(fs.existsSync(path.join(nameTagDir, 'badge-image.jpg')), true);
  });

  await t.test('schedule card images are swept independently of the name tag directory', () => {
    writeUpload(scheduleCardDir, 'kept.jpg', 'kept');
    writeUpload(scheduleCardDir, 'orphan.jpg', 'orphan');

    db.prepare(
      "INSERT INTO schedule_card_templates (id, layout_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET layout_json = excluded.layout_json"
    ).run(JSON.stringify({ elements: [{ type: 'image', src: '/uploads/schedule-cards/kept.jpg' }] }));

    sweepScheduleCardImages();

    assert.equal(fs.existsSync(path.join(scheduleCardDir, 'kept.jpg')), true);
    assert.equal(fs.existsSync(path.join(scheduleCardDir, 'orphan.jpg')), false);
    // The name-tags/ file from the previous sub-tests should be
    // untouched by a sweep of the (separate) schedule-cards/ directory.
    assert.equal(fs.existsSync(path.join(nameTagDir, 'badge-image.jpg')), true);
  });
});
