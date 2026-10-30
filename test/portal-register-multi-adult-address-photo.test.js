// Coverage for a real request: "Public registration form. There is a
// +child button. There should also be an add adult button. Under first
// parent/guardian it should have address 1, address 2, city, state, zip
// code. When adding an additional parent there should be a check box
// that says address is the same. Should not be able to choose a grade
// level... Should be able to upload parent profile photos and student
// profile photos." See routes/portal-auth.js's own POST /register and
// views/portal-register.ejs/partials/register-adult-fields.ejs/
// register-child-fields.ejs for the implementation this exercises.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDbPath = path.join(os.tmpdir(), `portal-register-multi-adult-test-db-${process.pid}.db`);
const testUploadsDir = path.join(os.tmpdir(), `portal-register-multi-adult-test-uploads-${process.pid}`);
process.env.DB_PATH = testDbPath;
process.env.UPLOADS_DIR = testUploadsDir;
process.env.SESSION_SECRET = 'test-secret-not-for-real-use';

const request = require('supertest');
const app = require('../server');
const db = require('../db');

test.before(() => app.ready);
test.after(() => {
  fs.rmSync(testDbPath, { force: true });
  fs.rmSync(`${testDbPath}-wal`, { force: true });
  fs.rmSync(`${testDbPath}-shm`, { force: true });
  fs.rmSync(testUploadsDir, { recursive: true, force: true });
});

test('the registration form has an Add Adult button, address 1/2+city/state/zip under the first parent, and no child grade level select', async () => {
  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.match(res.text, /id="add-adult-btn">\+ Add Adult</);
  assert.match(res.text, /id="add-child-btn">\+ Add Child</);
  assert.match(res.text, /name="address"/);
  assert.match(res.text, /name="address2"/);
  assert.match(res.text, /name="city"/);
  assert.match(res.text, /name="state"/);
  assert.match(res.text, /name="zip"/);
  // The child block's own clone <template> is still present in the raw
  // HTML (as inert <template> contents) - scoped past it so this assert
  // reflects what a rendered block would show, not the template markup.
  assert.doesNotMatch(res.text, /Grade[\s\S]{0,40}Select Grade/);
  assert.doesNotMatch(res.text, /gradeLevel/);
});

// A real request: "There should not be double titles for additional
// adult and children sections" followed by a later real request: "Put
// double title back but it should say parent/guardian #2, #3 etc. Same
// for children." The per-block title is back, but as an empty
// data-adult-title/data-child-title element - no static "Additional
// Parent/Guardian"/"Child" text hardcoded here any more (that's what
// made it a plain duplicate of the section's own <h2> the first time
// around). public/js/portal-register-form.js's own renumberAdults()/
// renumberChildren() fill in the actual "#2"/"#3"/etc. text client-side
// from each block's live DOM position - not testable at the HTTP level
// supertest operates at, so this only covers the markup those functions
// expect to find.
test('the Additional Parent/Guardian and Child blocks have an empty, numberable title element instead of a static duplicate of the section heading', async () => {
  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.match(res.text, />Additional Parents \/ Guardians</, 'the section heading itself is still there');
  assert.match(res.text, />Children</, 'the section heading itself is still there');
  assert.doesNotMatch(res.text, /<h3>Additional Parent\/Guardian<\/h3>/);
  assert.doesNotMatch(res.text, /<h3>Child<\/h3>/);
  assert.match(res.text, /<h3 data-adult-title><\/h3>/);
  assert.match(res.text, /<h3 data-child-title><\/h3>/);
  // The Remove button is still present in each block's clone <template> -
  // no adult/child block renders live on a fresh GET.
  assert.match(res.text, /register-remove-adult/);
  assert.match(res.text, /register-remove-child/);
});

test('public/js/portal-register-form.js numbers Additional Parent/Guardian blocks from #2 and Child blocks from #1, and renumbers after Remove', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portal-register-form.js'), 'utf8');
  assert.match(js, /'Parent\/Guardian #' \+ \(i \+ 2\)/);
  assert.match(js, /'Child #' \+ \(i \+ 1\)/);
  // Recomputed after Remove (not just once on page load), so a block
  // removed from the middle of the list doesn't leave a numbering gap.
  assert.match(js, /block\.remove\(\); renumberAdults\(\); \}/);
  assert.match(js, /block\.remove\(\); renumberChildren\(\); \}/);
});

