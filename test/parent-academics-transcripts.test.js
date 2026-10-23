// Coverage for a real request: "Parent portal, add tabs called
// transcripts/diplomas. 1 subpage for transcripts and one for
// diplomas. On transcripts you can create and print a transcript for
// each student. You can add classes from co-op classes or family
// management classes or manually add an entirely new class. Then
// calculate the GPA per school year and for the entire 4 years. Print
// full page view of transcript." (utils/academics.js's own
// transcriptBuilderForStudent, routes/parent-portal.js's own
// /academics/transcripts routes). Diplomas already existed and is
// untouched by this feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `parent-academics-transcripts-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `parent-academics-transcripts-test-uploads-${process.pid}`);
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
  const code = `transcript${counter}`;
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

// Same buffered-binary-response idiom test/parent-family-school-print-
// preview-and-pdf.test.js already uses to check a real PDF body.
async function getBuffer(url, cookie) {
  return request(app)
    .get(url)
    .set('Cookie', cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

test('a parent can add, edit, and delete transcript entries, grouped by school year with a per-year and cumulative GPA', async () => {
  const familyId = await createFamily('Transcript Family');
  const parent = await createPortalMember({ name: 'Transcript Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Transcript Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/academics');

  // Year 1: 1 credit at A (4.0) + 0.5 credit at B (3.0) -> weighted
  // GPA = (1*4.0 + 0.5*3.0) / 1.5 = 3.67.
  const create1 = await request(app)
    .post('/parent/academics/transcripts')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, schoolYear: 'Year 1', className: 'Algebra I', creditHours: '1', gradeLetter: 'A', _csrf: csrf });
  assert.equal(create1.status, 302);
  assert.match(create1.headers.location, /notice=/);
  await request(app)
    .post('/parent/academics/transcripts')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, schoolYear: 'Year 1', className: 'PE', creditHours: '0.5', gradeLetter: 'B', _csrf: csrf });

  // Year 2: 1 credit at C (2.0).
  await request(app)
    .post('/parent/academics/transcripts')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, schoolYear: 'Year 2', className: 'Biology', creditHours: '1', gradeLetter: 'C', _csrf: csrf });

  const page = await request(app).get('/parent/academics').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Algebra I/);
  assert.match(page.text, /PE/);
  assert.match(page.text, /Biology/);
  assert.match(page.text, /Year 1 GPA: 3\.67/);
  assert.match(page.text, /Year 2 GPA: 2\.00/);
  // Cumulative: (1*4.0 + 0.5*3.0 + 1*2.0) / 2.5 = 3.00.
  assert.match(page.text, /Cumulative GPA \(2 school years\): 3\.00/);

  // Editing a grade recalculates the GPA - Algebra I from A to F drops
  // Year 1's own GPA to (1*0 + 0.5*3.0) / 1.5 = 1.00.
  const algebra = await db.prepare("SELECT id FROM parent_transcript_entries WHERE class_name = 'Algebra I'").get();
  const editRes = await request(app)
    .post(`/parent/academics/transcripts/${algebra.id}/edit`)
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ schoolYear: 'Year 1', className: 'Algebra I', creditHours: '1', gradeLetter: 'F', _csrf: csrf });
  assert.equal(editRes.status, 302);
  const afterEdit = await request(app).get('/parent/academics').set('Cookie', parent.cookie);
  assert.match(afterEdit.text, /Year 1 GPA: 1\.00/);

  // Deleting an entry removes it from the page and its own year's math.
  const pe = await db.prepare("SELECT id FROM parent_transcript_entries WHERE class_name = 'PE'").get();
  const deleteRes = await request(app).post(`/parent/academics/transcripts/${pe.id}/delete`).set('Cookie', parent.cookie).type('form').send({ _csrf: csrf });
  assert.equal(deleteRes.status, 302);
  const afterDelete = await request(app).get('/parent/academics').set('Cookie', parent.cookie);
  assert.doesNotMatch(afterDelete.text, /PE</);
  assert.equal(await db.prepare('SELECT 1 FROM parent_transcript_entries WHERE id = ?').get(pe.id), undefined);
});

