// Gates full-Admin-only sections (Members, Design/Print, Documents,
// Library) behind the single master Admin session. Kept as its own
// middleware (distinct from requireAdmin) so those sections stay clearly
// marked in each router even though the check is currently the same -
// if a lesser admin role is ever reintroduced, only this file changes.
module.exports = function requireFullAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  const nextParam = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${nextParam}`);
};
