// Coverage for a real request: "Be able to upload images or documents
// to daily learning log on under the family school management tab."
// (utils/familySchool.js's own attachmentsForJournalEntry/
// addJournalAttachment/deleteJournalAttachment, routes/parent-family-
// school.js's own journal routes.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `fs-journal-attachments-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `fs-journal-attachments-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');

test.before(() => app.ready);
const db = require('../db');

test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

let counter = 0;
async function createFamily(name) {
  counter += 1;
  return (await db.prepare('INSERT INTO families (name) VALUES (?) RETURNING id').get(`${name} ${counter}`)).id;
}

async function createPortalMember({ name, familyId, memberType, roleKey }) {
  counter += 1;
  const code = `fsjournal${counter}`;
  const memberId = (
    await db
      .prepare("INSERT INTO members (name, barcode, member_code, member_type, family_id, is_primary_parent, active) VALUES (?, ?, ?, ?, ?, ?, 1) RETURNING id")
      .get(name, code, code, memberType, familyId, memberType === 'parent' ? 1 : 0)
  ).id;
  const { hashPassword } = require('../utils/portalAuth');
  const email = `${code}@example.com`;
  const accountId = (
    await db
      .prepare("INSERT INTO member_accounts (member_id, email, password_hash, status, approved_at) VALUES (?, ?, ?, 'active', now_text()) RETURNING id")
      .get(memberId, email, hashPassword('testpassword123'))
  ).id;
  const role = await db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  await db.prepare('INSERT INTO member_account_roles (member_account_id, role_id) VALUES (?, ?)').run(accountId, role.id);
  const loginRes = await request(app).post('/login').type('form').send({ email, password: 'testpassword123', next: `/${roleKey}` });
  return { memberId, accountId, cookie: loginRes.headers['set-cookie'] };
}

