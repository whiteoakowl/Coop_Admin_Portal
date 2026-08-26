// Babysitter Directory - photo proxy, mounted at /babysitters
// (server.js), shared across Parent Portal's directory, Student Portal's
// own profile page, and Main Admin's approval queue. Every photo file is
// proxied through this one authenticated route rather than a public
// bucket URL - same reasoning as routes/photos.js's own comment. Any
// signed-in portal account can view an APPROVED profile's photo (the
// directory itself is member-facing, any role); a still-'pending'
// profile's photo is visible only to the member it belongs to or their
// own family, or to Main Admin, so a submission-in-review isn't exposed
// sitewide before anyone has reviewed it.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { createStorageClient, downloadFile } = require('../utils/storage');
const { memberForAccount, familyForAccount } = require('../utils/portalAuth');

const BABYSITTER_PHOTOS_BUCKET = 'private-babysitter-photos';
const BABYSITTER_PHOTOS_DIR = path.join(__dirname, '..', 'private-uploads', 'babysitter-photos');
const storageClient = createStorageClient();

async function canView(req, profile) {
  if (!profile) return false;
  if (profile.status === 'approved') return !!req.portalAccount;
  if (!req.portalAccount) return false;
  if (req.portalRoles && req.portalRoles.some((r) => r.key === 'main_admin')) return true;
  const family = await familyForAccount(req.portalAccount.id);
  if (family.some((m) => m.id === profile.member_id)) return true;
  const own = await memberForAccount(req.portalAccount.id);
  return !!own && own.id === profile.member_id;
}

router.get('/:id/photo', async (req, res) => {
  const profile = await db.prepare('SELECT * FROM babysitter_profiles WHERE id = ?').get(req.params.id);
  if (!(await canView(req, profile))) {
    if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    return res.status(404).render('404', { title: 'Not Found' });
  }
  if (!profile.photo_key) return res.status(404).render('404', { title: 'Not Found' });
  if (storageClient) {
    const buffer = await downloadFile(storageClient, BABYSITTER_PHOTOS_BUCKET, profile.photo_key);
    res.setHeader('Content-Type', 'image/*');
    return res.send(buffer);
  }
  const filePath = path.join(BABYSITTER_PHOTOS_DIR, path.basename(profile.photo_key));
  if (!fs.existsSync(filePath)) return res.status(404).render('404', { title: 'Not Found' });
  res.sendFile(filePath);
});

module.exports = router;
