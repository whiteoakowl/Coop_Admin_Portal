require('dotenv').config();
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { logError } = require('./utils/logger');

// True only for a real `node server.js` run (the normal local/LAN install
// - see the require.main === module block near the bottom of this file);
// false when this module is `require()`d by something else instead -
// every test/routes-*.test.js file, and netlify/functions/app.js for the
// Netlify deployment. That distinction matters a lot for the two process
// event handlers and bootReady's own catch below: process.exit() is the
// right call for a real standalone server process (fail fast rather than
// limp along in an unknown state), but it's actively harmful inside a
// Netlify Function - Netlify reuses warm containers across requests, so
// exiting the process there kills the *whole container*, not just the
// one request that happened to trigger the error, showing up to a real
// user as an opaque "Runtime exited with error: exit status 1" with none
// of the actual error detail Netlify's own function logs would otherwise
// show. Confirmed against a real deploy: an error in one route (the
// public floater-assignment chart) took down the *next*, completely
// unrelated request (the admin login page) the same way.
const IS_MAIN_PROCESS = require.main === module;

// Belt-and-suspenders for anything that escapes Express's own error
// handling entirely - a throw or rejection outside a request (a timer
// callback, something at startup). Node already terminates the process
// for both of these by default (and has since Node 15 for unhandled
// rejections) - continuing to run after either is explicitly against
// Node's own guidance for a real long-running server, since the process
// may now be in an unknown state; that guidance doesn't apply the same
// way inside a Netlify Function (see IS_MAIN_PROCESS above), where each
// invocation is already a fresh, isolated call and forcibly exiting only
// makes the failure harder to diagnose. The logging (console.error +
// logError) always happens either way.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  logError('uncaughtException', err);
  if (IS_MAIN_PROCESS) process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  if (IS_MAIN_PROCESS) process.exit(1);
});

const db = require('./db'); // constructs the db handle; db.ready resolves once schema + first-boot seeding are done (see db/index.js)

// The Monday/Wednesday Parent/Student rosters are normally created lazily
// the first time a class enrolls/staffs someone that day - ensure all 4
// always exist up front so they're visible on Attendance immediately, even
// before any classes are set up. syncDayMemberRosters then backfills both
// days' roster membership AND member_schedules (the derived Schedule Card
// / profile Class Schedule data) from current enrollment/staffing, so
// existing classes are reflected everywhere on every boot, not just after
// their next edit.
const { ensureDayRoster, syncDayMemberRosters } = require('./utils/classSchedule');
async function bootRosters() {
  for (const day of ['monday', 'wednesday']) {
    for (const role of ['parent', 'student']) await ensureDayRoster(day, role);
    await syncDayMemberRosters(day);
  }
}

// `require('./server')` can no longer hand back a fully-bootstrapped `app`
// synchronously the way it could when the db underneath was still
// synchronous SQLite - db.ready and the roster seeding above are both
// necessarily async now. app.ready (set near the bottom of this file,
// once every route/middleware below is registered) is that same
// guarantee, just explicit instead of implicit: every test/routes-*.test.js
// file now does `await app.ready` right after requiring this module and
// before its own setup queries or first request, instead of relying on
// require() itself having already blocked until boot finished. See
// MIGRATION.md for the full story on why this changed.
const bootReady = db.ready.then(() => bootRosters());
bootReady.catch((err) => {
  console.error('Server failed to boot:', err);
  if (IS_MAIN_PROCESS) process.exit(1);
});

