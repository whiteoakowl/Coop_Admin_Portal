module.exports = function requireMemberPortal(req, res, next) {
  if (req.session && req.session.portalMemberId) return next();
  res.redirect('/');
};
