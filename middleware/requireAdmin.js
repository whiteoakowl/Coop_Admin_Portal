// Gates every /admin/* route behind the single master Admin session. See
// README.md's "Admin access model" section for why this is functionally
// identical to requireFullAdmin.js/res.locals.isFullAdmin today, and why
// all three still exist as separate touchpoints anyway.
module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'Not authenticated' });
  const next_ = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${next_}`);
};
