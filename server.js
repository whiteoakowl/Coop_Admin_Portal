require('dotenv').config();
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const db = require('./db'); // initialize database + seed default admin

// The Monday/Wednesday Parent/Student rosters are normally created lazily
// the first time a class enrolls/staffs someone that day - ensure all 4
// always exist up front so they're visible on Attendance immediately, even
// before any classes are set up.
const { ensureDayRoster } = require('./utils/classSchedule');
['monday', 'wednesday'].forEach((day) => {
  ['parent', 'student'].forEach((role) => ensureDayRoster(day, role));
});

const kioskRouter = require('./routes/kiosk');
const checkoutRouter = require('./routes/checkout');
const portalRouter = require('./routes/portal');
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
const adminVolunteersRouter = require('./routes/admin-volunteers');
const adminSubstitutesRouter = require('./routes/admin-substitutes');
const volunteersRouter = require('./routes/volunteers');
const adminSetupRouter = require('./routes/admin-setup');
const setupRouter = require('./routes/setup');
const adminNameTagRouter = require('./routes/admin-name-tag');
const adminScheduleRouter = require('./routes/admin-schedule');
const adminClassScheduleRouter = require('./routes/admin-class-schedule');
const classScheduleRouter = require('./routes/class-schedule');
const contactAdminsRouter = require('./routes/contact-admins');
const membershipRouter = require('./routes/membership');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
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

app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

// Available in every EJS view (including partials/admin-nav) without each
// route having to pass it explicitly. True only for the single master Admin
// account - a Co-op Admin is a member with portal_coop_admin access, let
// into /admin/* by requireAdmin but not treated as a full Admin.
const PORTAL_LABELS = { coop_admin: 'Co-op Admin', parent: 'Parent Portal', student: 'Student Portal' };

app.use((req, res, next) => {
  res.locals.isFullAdmin = !!(req.session && req.session.adminId);
  // A logged-in member's current portal and every portal they're granted -
  // powers the portal switcher when a member holds more than one (e.g. a
  // Co-op Admin who's also a Parent).
  res.locals.portalRole = (req.session && req.session.portalRole) || null;
  res.locals.portalRoles = (req.session && req.session.portalRoles) || [];

  // Drives the shared top bar (partials/portal-topbar) on every portal -
  // who's logged in, what to call their current portal, and where their
  // Profile button goes.
  if (res.locals.isFullAdmin) {
    res.locals.currentPortalLabel = 'Admin Portal';
    res.locals.profileHref = '/admin/settings';
    res.locals.profileInitial = ((req.session.username || 'A')[0] || 'A').toUpperCase();
  } else if (req.session && req.session.portalMemberId && res.locals.portalRole) {
    res.locals.currentPortalLabel = PORTAL_LABELS[res.locals.portalRole] || res.locals.portalRole;
    res.locals.profileHref = '/portal/profile';
    const member = db.prepare('SELECT name FROM members WHERE id = ?').get(req.session.portalMemberId);
    res.locals.profileInitial = member ? member.name[0].toUpperCase() : '?';
  } else {
    res.locals.currentPortalLabel = null;
    res.locals.profileHref = null;
    res.locals.profileInitial = null;
  }
  next();
});

app.get('/', (req, res) => {
  if (req.session && req.session.portalMemberId) return res.redirect('/portal');
  res.render('index', { title: 'SH Check-In / Check-Out', error: null });
});

app.use('/', portalRouter);
app.use('/kiosk', kioskRouter);
app.use('/kiosk', checkoutRouter);
app.use('/', absenceRouter);
app.use('/', nameTagRouter);
app.use('/', volunteersRouter);
app.use('/', setupRouter);
app.use('/', classScheduleRouter);
app.use('/', contactAdminsRouter);
app.use('/', membershipRouter);
// Order matters here: several of these routers gate themselves with a
// blanket `router.use(requireFullAdmin)` (no path), which - because Express
// matches on the shared '/admin' mount prefix, not on that router's own
// route table - runs for ANY /admin/* request that reaches it, not just
// requests one of its own routes would've matched. Mounting those
// full-admin-only routers (Documents, Library, Design/Print, misc badges,
// Members, Name Tag) AFTER every router a Co-op Admin needs (Rosters, Logs,
// Volunteers, Substitutes, Setup, Schedule, Class Schedule) ensures the
// latter's own (permissive) requireAdmin routes get first chance to handle
// the request, instead of being hijacked by an unrelated router's
// full-admin gate before they're ever reached.
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
app.use('/admin', adminNameTagRouter);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

// Catches anything an individual route didn't handle itself (a thrown
// error, a rejected promise passed to next()) so a bug never surfaces a
// raw stack trace to someone using the kiosk - it's logged here instead.
app.use((err, req, res, next) => {
  console.error(err);
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
