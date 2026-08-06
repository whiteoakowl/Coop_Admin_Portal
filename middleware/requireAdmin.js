// Lets in the single master Admin account, or a member who's been granted
// Co-op Admin portal access (checked on their profile) and logged in as
// themselves via /login. Either way lands in the same /admin/* routes -
// requireFullAdmin narrows further to master-Admin-only sections.
module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  if (req.session && req.session.portalMemberId && req.session.portalRole === 'coop_admin') return next();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'Not authenticated' });
  const next_ = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${next_}`);
};
