// Gates full-Admin-only sections (Members, Design/Print, Documents,
// Library, misc badges, Name Tag) behind the single master Admin session.
// Kept as its own middleware (distinct from requireAdmin) so those
// sections stay clearly marked in each router even though the check is
// currently the same - see README.md's "Admin access model" section for
// the full rationale (short version: if a lesser admin role is ever
// reintroduced, only this file changes).
//
// Several of these routers gate themselves with a blanket
// `router.use(requireFullAdmin)` at the top of the file, ahead of any of
// that router's own routes - so requests to every route in those files
// hit *this* middleware first, not a per-route one, and the JSON-vs-
// redirect branching below needs to match requireAdmin's own exactly,
// not just its "logged in or not" check. Browser code that fetch()'s one
// of these routes (library-checkout.js, name-tag-editor.js) expects JSON
// back and calls res.json() unconditionally - without this, an expired
// session mid-use got a followed 302 redirect to the login page's HTML
// instead, which fetch() reports as a 200 success whose body isn't valid
// JSON, surfacing as a generic "Connection error" that has nothing to do
// with the real cause.
module.exports = function requireFullAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'Not authenticated' });
  const nextParam = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${nextParam}`);
};
