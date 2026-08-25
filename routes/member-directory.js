// Member-facing Member Directory (Community & Commerce track, item 5),
// mounted at /member-directory (server.js). Members-only for every route
// here - no public option, unlike Events/Directory/Classifieds' own
// public toggle, since this is real personal contact information. Only
// the fields a Main Admin has turned on (utils/memberDirectory.js's
// getFieldSettings) are ever rendered, and a member can opt themselves
// (or any of their own family) out entirely from /member-directory/mine.
const express = require('express');
const router = express.Router();
const { createStorageClient } = require('../utils/storage');
const { urlForUpload } = require('../utils/uploadBackend');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { familyForAccount } = require('../utils/portalAuth');
const memberDirectory = require('../utils/memberDirectory');

// Same bucket/local-dir convention routes/admin-members.js already
// established for member photos - read-only reuse here (resolving a URL
// for an already-stored photo_path), not a second upload path.
const MEMBER_PHOTOS_BUCKET = 'member-photos';
const storageClient = createStorageClient();

function photoUrl(photoPath) {
  return urlForUpload({ client: storageClient, bucket: MEMBER_PHOTOS_BUCKET, webDir: '/uploads/members', key: photoPath });
}

// Trims a full directory member row down to only the fields the field
// settings actually turned on, plus name (always shown - a directory
// entry with no name isn't a directory entry) and id.
function visibleFields(member, fieldSettings) {
  const isVisible = (key) => fieldSettings.find((f) => f.key === key)?.visible;
  const out = { id: member.id, name: member.name };
  if (isVisible('photo')) out.photoUrl = photoUrl(member.photo_path);
  if (isVisible('phone')) out.phone = member.phone;
  if (isVisible('email')) out.email = member.email;
  if (isVisible('address')) out.address = [member.address, member.city, member.state, member.zip].filter(Boolean).join(', ');
  if (isVisible('grade_level')) out.gradeLevel = member.grade_level;
  if (isVisible('family')) out.familyName = member.family_name;
  return out;
}

router.use(requirePortalAuth);

router.get('/', async (req, res) => {
  const fieldSettings = await memberDirectory.getFieldSettings();
  const members = await memberDirectory.listDirectoryMembers();
  res.render('member-directory-list', { title: 'Member Directory', members: members.map((m) => visibleFields(m, fieldSettings)) });
});

router.get('/mine', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  const withOptOut = [];
  for (const m of family) {
    withOptOut.push({ ...m, optedOut: await memberDirectory.isOptedOut(m.id) });
  }
  res.render('member-directory-mine', { title: 'Directory Privacy', family: withOptOut, notice: req.query.notice || null });
});

router.post('/:id/opt-out', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === parseInt(req.params.id, 10))) return res.status(403).render('403', { title: 'Not Authorized', message: 'You can only manage your own family.', backHref: '/member-directory/mine', backLabel: 'Back' });
  await memberDirectory.setOptedOut(req.params.id, true);
  res.redirect('/member-directory/mine?notice=' + encodeURIComponent('Removed from the directory.'));
});

router.post('/:id/opt-in', async (req, res) => {
  const family = await familyForAccount(req.portalAccount.id);
  if (!family.some((m) => m.id === parseInt(req.params.id, 10))) return res.status(403).render('403', { title: 'Not Authorized', message: 'You can only manage your own family.', backHref: '/member-directory/mine', backLabel: 'Back' });
  await memberDirectory.setOptedOut(req.params.id, false);
  res.redirect('/member-directory/mine?notice=' + encodeURIComponent('Added back to the directory.'));
});

router.get('/:id', async (req, res) => {
  const member = await memberDirectory.getDirectoryMember(req.params.id);
  if (!member) return res.status(404).render('404', { title: 'Not Found' });
  const fieldSettings = await memberDirectory.getFieldSettings();
  res.render('member-directory-detail', { title: member.name, member: visibleFields(member, fieldSettings) });
});

module.exports = router;