test('the SMS checkbox sits inline before the permission paragraph, and the policy checkbox reads "I have read and agree..."', async () => {
  const res = await request(app).get('/register');
  assert.match(res.text, /<input type="checkbox" name="smsOptIn" value="1" \/>\s*Sanford Homeschoolers may send SMS/);
  assert.match(res.text, /I have read and agree to the Sanford Homeschoolers Policy Handbook\./);
  assert.doesNotMatch(res.text, />I have read the Policy Handbook</);
});

test('an additional adult with "address is the same" checked copies the primary parent\'s address', async () => {
  const email = 'same-address-primary@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Primary')
    .field('lastName', 'Parent')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('address', '123 Main St')
    .field('address2', 'Apt 4')
    .field('city', 'Springfield')
    .field('state', 'IL')
    .field('zip', '62704')
    .field('additionalParents[0][firstName]', 'Second')
    .field('additionalParents[0][lastName]', 'Parent')
    .field('additionalParents[0][sameAddress]', '1');
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const primary = await db.prepare("SELECT family_id, address, address2, city, state, zip FROM members WHERE email = ?").get(email);
  assert.ok(primary, 'expected the primary parent to be created');
  assert.equal(primary.address, '123 Main St');
  assert.equal(primary.address2, 'Apt 4');

  const second = await db.prepare("SELECT address, address2, city, state, zip, is_primary_parent FROM members WHERE name = 'Second Parent' AND family_id = ?").get(primary.family_id);
  assert.ok(second, 'expected the additional adult to be created in the same family');
  assert.equal(second.address, '123 Main St');
  assert.equal(second.address2, 'Apt 4');
  assert.equal(second.city, 'Springfield');
  assert.equal(second.state, 'IL');
  assert.equal(second.zip, '62704');
  assert.equal(!!second.is_primary_parent, false);
});

test('an additional adult with "address is the same" unchecked keeps their own typed address', async () => {
  const email = 'own-address-primary@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Primary')
    .field('lastName', 'Owner')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('address', '1 Primary Way')
    .field('additionalParents[0][firstName]', 'Different')
    .field('additionalParents[0][lastName]', 'Owner')
    .field('additionalParents[0][address]', '99 Other Rd')
    .field('additionalParents[0][city]', 'Shelbyville');
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const second = await db.prepare("SELECT address, city FROM members WHERE name = 'Different Owner'").get();
  assert.ok(second, 'expected the additional adult to be created');
  assert.equal(second.address, '99 Other Rd');
  assert.equal(second.city, 'Shelbyville');
});

test('a blank additional-adult block is silently dropped, not rejected', async () => {
  const email = 'blank-adult-block@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Solo')
    .field('lastName', 'Parent')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('additionalParents[0][firstName]', '')
    .field('additionalParents[0][lastName]', '');
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);
  const count = Number((await db.prepare("SELECT COUNT(*) AS c FROM members WHERE family_id = (SELECT family_id FROM members WHERE email = ?)").get(email)).c);
  assert.equal(count, 1, 'expected only the primary parent, no blank adult row');
});