const kioskRouter = require('./routes/kiosk');
const checkoutRouter = require('./routes/checkout');
const kioskClassCheckinRouter = require('./routes/kiosk-class-checkin');
const absenceRouter = require('./routes/absence');
const nameTagRouter = require('./routes/name-tag');
const adminRouter = require('./routes/admin');
const adminRostersRouter = require('./routes/admin-rosters');
const adminLogsRouter = require('./routes/admin-logs');
const adminDocumentsRouter = require('./routes/admin-documents');
const adminLibraryRouter = require('./routes/admin-library');
const adminDesignRouter = require('./routes/admin-design');
const adminMiscBadgesRouter = require('./routes/admin-misc-badges');
const adminMembersRouter = require('./routes/admin-members');
const adminSearchRouter = require('./routes/admin-search');
const adminVolunteersRouter = require('./routes/admin-volunteers');
const adminSubstitutesRouter = require('./routes/admin-substitutes');
const volunteersRouter = require('./routes/volunteers');
const adminSetupRouter = require('./routes/admin-setup');
const setupRouter = require('./routes/setup');
const adminNameTagRouter = require('./routes/admin-name-tag');
const adminScheduleRouter = require('./routes/admin-schedule');
const adminClassScheduleRouter = require('./routes/admin-class-schedule');
const contactAdminsRouter = require('./routes/contact-admins');
const membershipRouter = require('./routes/membership');
const trainingRouter = require('./routes/training');
const adminTrainingRouter = require('./routes/admin-training');
const publicSiteRouter = require('./routes/public-site');
const portalAuthRouter = require('./routes/portal-auth');
const parentPortalRouter = require('./routes/parent-portal');
const mainAdminRouter = require('./routes/main-admin');
// Community & Commerce track (Track B, TEAM_B_HANDOFF.md) - member/
// public-facing Events at /events, admin Events management folded into
// the Main Admin Portal's own URL namespace at /main-admin/events (a
// sibling router, not an edit to routes/main-admin.js itself, which is
// on Track A's hard-boundary list).
const eventsRouter = require('./routes/events');
const adminEventsRouter = require('./routes/admin-events');
// Item 4: Business Directory at /directory, Classifieds at /classifieds,
// same sibling-router shape as Events above.
const directoryRouter = require('./routes/directory');
const adminDirectoryRouter = require('./routes/admin-directory');
const classifiedsRouter = require('./routes/classifieds');
const adminClassifiedsRouter = require('./routes/admin-classifieds');
// Item 5: Member Directory at /member-directory (members-only, no public
// browsing - real personal contact info), settings admin at
// /main-admin/member-directory.
const memberDirectoryRouter = require('./routes/member-directory');
const adminMemberDirectoryRouter = require('./routes/admin-member-directory');
// Item 6: Forums at /forums (members-only; category access additionally
// restricted for private class forums), category management admin at
// /main-admin/forums.
const forumsRouter = require('./routes/forums');
const adminForumsRouter = require('./routes/admin-forums');
// Item 7: Custom Forms at /forms (members-only; open unless targeted at
// specific people/roles), builder admin at /main-admin/forms.
const customFormsRouter = require('./routes/custom-forms');
const adminCustomFormsRouter = require('./routes/admin-custom-forms');
// Item 9 (built ahead of item 8 - Store depends on it): Accounting at
// /accounting (would live in the Parent Portal's own tab, but that
// router/views are off-limits - a sibling top-level page instead),
// admin at /main-admin/accounting.
const accountingRouter = require('./routes/accounting');
const adminAccountingRouter = require('./routes/admin-accounting');
// Item 8: Store at /store (members-only online checkout, wired through
// the payment abstraction above), admin at /main-admin/store (also
// records in-person sales, recorded distinctly from an online order).
const storeRouter = require('./routes/store');
const adminStoreRouter = require('./routes/admin-store');
// Item 10: Weekly Newsletter at /newsletter (members-only archive of
// status='sent' issues - there is no real outbound email, see
// utils/newsletter.js's own header comment), assembly/edit/send admin at
// /main-admin/newsletter (manage_communications).
const newsletterRouter = require('./routes/newsletter');
const adminNewsletterRouter = require('./routes/admin-newsletter');
const { loadPortalSession } = require('./middleware/portalAuth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
// __dirname is correct for a normal `node server.js` run, but esbuild
// bundles this whole file (and everything it requires) into one file
// living at netlify/functions/app.js for the Netlify deployment - at
// runtime there, __dirname resolves to that bundle's own directory, not
// this file's original location, so a plain __dirname-relative path can't
// find the real views/ directory. LAMBDA_TASK_ROOT is set by the Lambda
// runtime Netlify Functions run on (never set for a normal local/LAN
// install) and points at /var/task, matching where netlify.toml's
// `included_files` actually copies views/ to - see that file's own
// comment on this same problem for ejs's require().
const viewsRoot = process.env.LAMBDA_TASK_ROOT || __dirname;
app.set('views', path.join(viewsRoot, 'views'));

// Real bug: body-parser's urlencoded parser defaults to parameterLimit:
// 1000 - a hard PayloadTooLargeError (500), not just slowness. Every bulk
// print form (Name Tags, Schedule Cards, "Name Tags + Schedule Cards") and
// the Members bulk archive/restore submit one memberIds= field per checked
// row plus _csrf, so a co-op with exactly ~1000 members hitting "Select
// All" already tips over that cap - confirmed live: 1000 memberIds fields
// (1001 params with _csrf) 500'd instead of rendering. Raised well past
// the requested 1000-card ceiling so a real co-op has headroom to grow.
app.use(express.urlencoded({ extended: true, parameterLimit: 20000 }));
app.use(express.json());

// Stops a browser from ever re-guessing a served file's type from its
// content instead of the Content-Type header we/express.static actually
// sent - relevant because express.static derives that header from a
// file's extension, and every upload in this app (member photos, design
// images, documents) already gets its extension checked against its
// declared mimetype before being saved (see utils/uploads.js) specifically
// so nothing ever gets served as a type it wasn't validated as.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Falling back to a fixed, source-controlled secret would let anyone who's
// seen this repo forge a valid admin session cookie against any install
// that forgot to set SESSION_SECRET. A random secret is generated instead
// so a missed .env entry fails safe - admins just get logged out on
// restart rather than the app running with a publicly-known secret.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('\nSESSION_SECRET is not set in .env - using a random secret for this run.');
  console.warn('Admins will be logged out every time the server restarts until you set SESSION_SECRET in .env.\n');
}

