// Main Admin > Babysitter Directory - a real request: "babysitter tab
// should have babysitter, approvals and settings tab. add a babysitter
// profile button that pops up and picks a member, auto fills the rest of
// the form." No Co-op Admin equivalent (unlike Announcements/Resource
// Links) - the requester named Main Admin specifically as the approver,
// not "main admin and co-op admin" the way item 7 explicitly did.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const babysitters = require('../utils/babysitters');
const { imageFileFilter } = require('../utils/uploads');
const { createStorageClient, uploadFile, generateKey } = require('../utils/storage');
const { requirePortalAuth, requirePortal, requirePortalPermission } = require('../middleware/portalAuth');

router.use(requirePortalAuth, requirePortal('main_admin'), requirePortalPermission('manage_babysitters'));

const BABYSITTER_PHOTOS_BUCKET = 'private-babysitter-photos';
const BABYSITTER_PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'babysitter-photos');
const babysitterStorageClient = createStorageClient();
if (!babysitterStorageClient && !fs.existsSync(BABYSITTER_PHOTOS_DIR)) fs.mkdirSync(BABYSITTER_PHOTOS_DIR, { recursive: true });
const MAX_BABYSITTER_PHOTO_BYTES = 4 * 1024 * 1024;
const uploadBabysitterPhoto = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BABYSITTER_PHOTO_BYTES }, fileFilter: imageFileFilter });

const TABS = ['directory', 'approvals', 'settings'];

router.get('/', async (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'directory';
  const pending = await babysitters.listPendingProfiles();
  res.render('main-admin-babysitters', {
    title: 'Babysitter Directory',
    activeTab: tab,
    directory: tab === 'directory' ? await babysitters.listApprovedProfiles() : [],
    pending,
    members: tab === 'directory' ? await babysitters.listMembersForPicker() : [],
    requireApproval: tab === 'settings' ? await babysitters.requireApprovalSetting() : null,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', uploadBabysitterPhoto.single('photo'), async (req, res) => {
  const memberId = parseInt(req.body.memberId, 10);
  if (!memberId) return res.redirect('/main-admin/babysitters?error=' + encodeURIComponent('Choose a member.'));

  let photoKey = null;
  if (req.file) {
    if (babysitterStorageClient) {
      photoKey = await uploadFile(babysitterStorageClient, BABYSITTER_PHOTOS_BUCKET, req.file.buffer, req.file.originalname, req.file.mimetype);
    } else {
      photoKey = generateKey(req.file.originalname);
      fs.writeFileSync(path.join(BABYSITTER_PHOTOS_DIR, photoKey), req.file.buffer);
    }
  }

  await babysitters.createProfileByAdmin(
    memberId,
    {
      ageGrade: (req.body.ageGrade || '').trim(),
      availability: (req.body.availability || '').trim(),
      experience: (req.body.experience || '').trim(),
      certifications: (req.body.certifications || '').trim(),
      hourlyRate: (req.body.hourlyRate || '').trim(),
      contactMethod: (req.body.contactMethod || '').trim(),
      contactPreference: (req.body.contactPreference || '').trim(),
      photoKey,
    },
    req.portalAccount.id
  );
  res.redirect('/main-admin/babysitters?notice=' + encodeURIComponent('Profile added to the directory.'));
});

router.post('/settings', async (req, res) => {
  await babysitters.setRequireApprovalSetting(req.body.requireApproval === '1');
  res.redirect('/main-admin/babysitters?tab=settings&notice=' + encodeURIComponent('Settings saved.'));
});

router.post('/:id/approve', async (req, res) => {
  await babysitters.decideSubmission(req.params.id, true);
  res.redirect('/main-admin/babysitters?tab=approvals&notice=' + encodeURIComponent('Profile approved.'));
});

router.post('/:id/reject', async (req, res) => {
  await babysitters.decideSubmission(req.params.id, false);
  res.redirect('/main-admin/babysitters?tab=approvals&notice=' + encodeURIComponent('Profile rejected.'));
});

module.exports = router;
