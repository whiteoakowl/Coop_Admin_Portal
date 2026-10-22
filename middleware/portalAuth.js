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
  //
  // A later real bug report - "Student portal, when you click on chat it
  // should stay on Student portal" - was this same "parent always wins"
  // priority rule now working AGAINST a dual-role (parent AND student)
  // account: clicking Chat from their own Student Portal nav still landed
  // them in Parent Portal, since the guess never knew which portal they'd
  // actually clicked from. ?portal=parent|student is the same fix
  // routes/events.js's own portalParam already uses for this identical
  // ambiguity - reading it straight off the request here (rather than
  // every caller threading it through as its own render() local) is what
  // lets every existing `sharedPortalTitle('Chat')`-style call keep
  // working unchanged; only the handful of nav links that are reachable
  // from BOTH portals' own nav (Chat, Photos - see portal-nav.ejs) needed
  // to start tagging their own href with it, the exact same way Events'
  // nav links already do.
  res.locals.sharedPortalTitle = function (fallback) {
    const roles = res.locals.portalRoles || [];
    const hasParent = roles.some((r) => r.key === 'parent');
    const hasStudent = roles.some((r) => r.key === 'student');
    // A real request moved Chat/Photos out of Co-op Teacher Portal's own
    // separate Community section and into its main nav (portal-nav.ejs's
    // own TEACHER_NAV_LINKS) - this function never knew about a teacher
    // account at all before that, so a teacher-only account clicking
    // either link fell all the way through to `fallback` here (never
    // 'Co-op Teacher Portal'), landing on a degraded/public shell instead of
    // their own sidebar - the exact same "wrong portal" bug this function
    // was built to prevent for parent/student.
    const hasTeacher = roles.some((r) => r.key === 'teacher');
    const requestedPortal = req.query.portal;
    if (requestedPortal === 'parent' && hasParent) return 'Parent Portal';
    if (requestedPortal === 'student' && hasStudent) return 'Student Portal';
    if (requestedPortal === 'teacher' && hasTeacher) return 'Co-op Teacher Portal';
    if (hasParent) return 'Parent Portal';
    if (hasStudent) return 'Student Portal';
    if (hasTeacher) return 'Co-op Teacher Portal';
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

// A real bug report: "after adding 4 categories it asks me to log in and
// then goes to a 404 page." A session that expires mid-use lands its
// NEXT request here - for a POST (an add/edit/delete form's own action
// URL), that's write-only, with no GET handler of its own. Re-logging in
// follows `next` with a plain GET (routes/portal-auth.js's own
// res.redirect(next)), so replaying a POST-only URL that way 404s
// outright - only a GET request's own URL is safe to send a signed-in
// account straight back to. Shared by every guard below.
function loginRedirectUrl(req) {
  return req.method === 'GET' ? '/login?next=' + encodeURIComponent(req.originalUrl) : '/login';
}

// Requires a signed-in, active account - anything past this point can
// read req.portalAccount safely.
function requirePortalAuth(req, res, next) {
  if (!req.portalAccount) return res.redirect(loginRedirectUrl(req));
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
    if (!req.portalAccount) return res.redirect(loginRedirectUrl(req));
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
    if (!req.portalAccount) return res.redirect(loginRedirectUrl(req));
    if (!req.portalPermissions.has(permissionKey)) {
      return res
        .status(403)
        .render('403', { title: 'Not Authorized', message: "You don't have permission to do that.", backHref: '/portal', backLabel: 'Back to My Portals' });
    }
    next();
  };
}

// A real request: "Teacher portal, remove the following tabs and
// features. Business directory, classifieds, resources, store,
// academics, babysitters, reading challenge, store, accounting and
// events. Make sure all teacher portal tabs, buttons and pages stay in
// teacher portal." Resources/Academics/Reading Challenge/the real
// Babysitters directory page already live under requirePortal('parent')
// (routes/parent-portal.js) and were never reachable by a teacher-only
// account in the first place - routes/babysitters.js itself is just a
// shared photo proxy, not a browsable page, so it's untouched. Business
// Directory, Classifieds, Shop, Accounting, and the member Events pages
// (routes/directory.js, classifieds.js, store.js, accounting.js,
// events.js) are the ones any authenticated portal account could
// actually browse - this closes that gap for a TEACHER-ONLY account (no
// other portal role). An account that's ALSO a Parent (self-signed-up to
// teach a class on top of their existing Parent Portal account, a real
// everyday case here) keeps full access to these as a parent, completely
// unaffected - only an account with no role but 'teacher' is blocked.
// Never touches logged-out/public access (req.portalAccount unset) -
// Events/Directory/Classifieds already show their own public-visibility
// items to a signed-out visitor, a separate, intentional concern.
function blockTeacherOnlyAccounts(req, res, next) {
  if (req.portalAccount && req.portalRoles.length > 0 && req.portalRoles.every((r) => r.key === 'teacher')) {
    return res
      .status(403)
      .render('403', { title: 'Not Authorized', message: "This isn't available from the Co-op Teacher Portal.", backHref: '/teacher', backLabel: 'Back to Co-op Teacher Portal' });
  }
  next();
}

module.exports = { loadPortalSession, requirePortalAuth, requirePortal, requirePortalPermission, blockTeacherOnlyAccounts };