// Most real deployments of this app are a bare `node server.js` on a
// co-op's own LAN, reached over plain http:// by kiosk devices (see
// lanAddresses() below) - hardcoding `secure: true` would silently break
// every login on that setup (browsers refuse to send a Secure cookie
// back over http://). `secure: 'auto'` covers the case that matters
// without that risk: it marks the cookie Secure only when the request
// Express itself sees is actually HTTPS, and leaves plain HTTP alone.
//
// That still won't mark it Secure if you put a TLS-terminating reverse
// proxy (nginx, Caddy, a tunnel) in front - Express sees the proxy's
// plain-HTTP connection, not the client's real HTTPS one - unless the
// proxy's X-Forwarded-Proto header is trusted, which TRUST_PROXY opts
// into explicitly (never on by default: trusting that header from an
// app reachable directly, with no real proxy in front, lets anyone set
// it themselves and downgrade their own connection's cookie security).
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Without an explicit `store`, express-session falls back to its own
// MemoryStore - fine for local development, but wrong for anything this
// app actually deploys as: every admin gets logged out on every restart/
// deploy, and MemoryStore never evicts anything on its own, so its memory
// footprint only ever grows for the life of the process (this app's own
// earlier audit flagged both). PgSessionStore persists sessions in the
// same database everything else already lives in (real Postgres in
// production, PGlite locally - see db/index.js), same reasoning
// node:sqlite's own hand-written session store used to have.
const PgSessionStore = require('./utils/pgSessionStore');

app.use(
  session({
    store: new PgSessionStore(db),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
    },
  })
);

// Member portal platform (Parent/Student/Teacher/Co-op Admin/Main Admin
// logins - see middleware/portalAuth.js) - loaded globally, ahead of
// every route, so res.locals.portalAccount/portalRoles are available to
// any view (the public homepage's header needs to know whether to show
// "Log In" or "My Portals") without every route computing it itself.
// Completely independent of the single shared Admin session below.
app.use(loadPortalSession);

// Member photos may live in Supabase Storage or on local disk (see
// utils/uploadBackend.js and MIGRATION.md) - computed once at boot, not
// per-request, since createStorageClient() just builds a lightweight
// client object from env vars with no network call of its own. Exposed
// to every EJS view below as photoUrl(key) so templates (member list/
// profile/edit forms, roster grid, print picker) can render a
// members.photo_path value without each route file having to resolve it
// first and thread the result through res.render()'s data separately.
const { createStorageClient } = require('./utils/storage');
const { urlForUpload } = require('./utils/uploadBackend');
const memberPhotosClient = createStorageClient();
function photoUrl(key) {
  return urlForUpload({ client: memberPhotosClient, bucket: 'member-photos', webDir: '/uploads/members', key });
}
// Training lesson resource images (routes/admin-training.js) - same
// client works for any bucket, so this reuses memberPhotosClient rather
// than standing up a second one.
function trainingResourceUrl(key) {
  return urlForUpload({ client: memberPhotosClient, bucket: 'training-resources', webDir: '/uploads/training', key });
}