test('uploaded photos for the primary parent and a child are saved as photo_path', async () => {
  const email = 'photo-upload-parent@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Photo')
    .field('lastName', 'Parent')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('children[0][firstName]', 'Photo')
    .field('children[0][lastName]', 'Kid')
    .attach('photo', Buffer.from('fake parent photo bytes'), { filename: 'parent.jpg', contentType: 'image/jpeg' })
    .attach('children[0][photo]', Buffer.from('fake kid photo bytes'), { filename: 'kid.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const parent = await db.prepare('SELECT photo_path FROM members WHERE email = ?').get(email);
  assert.ok(parent && parent.photo_path, 'expected the primary parent to have a photo_path');

  const child = await db.prepare("SELECT photo_path, grade_level FROM members WHERE name = 'Photo Kid'").get();
  assert.ok(child && child.photo_path, 'expected the child to have a photo_path');
  assert.equal(child.grade_level, null, 'a publicly self-registered child never gets a grade level set');
});

// A real request: "For add an adult, also add check box for give this
// parent their own portal log in."
test('the registration form\'s Additional Parent block offers a "give this parent their own portal login" checkbox', async () => {
  const res = await request(app).get('/register');
  assert.equal(res.status, 200);
  assert.match(res.text, /data-adult-login-toggle name="additionalParents\[__INDEX__\]\[wantsLogin\]"/);
  assert.match(res.text, /Give this parent their own portal login/);
  assert.match(res.text, /name="additionalParents\[__INDEX__\]\[loginPassword\]"/);
  assert.match(res.text, /name="additionalParents\[__INDEX__\]\[loginPasswordConfirm\]"/);
});

test('checking "give this parent their own portal login" with a valid email/password creates a pending account for that adult', async () => {
  const email = 'adult-login-primary@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Primary')
    .field('lastName', 'Login')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('additionalParents[0][firstName]', 'Second')
    .field('additionalParents[0][lastName]', 'Login')
    .field('additionalParents[0][email]', 'adult-login-second@example.com')
    .field('additionalParents[0][wantsLogin]', '1')
    .field('additionalParents[0][loginPassword]', 'secondpassword123')
    .field('additionalParents[0][loginPasswordConfirm]', 'secondpassword123');
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const adultMember = await db.prepare("SELECT id FROM members WHERE name = 'Second Login'").get();
  assert.ok(adultMember, 'expected the additional adult to be created');
  const account = await db.prepare('SELECT status, email FROM member_accounts WHERE member_id = ?').get(adultMember.id);
  assert.ok(account, 'expected a member_accounts row for the additional adult');
  assert.equal(account.status, 'pending');
  assert.equal(account.email, 'adult-login-second@example.com');

  const role = await db.prepare("SELECT id FROM roles WHERE key = 'parent'").get();
  const hasRole = await db
    .prepare('SELECT 1 FROM member_account_roles mar JOIN member_accounts ma ON ma.id = mar.member_account_id WHERE ma.member_id = ? AND mar.role_id = ?')
    .get(adultMember.id, role.id);
  assert.ok(hasRole, 'expected the additional adult to hold the parent role');
});

test('an additional adult without the login checkbox gets no portal account', async () => {
  const email = 'adult-no-login-primary@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Primary')
    .field('lastName', 'NoLogin')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('additionalParents[0][firstName]', 'Second')
    .field('additionalParents[0][lastName]', 'NoLogin');
  assert.equal(res.status, 200);
  assert.match(res.text, /Registration Submitted/);

  const adultMember = await db.prepare("SELECT id FROM members WHERE name = 'Second NoLogin'").get();
  assert.ok(adultMember, 'expected the additional adult to be created');
  const account = await db.prepare('SELECT id FROM member_accounts WHERE member_id = ?').get(adultMember.id);
  assert.equal(account, undefined, 'no account should exist without the checkbox');
});

test('checking the adult login checkbox without a password is rejected, nothing created', async () => {
  const email = 'adult-login-missing-password@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Primary')
    .field('lastName', 'Missing')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('additionalParents[0][firstName]', 'Second')
    .field('additionalParents[0][lastName]', 'Missing')
    .field('additionalParents[0][email]', 'adult-login-missing-second@example.com')
    .field('additionalParents[0][wantsLogin]', '1');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Registration Submitted/);
  assert.match(res.text, /needs an email.*and a password/);

  const primary = await db.prepare('SELECT id FROM members WHERE email = ?').get(email);
  assert.equal(primary, undefined, 'the whole submission should be rejected, nothing at all created');
});

test('mismatched adult login passwords are rejected, nothing created', async () => {
  const email = 'adult-login-mismatch@example.com';
  const res = await request(app)
    .post('/register')
    .field('firstName', 'Primary')
    .field('lastName', 'Mismatch')
    .field('email', email)
    .field('password', 'testpassword123')
    .field('confirmPassword', 'testpassword123')
    .field('handbookRead', '1')
    .field('privacyPolicyRead', '1')
    .field('termsRead', '1')
    .field('additionalParents[0][firstName]', 'Second')
    .field('additionalParents[0][lastName]', 'Mismatch')
    .field('additionalParents[0][email]', 'adult-login-mismatch-second@example.com')
    .field('additionalParents[0][wantsLogin]', '1')
    .field('additionalParents[0][loginPassword]', 'secondpassword123')
    .field('additionalParents[0][loginPasswordConfirm]', 'somethingelse456');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Registration Submitted/);
  assert.match(res.text, /passwords do not match/);

  const primary = await db.prepare('SELECT id FROM members WHERE email = ?').get(email);
  assert.equal(primary, undefined, 'the whole submission should be rejected, nothing at all created');
});
