// A second, independent layer of CSRF defense alongside the session
// cookie's own sameSite:'lax' setting (server.js) - a synchronizer token
// held in the admin session itself, not a separate double-submit cookie,
// since an authenticated admin session already exists by the time this
// ever matters (mounted ahead of every /admin router, all of which are
// already gated by requireAdmin/requireFullAdmin) and storing the token
// there costs nothing a session wasn't already paying for. Every
// state-changing request from an authenticated admin session must echo
// back the same token the page it came from was rendered with - either
// the hidden form field public/js/csrf.js adds to every POST form
// automatically, or the X-CSRF-Token header the app's own fetch()-based
// admin actions (attendance autosave, library scan, name tag/schedule
// card design saves) send explicitly. A mismatch or missing token is
// rejected outright.
//
// Multipart (file-upload) forms are a third case, checked via
// req.query._csrf instead of req.body._csrf: this middleware is mounted
// ahead of every /admin router (server.js), including the per-route
// upload.single(...) middleware that actually parses a multipart body -
// so req.body._csrf isn't populated yet by the time this file's checks
// run for those requests (express.urlencoded/json, mounted globally,
// don't touch multipart/form-data bodies at all). req.query is parsed by
// Express itself before any app middleware runs, so it's available here
// regardless. public/js/csrf.js appends the token to a multipart form's
// action URL for exactly this reason - see its own comment.
//
// Deliberately scoped to admin sessions only: the kiosk and every other
// public-facing POST (check-in, find-a-parent, absence/name-tag forms)
// has no authenticated session for a forged cross-site request to ride
// along on in the first place - the CSRF threat model doesn't apply to
// a route anyone can already call directly by design (see
// routes/kiosk.js's own comments on why that's intentional), and no
// session exists there to store a token to check them against without
// creating one for every anonymous visitor for zero real benefit.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

module.exports = function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.session || !req.session.adminId) return next(); // no admin session yet - requireAdmin will handle it

  const submitted = (req.body && req.body._csrf) || req.query._csrf || req.get('X-CSRF-Token');
  if (submitted && submitted === req.session.csrfToken) return next();

  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  const message = 'Your session was open too long and needs a refresh before this action can be confirmed. Please reload the page and try again.';
  if (wantsJson) return res.status(403).json({ ok: false, error: message });
  res.status(403).render('403', { title: 'Session Expired', message });
};