// Available in every EJS view (including partials/admin-nav) without each
// route having to pass it explicitly. True only for the single master Admin
// account. Also generates (once per session) and exposes the CSRF
// synchronizer token every admin page needs to embed - see
// middleware/csrfProtection.js for how it's checked. Only ever generated
// for a session that already has adminId set, so an anonymous visitor to
// a public page never gets a session created just to hold this.
app.use((req, res, next) => {
  const isAdmin = !!(req.session && req.session.adminId);
  const isPortalSession = !!(req.session && req.session.portalAccountId);
  res.locals.isFullAdmin = isAdmin;
  res.locals.photoUrl = photoUrl;
  res.locals.trainingResourceUrl = trainingResourceUrl;
  if (isAdmin || isPortalSession) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrfToken;
    // A fixed point in time, not a sliding window - this app's session
    // isn't `rolling`, so cookie.expires is set once at login and stays
    // put across every later request (see the Cookie source itself:
    // setting `maxAge` sets `expires` as a side effect, once, at
    // creation). That's exactly what public/js/session-timeout-warning.js
    // needs: an absolute deadline to count down to, not an estimate.
    res.locals.sessionExpiresAt = req.session.cookie.expires ? req.session.cookie.expires.toISOString() : null;
  } else {
    res.locals.csrfToken = null;
    res.locals.sessionExpiresAt = null;
  }
  next();
});

// The site root used to BE the kiosk landing screen (views/index.ejs) -
// now the new public marketing homepage instead (routes/public-site.js).
// views/kiosk-home.ejs already renders that exact same kiosk screen,
// unchanged, at /kiosk (it always has - see that route's own comment),
// so nothing about the kiosk experience itself was touched; a physical
// kiosk device just needs its own browser bookmark repointed from / to
// /kiosk once.
app.use('/', publicSiteRouter);
app.use('/kiosk', kioskRouter);
app.use('/kiosk', checkoutRouter);
app.use('/kiosk/class-checkin', kioskClassCheckinRouter);
// The new member portal platform - login/registration are public routes
// (no session yet), Parent/Main Admin are each gated by their own role
// (middleware/portalAuth.js's requirePortal), completely independent of
// both the kiosk's no-login model and the single shared Admin login.
app.use('/', require('./middleware/csrfProtection'));
app.use('/', portalAuthRouter);
app.use('/parent', parentPortalRouter);
app.use('/main-admin', mainAdminRouter);
app.use('/events', eventsRouter);
app.use('/main-admin/events', adminEventsRouter);
app.use('/directory', directoryRouter);
app.use('/main-admin/directory', adminDirectoryRouter);
app.use('/classifieds', classifiedsRouter);
app.use('/main-admin/classifieds', adminClassifiedsRouter);
app.use('/member-directory', memberDirectoryRouter);
app.use('/main-admin/member-directory', adminMemberDirectoryRouter);
app.use('/forums', forumsRouter);
app.use('/main-admin/forums', adminForumsRouter);
app.use('/forms', customFormsRouter);
app.use('/main-admin/forms', adminCustomFormsRouter);
app.use('/accounting', accountingRouter);
app.use('/main-admin/accounting', adminAccountingRouter);
app.use('/store', storeRouter);
app.use('/main-admin/store', adminStoreRouter);
app.use('/newsletter', newsletterRouter);
app.use('/main-admin/newsletter', adminNewsletterRouter);
// contact-admins.js and membership.js (both mounted below) gate every one
// of their own routes behind requireAdmin/requireFullAdmin despite living
// outside the '/admin' path prefix (their URLs read as top-level, not
// admin-namespaced) - a real gap this used to miss: middleware/
// csrfProtection.js was only ever mounted ahead of the '/admin' routers
// further down, so these two authenticated, state-changing routers had no
// CSRF check at all. csrfProtection itself is a no-op for any request
// without an admin session, so mounting it here ahead of this whole
// router group is safe for its public/kiosk routers too (absence,
// name-tag, volunteers, setup, training all have no admin session to
// forge a request against in the first place).
app.use('/', require('./middleware/csrfProtection'));
app.use('/', absenceRouter);
app.use('/', nameTagRouter);
app.use('/', volunteersRouter);
app.use('/', setupRouter);
app.use('/', contactAdminsRouter);
app.use('/', membershipRouter);
app.use('/', trainingRouter);
// Order matters here: several of these routers gate themselves with a
// blanket `router.use(requireFullAdmin)` (no path), which - because Express
// matches on the shared '/admin' mount prefix, not on that router's own
// route table - runs for ANY /admin/* request that reaches it, not just
// requests one of its own routes would've matched. Mounting those routers
// (Documents, Library, Design/Print, misc badges, Members, Name Tag) AFTER
// every other /admin router ensures the latter's own requireAdmin routes
// get first chance to handle the request, instead of being hijacked by an
// unrelated router's blanket gate before they're ever reached.
app.use('/admin', require('./middleware/csrfProtection'));
app.use('/admin', adminRouter);
app.use('/admin', adminRostersRouter);
app.use('/admin', adminLogsRouter);
app.use('/admin', adminVolunteersRouter);
app.use('/admin', adminSubstitutesRouter);
app.use('/admin', adminSetupRouter);
app.use('/admin', adminTrainingRouter);
app.use('/admin', adminScheduleRouter);
app.use('/admin', adminClassScheduleRouter);
app.use('/admin', adminDocumentsRouter);
app.use('/admin', adminLibraryRouter);
app.use('/admin', adminDesignRouter);
app.use('/admin', adminMiscBadgesRouter);
app.use('/admin', adminMembersRouter);
app.use('/admin', adminSearchRouter);
app.use('/admin', adminNameTagRouter);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

