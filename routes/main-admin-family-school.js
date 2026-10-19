// Family School Management (Main Admin side) - a real request: "On main
// admin the family school management tab simply has settings. Leave
// settings for that blank for now." No actual settings exist yet - just
// the tab/page itself, ready for whatever gets asked for later. See
// utils/familySchool.js's own header comment for the feature as a whole
// (Parent/Student Portal sides, routes/parent-family-school.js/routes/
// student-family-school.js).
const express = require('express');
const router = express.Router();
const { requirePortalAuth, requirePortal } = require('../middleware/portalAuth');

router.use(requirePortalAuth, requirePortal('main_admin'));

router.get('/family-school', (req, res) => {
  res.render('main-admin-family-school-settings', { title: 'Family School Management' });
});

module.exports = router;