async function csrfFrom(cookie, url) {
  const page = await request(app).get(url).set('Cookie', cookie);
  return /name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

// A real bug report: "I wrote an entry and clicked save. It then said
// write something first and didn't save." Root cause: this page's own
// rich-text editor (data-forum-editor/data-forum-editable) never
// included its backing public/js/forum-editor.js script - every other
// page using that same editor (e.g. views/forums-new-thread.ejs) adds
// this tag itself, since partials/forum-editor-toolbar.ejs deliberately
// doesn't load it for every caller. Without it, nothing ever synced the
// typed text into the hidden #body input the form actually submits, so
// the server always saw an empty body. A plain markup check, not a
// browser-driven typing simulation (this whole test suite is
// supertest-only, no client JS execution) - this regresses the exact
// missing <script> tag that caused the bug.
test('Daily Learning Log includes forum-editor.js, so typed text actually syncs into the submitted body', async () => {
  const familyId = await createFamily('Journal Editor Script Family');
  const parent = await createPortalMember({ name: 'Journal Editor Script Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const page = await request(app).get('/parent/family-school/journal').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<script src="\/js\/forum-editor\.js"><\/script>/);
});

test('a parent can attach an image and a document to a new journal entry, and both show up on the log', async () => {
  const familyId = await createFamily('Journal Attachments Family');
  const parent = await createPortalMember({ name: 'Journal Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Journal Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/journal');

  const res = await request(app)
    .post('/parent/family-school/journal?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('studentId', String(student.memberId))
    .field('entryDate', '2026-06-01')
    .field('body', '<p>Great day of learning.</p>')
    .field('_csrf', csrf)
    .attach('attachments', PNG_1X1, { filename: 'artwork.png', contentType: 'image/png' })
    .attach('attachments', Buffer.from('%PDF-1.4 fake pdf contents'), { filename: 'worksheet.pdf', contentType: 'application/pdf' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /notice=/);

  const page = await request(app).get(`/parent/family-school/journal?studentId=${student.memberId}`).set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /<img src="[^"]+" alt="artwork\.png" class="fs-journal-attachment-image"/);
  assert.match(page.text, /worksheet\.pdf/);

  const entry = await db.prepare('SELECT id FROM family_school_journal_entries WHERE student_id = ?').get(student.memberId);
  const attachments = await db.prepare('SELECT * FROM family_school_journal_attachments WHERE journal_entry_id = ? ORDER BY id').all(entry.id);
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].file_name, 'artwork.png');
  assert.equal(attachments[0].content_type, 'image/png');
  assert.equal(attachments[1].file_name, 'worksheet.pdf');
});

test('deleting one attachment removes only that one, leaving the entry and its other attachment intact', async () => {
  const familyId = await createFamily('Journal Delete Family');
  const parent = await createPortalMember({ name: 'Delete Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Delete Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/family-school/journal');

  await request(app)
    .post('/parent/family-school/journal?_csrf=' + encodeURIComponent(csrf))
    .set('Cookie', parent.cookie)
    .field('studentId', String(student.memberId))
    .field('entryDate', '2026-06-02')
    .field('body', '<p>Field trip day.</p>')
    .field('_csrf', csrf)
    .attach('attachments', PNG_1X1, { filename: 'photo1.png', contentType: 'image/png' })
    .attach('attachments', PNG_1X1, { filename: 'photo2.png', contentType: 'image/png' });

  const entry = await db.prepare('SELECT id FROM family_school_journal_entries WHERE student_id = ?').get(student.memberId);
  const [first, second] = await db.prepare('SELECT * FROM family_school_journal_attachments WHERE journal_entry_id = ? ORDER BY id').all(entry.id);

  const deleteCsrf = await csrfFrom(parent.cookie, '/parent/family-school/journal');
  const del = await request(app)
    .post(`/parent/family-school/journal/${entry.id}/attachments/${first.id}/delete`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ _csrf: deleteCsrf });
  assert.equal(del.status, 302);

  const remaining = await db.prepare('SELECT * FROM family_school_journal_attachments WHERE journal_entry_id = ?').all(entry.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, second.id);

  const stillHasEntry = await db.prepare('SELECT * FROM family_school_journal_entries WHERE id = ?').get(entry.id);
  assert.ok(stillHasEntry, 'the journal entry itself should still exist');
});

test('a parent from a different family cannot delete another family\'s journal attachment', async () => {
  const ownFamilyId = await createFamily('Owner Family');
  const owner = await createPortalMember({ name: 'Owner Parent', familyId: ownFamilyId, memberType: 'parent', roleKey: 'parent' });
  const ownStudent = await createPortalMember({ name: 'Owner Student', familyId: ownFamilyId, memberType: 'student', roleKey: 'student' });
  const ownCsrf = await csrfFrom(owner.cookie, '/parent/family-school/journal');
  await request(app)
    .post('/parent/family-school/journal?_csrf=' + encodeURIComponent(ownCsrf))
    .set('Cookie', owner.cookie)
    .field('studentId', String(ownStudent.memberId))
    .field('entryDate', '2026-06-03')
    .field('body', '<p>Private entry.</p>')
    .field('_csrf', ownCsrf)
    .attach('attachments', PNG_1X1, { filename: 'private.png', contentType: 'image/png' });

  const entry = await db.prepare('SELECT id FROM family_school_journal_entries WHERE student_id = ?').get(ownStudent.memberId);
  const attachment = await db.prepare('SELECT id FROM family_school_journal_attachments WHERE journal_entry_id = ?').get(entry.id);

  const intruderFamilyId = await createFamily('Intruder Family');
  const intruder = await createPortalMember({ name: 'Intruder Parent', familyId: intruderFamilyId, memberType: 'parent', roleKey: 'parent' });
  const intruderCsrf = await csrfFrom(intruder.cookie, '/parent/family-school/journal');

  const res = await request(app)
    .post(`/parent/family-school/journal/${entry.id}/attachments/${attachment.id}/delete`)
    .set('Cookie', intruder.cookie)
    .type('form')
    .send({ _csrf: intruderCsrf });
  assert.equal(res.status, 404);

  const stillThere = await db.prepare('SELECT * FROM family_school_journal_attachments WHERE id = ?').get(attachment.id);
  assert.ok(stillThere, 'the attachment should not have been deleted by a parent outside the family');
});