// Catches anything an individual route didn't handle itself (a thrown
// error, a rejected promise passed to next()) so a bug never surfaces a
// raw stack trace to someone using the kiosk - it's logged here instead.
// req/next are unused in the body but required in the signature - Express
// identifies an error handler by checking fn.length === 4.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  logError(`${req.method} ${req.originalUrl}`, err);
  res.status(500).render('500', { title: 'Error' });
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

// Resolves once the database is ready (schema + first-boot seeding) and
// the 4 always-exist rosters are seeded - see bootReady's own definition
// above for why require('./server') can't give these guarantees
// synchronously anymore. `test/routes-*.test.js` files must `await
// app.ready` right after requiring this module, before their own setup
// queries or first supertest request - the same guarantee node:sqlite's
// synchronous boot used to give implicitly.
app.ready = bootReady;

// Only binds a port when this file is run directly (`node server.js` /
// `npm start`) - not when something else requires() it. That's what lets
// the route-level tests (test/routes-*.test.js) `require('../server')`
// and get the fully-wired `app` (every router, session/CSRF middleware,
// db init) to drive with supertest, without a real port ever being
// opened or two test files racing over the same one. Waits for app.ready
// first so the server never accepts a real request before boot (schema/
// seeding/roster setup) has actually finished.
if (require.main === module) {
  app.ready
    .then(() => {
      const server = app.listen(PORT, () => {
        console.log(`Sanford Homeschoolers Check-In/Out running at http://localhost:${PORT}`);
        const addresses = lanAddresses();
        if (addresses.length > 0) {
          console.log('On this same wifi network, other devices (like a second kiosk) can reach it at:');
          for (const addr of addresses) console.log(`  http://${addr}:${PORT}`);
        }
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`\nSomething else on this computer is already using port ${PORT}, so the server can't start.`);
          console.error(`Close that other program, or open the .env file and change PORT to a different number (e.g. 3001), then try again.\n`);
        } else {
          console.error('\nThe server failed to start:', err.message, '\n');
        }
        process.exitCode = 1;
      });
    })
    // Already logged + process.exit(1) by bootReady's own .catch() above -
    // this second catch only exists so a boot failure doesn't also print
    // Node's default "unhandled promise rejection" noise on top of that.
    .catch(() => {});
}

module.exports = app;
