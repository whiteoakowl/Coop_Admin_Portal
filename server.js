require('dotenv').config();
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { logError } = require('./utils/logger');

// Belt-and-suspenders for anything that escapes Express's own error
// handling entirely - a throw or rejection outside a request (a timer
// callback, something at startup). Node already terminates the process
// for both of these by default (and has since Node 15 for unhandled
// rejections) - continuing to run after either is explicitly against
// Node's own guidance, since the process may now be in an unknown state.
// The only thing added here is making sure it's logged somewhere that
// survives the terminal window being closed before someone notices.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  logError('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  process.exit(1);
});

const db = require('./db'); // initialize database + seed default admin

// Swaps in any staged Restore's uploaded files (member photos, documents,
// design images) - see utils/backup.js's own comments for the full
// design. Must run before anything below (or any route file, once
// required) can create/touch public/uploads/, same reasoning as
// db/index.js's own database swap running before anything opens the
// database.
require('./utils/backup').applyPendingUploadsRestore();

// The Monday/Wednesday Parent/Student rosters are normally created lazily
// the first time a class enrolls/staffs someone that day - ensure all 4
// always exist up front so they're visible on Attendance immediately, even
// before any classes are set up. syncDayMemberRosters then backfills both
// days' roster membership AND member_schedules (the derived Schedule Card
// / profile Class Schedule data) from current enrollment/staffing, so
// existing classes are reflected everywhere on every boot, not just after
// their next edit.
//
// utils/classSchedule.js's own ensureDayRoster/syncDayMemberRosters are
// async now (Supabase/Postgres migration - see MIGRATION.md), but this one
// call site can't await them: require('./server') has to hand back a fully
// bootstrapped `app` synchronously (every test/routes-*.test.js file relies
// on that - they insert rows referencing these 4 rosters' ids immediately
// after requiring this module, no await possible on a require() call), and
// there's no way to block a synchronous module load on a Promise. Rather
// than risk exactly that ordering (confirmed the hard way once, as a
// FOREIGN KEY constraint failure in two test files whose setup hooks ran
// before the async roster-creation chain had resolved), the 4 rosters
// themselves are ensured here with plain synchronous db calls - safe to
// duplicate ensureDayRoster's own tiny query pair since the live db really
// is still synchronous SQLite underneath the async wrapper. Roster
// *membership* sync (syncDayMemberRosters) has no such hard ordering
// requirement - nothing reads it before the first class/floater edit ever
// happens in a fresh database - so that one small piece stays async and
// unawaited here.
const { syncDayMemberRosters } = require('./utils/classSchedule');
function ensureDayRosterSync(day, role) {
  const key = `${day}_${role}_roster_id`;
  const existingId = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (existingId) {
    const existing = db.prepare('SELECT id FROM rosters WHERE id = ?').get(existingId.value);
    if (existing) return existing.id;
  }
  const label = day === 'monday' ? 'Monday' : 'Wednesday';
  const name = `${label} ${role === 'parent' ? 'Parents' : 'Students'}`;
  const info = db.prepare('INSERT INTO rosters (name, category, schedule_day) VALUES (?, ?, ?)').run(name, 'Class Schedule', day);
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(info.lastInsertRowid));
  return info.lastInsertRowid;
}
['monday', 'wednesday'].forEach((day) => {
  ['parent', 'student'].forEach((role) => ensureDayRosterSync(day, role));
  syncDayMemberRosters(day);
});

const { defaultDay } = require('./utils/days');

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

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
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
// earlier audit flagged both). SqliteSessionStore persists sessions in
// the same SQLite file everything else already lives in - see its own
// header comment for why that's a hand-written ~80 lines rather than a
// third-party package.
const SqliteSessionStore = require('./utils/sqliteSessionStore');

app.use(
  session({
    store: new SqliteSessionStore(db),
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

// Available in every EJS view (including partials/admin-nav) without each
// route having to pass it explicitly. True only for the single master Admin
// account. Also generates (once per session) and exposes the CSRF
// synchronizer token every admin page needs to embed - see
// middleware/csrfProtection.js for how it's checked. Only ever generated
// for a session that already has adminId set, so an anonymous visitor to
// a public page never gets a session created just to hold this.
app.use((req, res, next) => {
  const isAdmin = !!(req.session && req.session.adminId);
  res.locals.isFullAdmin = isAdmin;
  if (isAdmin) {
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

app.get('/', (req, res) => {
  res.render('index', { title: 'SH Check-In / Check-Out', error: null, defaultDay: defaultDay() });
});
app.use('/kiosk', kioskRouter);
app.use('/kiosk', checkoutRouter);
app.use('/kiosk/class-checkin', kioskClassCheckinRouter);
app.use('/', absenceRouter);
app.use('/', nameTagRouter);
app.use('/', volunteersRouter);
app.use('/', setupRouter);
app.use('/', contactAdminsRouter);
app.use('/', membershipRouter);
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

// Only binds a port when this file is run directly (`node server.js` /
// `npm start`) - not when something else requires() it. That's what lets
// the route-level tests (test/routes-*.test.js) `require('../server')`
// and get the fully-wired `app` (every router, session/CSRF middleware,
// db init) to drive with supertest, without a real port ever being
// opened or two test files racing over the same one.
if (require.main === module) {
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
}

module.exports = app;
