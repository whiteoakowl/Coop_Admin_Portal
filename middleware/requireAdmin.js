// Gates every /admin/* route behind the single master Admin session. See
// README.md's "Admin access model" section for why this is functionally
// identical to requireFullAdmin.js/res.locals.isFullAdmin today, and why
// all three still exist as separate touchpoints anyway.
module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson) return res.status(401).json({ error: 'Not authenticated' });
  // A real bug report: "after adding 4 categories it asks me to log in
  // and then goes to a 404 page." A session that expires mid-use lands
  // its NEXT request here - for a POST (the add-category form's own
  // action, e.g. /admin/accounting/accounting-categories), that's a
  // write-only URL with no GET handler of its own. Re-logging in follows
  // `next` with a plain GET (routes/admin.js's own res.redirect(next)),
  // so replaying a POST-only URL that way 404s outright - only a GET
  // request's own URL is safe to send a signed-in admin straight back to.
  const next_ = req.method === 'GET' ? encodeURIComponent(req.originalUrl) : '';
  res.redirect(next_ ? `/admin/login?next=${next_}` : '/admin/login');
};
