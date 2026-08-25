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
