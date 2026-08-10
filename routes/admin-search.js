// Global admin search (Phase 4 audit item) - see utils/search.js for the
// scoping rationale (member lookup + cross-links into Attendance/Floater/
// Library, rather than four independent free-text searches).
//
// Gated behind requireFullAdmin, matching Members and Library (2 of the
// 4 searched areas), rather than the lighter requireAdmin the Attendance/
// Floater Assignments pages themselves use - a member's per-member
// Attendance tab (routes/admin-members.js) is itself full-admin-only, and
// there's no separate lower-privilege view of it to link a search result
// to, so this whole feature sits at the same privilege level as its most
// restrictive destination rather than trying to split hairs about which
// individual result a lesser admin role might one day be allowed to see.
const express = require('express');
const router = express.Router();
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { globalSearch } = require('../utils/search');

router.use(requireFullAdmin);

router.get('/search', (req, res) => {
  const results = globalSearch(req.query.q);
  res.render('admin-search', {
    title: 'Search',
    q: results.query,
    members: results.members,
    libraryItems: results.libraryItems,
    searched: req.query.q !== undefined,
  });
});

module.exports = router;
