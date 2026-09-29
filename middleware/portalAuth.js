// Server-side enforcement for the member portal platform. A portal
// (parent/student/teacher/coop_admin/main_admin) is granted purely by
// holding the matching role - requirePortal(key) is the single place
// that check happens, so no individual route re-implements "does this
// account have this role" itself. Manually navigating to an
// unauthorized portal URL always hits this same check; nothing about
// portal access is UI-only.
const { findAccountById, rolesForAccount, permissionsForAccount } = require('../utils/portalAuth');

// Loads the signed-in account (if any) onto req.portalAccount/
// req.portalRoles/req.portalPermissions for every request, whether or
// not that particular route requires login - lets public pages (the
// homepage) still show "My Portal" instead of "Log In" for a
// signed-in visitor without every route needing its own lookup.
async function loadPortalSession(req, res, next) {
  // Always defined, signed in or not - a template can reference
  // `portalAccount` directly (not every one remembers the `typeof
  // portalAccount !== 'undefined'` guard the ones that DO expect a
  // signed-out visitor use) without a bare reference throwing
  // ReferenceError for a signed-out visitor, who never reaches the
  // account lookup below. Caught by views/events-detail.ejs's own
  // public event page crashing 500 for every signed-out visitor - the
  // one place this had already gone unguarded.
  res.locals.portalAccount = null;
  res.locals.portalRoles = [];

  // A whole family of real bug reports - "Parent portal, clicking on
  // chat/store/account takes you somewhere else" - turned out to be the
  // same mistake repeated across a dozen shared pages (Chat, Store,
  // Business Directory, Classifieds, Photos, Accounting, My Profile,
  // Settings, ...): each either hardcoded a generic portalTitle (losing a
  // signed-in parent's or student's own nav shell entirely) or only ever
  // checked for a student role (never parent). Centralizing the correct
  // check here - parent takes priority since a parent account viewing a
  // shared page always got there from their own Parent Portal nav - means
  // every one of those views can now just call
  // `sharedPortalTitle('<its own generic fallback>')` instead of
  // reimplementing (and risking re-breaking) this same logic by hand.
  // Only meaningful for a page that renders partials/portal-nav at all -
  // a genuinely public page unconditionally shown to everyone (the
  // homepage) has no reason to call this.
  res.locals.sharedPortalTitle = function (fallback) {
    const roles = res.locals.portalRoles || [];
    if (roles.some((r) => r.key === 'parent')) return 'Parent Portal';
    if (roles.some((r) => r.key === 'student')) return 'Student Portal';
    return fallback;
  };

  const accountId = req.session && req.session.portalAccountId;
  if (!accountId) return next();
  const account = await findAccountById(accountId);
  if (!account || account.status !== 'active') {
    req.session.portalAccountId = null;
    return next();
  }
  req.portalAccount = account;
  req.portalRoles = await rolesForAccount(account.id);
  req.portalPermissions = await permissionsForAccount(account.id);
  res.locals.portalAccount = account;
  res.locals.portalRoles = req.portalRoles;
  next();
}

// Requires a signed-in, active account - anything past this point can
// read req.portalAccount safely.
function requirePortalAuth(req, res, next) {
  if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

// Requires the signed-in account to hold the given role key (a role key
// doubles as its portal's identifier - see the roles seeded in
// db/bootstrapPg.js). A 403 page, not a redirect, for an authenticated
// account trying a portal it doesn't hold - the person IS logged in,
// they're just not authorized for this one, so bouncing them to /login
// would be misleading.
function requirePortal(roleKey) {
  return function (req, res, next) {
    if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!req.portalRoles.some((r) => r.key === roleKey)) {
      return res
        .status(403)
        .render('403', { title: 'Not Authorized', message: "You don't have access to this portal.", backHref: '/portal', backLabel: 'Back to My Portals' });
    }
    next();
  };
}

// Requires a specific granular capability (see the permissions catalog
// in db/bootstrapPg.js) rather than a whole role/portal - for an action
// inside a portal that not every member of that portal should
// necessarily be able to do.
function requirePortalPermission(permissionKey) {
  return function (req, res, next) {
    if (!req.portalAccount) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!req.portalPermissions.has(permissionKey)) {
      return res
        .status(403)
        .render('403', { title: 'Not Authorized', message: "You don't have permission to do that.", backHref: '/portal', backLabel: 'Back to My Portals' });
    }
    next();
  };
}

module.exports = { loadPortalSession, requirePortalAuth, requirePortal, requirePortalPermission };
