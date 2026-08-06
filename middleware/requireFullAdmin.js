// Gates full-Admin-only sections (Members, Design/Print, Documents, Library,
// and the Class Settings/Documents Settings tabs) - a Co-op Admin member is
// still let into /admin/* by requireAdmin, just not these. Stack this after
// requireAdmin (or use standalone - it checks for a real admin session itself).
module.exports = function requireFullAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();

  const isCoopAdmin = req.session && req.session.portalMemberId && req.session.portalRole === 'coop_admin';
  if (isCoopAdmin) return res.status(403).render('403', { title: 'Not Available' });

  const nextParam = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${nextParam}`);
};