test('a missing school year or class name is rejected, and another family cannot edit or delete this entry', async () => {
  const familyId = await createFamily('Transcript Validation Family');
  const parent = await createPortalMember({ name: 'Transcript Validation Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Transcript Validation Student', familyId, memberType: 'student', roleKey: 'student' });
  const csrf = await csrfFrom(parent.cookie, '/parent/academics');

  const badRes = await request(app)
    .post('/parent/academics/transcripts')
    .set('Cookie', parent.cookie)
    .type('form')
    .send({ studentId: student.memberId, schoolYear: '', className: 'Chemistry', _csrf: csrf });
  assert.match(badRes.headers.location, /error=/);

  const { createTranscriptEntry } = require('../utils/academics');
  const entryId = await createTranscriptEntry({ studentId: student.memberId, schoolYear: 'Year 1', className: 'Real Class', creditHours: 1, gradeLetter: 'A', createdByAccountId: null });

  const otherFamilyId = await createFamily('Transcript Other Family');
  const otherParent = await createPortalMember({ name: 'Transcript Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const otherCsrf = await csrfFrom(otherParent.cookie, '/parent/academics');

  const hijackEditRes = await request(app)
    .post(`/parent/academics/transcripts/${entryId}/edit`)
    .set('Cookie', otherParent.cookie)
    .type('form')
    .send({ schoolYear: 'Hijacked', className: 'Hijacked', creditHours: '1', _csrf: otherCsrf });
  assert.equal(hijackEditRes.status, 404);

  const hijackDeleteRes = await request(app).post(`/parent/academics/transcripts/${entryId}/delete`).set('Cookie', otherParent.cookie).type('form').send({ _csrf: otherCsrf });
  assert.equal(hijackDeleteRes.status, 404);
  assert.ok(await db.prepare('SELECT 1 FROM parent_transcript_entries WHERE id = ?').get(entryId), "another family's parent must not be able to touch this entry");
});

// A real request: "Add class should have dropdown or year choices.
// Choose year and semester, then it will have three buttons saying,
// add co-op class, add family class, add manual class. If choosing
// co-op class it will then show a list of that students co-op classes
// for that school year. Choose family class and it will show you the
// family classes that were assigned to that student to choose from.
// Manual class allows you to add class name, credits and grade."
test('the Add Class dialog offers a Year/Semester picker, then Co-op/Family/Manual class choices', async () => {
  const familyId = await createFamily('Transcript Quickfill Family');
  const parent = await createPortalMember({ name: 'Transcript Quickfill Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Transcript Quickfill Student', familyId, memberType: 'student', roleKey: 'student' });

  const { createSemester } = require('../utils/classSchedule');
  const semester = await createSemester('Fall 2026');
  const classInfo = await db.prepare("INSERT INTO classes (day, hour_position, class_name, semester_id) VALUES ('monday', 1, 'Co-op Art Class', ?) RETURNING id").get(semester.id);
  await db.prepare('INSERT INTO class_enrollments (class_id, student_id) VALUES (?, ?)').run(classInfo.id, student.memberId);

  const { createClass, assignClassToStudents } = require('../utils/familySchool');
  const familyClassId = await createClass({ familyId, className: 'Family Science Class', description: null, createdByAccountId: null });
  await assignClassToStudents(familyClassId, [student.memberId]);

  const page = await request(app).get('/parent/academics').set('Cookie', parent.cookie);
  assert.equal(page.status, 200);
  // Year and Semester pickers, then the three mode buttons.
  assert.match(page.text, /<select name="schoolYear" required>/);
  assert.match(page.text, /<select data-transcript-semester-select>/);
  assert.match(page.text, /<option value="\d+">Fall 2026<\/option>/);
  assert.match(page.text, /data-transcript-mode="coop">Add Co-op Class<\/button>/);
  assert.match(page.text, /data-transcript-mode="family">Add Family Class<\/button>/);
  assert.match(page.text, /data-transcript-mode="manual">Add Manual Class<\/button>/);
  // Family classes assigned to this student render directly into the
  // Family Class panel's own select.
  assert.match(page.text, /<select data-transcript-family-select>[\s\S]*?Family Science Class[\s\S]*?<\/select>/);
  // Co-op classes are scoped per semester (coopClassesBySemester) and
  // read by public/js/transcript-add-class.js from this embedded JSON
  // block, keyed by that semester's own id.
  const coopDataMatch = /<script type="application\/json" data-transcript-coop-data>([^<]*)<\/script>/.exec(page.text);
  assert.ok(coopDataMatch, 'expected the embedded co-op classes JSON block');
  const coopClassesBySemester = JSON.parse(coopDataMatch[1]);
  assert.deepEqual(coopClassesBySemester[semester.id], ['Co-op Art Class']);
});

test('Print full page view: the transcript print page shows the per-year and cumulative GPA, scoped to one\'s own child', async () => {
  const familyId = await createFamily('Transcript Print Family');
  const parent = await createPortalMember({ name: 'Transcript Print Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Transcript Print Student', familyId, memberType: 'student', roleKey: 'student' });
  const { createTranscriptEntry } = require('../utils/academics');
  await createTranscriptEntry({ studentId: student.memberId, schoolYear: 'Year 1', className: 'Geometry', creditHours: 1, gradeLetter: 'A', createdByAccountId: null });

  const page = await request(app).get('/parent/academics').set('Cookie', parent.cookie);
  assert.match(page.text, new RegExp(`<a class="icon-btn" href="/parent/academics/transcripts/${student.memberId}/download\\.pdf" aria-label="Download PDF"`));

  const printPage = await request(app).get(`/parent/academics/transcripts/${student.memberId}/print`).set('Cookie', parent.cookie);
  assert.equal(printPage.status, 200);
  assert.match(printPage.text, /Official Transcript/);
  assert.match(printPage.text, /Transcript Print Student/);
  assert.match(printPage.text, /Geometry/);
  assert.match(printPage.text, /Cumulative GPA: 4\.00/);

  const otherFamilyId = await createFamily('Transcript Print Other Family');
  const otherParent = await createPortalMember({ name: 'Transcript Print Other Parent', familyId: otherFamilyId, memberType: 'parent', roleKey: 'parent' });
  const hijackPrint = await request(app).get(`/parent/academics/transcripts/${student.memberId}/print`).set('Cookie', otherParent.cookie);
  assert.equal(hijackPrint.status, 404);

  // A real request: "the download should be a pdf of exactly how it
  // would also look when printing" - this same transcript, now a real
  // PDF, scoped by the same requireOwnChild check as Print above.
  const pdfRes = await getBuffer(`/parent/academics/transcripts/${student.memberId}/download.pdf`, parent.cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  assert.match(pdfRes.headers['content-disposition'], /attachment; filename="Transcript-Print-Student-transcript\.pdf"/);
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');

  const hijackDownload = await request(app).get(`/parent/academics/transcripts/${student.memberId}/download.pdf`).set('Cookie', otherParent.cookie);
  assert.equal(hijackDownload.status, 404);
});

// A real request: "Header for pdf and print should be the family
// school management settings for header/school information." Same
// shared partials/family-school-print-header.ejs every other Family
// School Management print page uses.
test('Print and Download PDF show the family\'s own school name/branding as the header, not the generic fallback', async () => {
  const familyId = await createFamily('Transcript Header Family');
  const parent = await createPortalMember({ name: 'Transcript Header Parent', familyId, memberType: 'parent', roleKey: 'parent' });
  const student = await createPortalMember({ name: 'Transcript Header Student', familyId, memberType: 'student', roleKey: 'student' });
  const { createTranscriptEntry } = require('../utils/academics');
  await createTranscriptEntry({ studentId: student.memberId, schoolYear: 'Year 1', className: 'History', creditHours: 1, gradeLetter: 'A', createdByAccountId: null });

  const { saveFamilySchoolSettings } = require('../utils/familySchool');
  await saveFamilySchoolSettings({ familyId, schoolName: 'Transcript Branding Academy', colorPrimary: '#ff00aa' });

  const printPage = await request(app).get(`/parent/academics/transcripts/${student.memberId}/print`).set('Cookie', parent.cookie);
  assert.equal(printPage.status, 200);
  // The site's own <title>/nav brand (always "Sanford Homeschoolers")
  // is untouched - only the print-header block itself, which this
  // family's own settings now drive, needs to NOT be the generic
  // fallback.
  const printHeaderMatch = /<div class="print-header family-school-print-header">[\s\S]*?<\/div>\s*<\/div>/.exec(printPage.text);
  assert.ok(printHeaderMatch, 'expected a print-header block');
  assert.match(printHeaderMatch[0], /Transcript Branding Academy/);
  assert.doesNotMatch(printHeaderMatch[0], /Sanford Homeschoolers/);

  const pdfRes = await getBuffer(`/parent/academics/transcripts/${student.memberId}/download.pdf`, parent.cookie);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.body.slice(0, 5).toString(), '%PDF-');
});
