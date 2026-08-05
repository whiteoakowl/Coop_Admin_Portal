require('dotenv').config();
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

require('./db'); // initialize database + seed default admin

const kioskRouter = require('./routes/kiosk');
const checkoutRouter = require('./routes/checkout');
const absenceRouter = require('./routes/absence');
const nameTagRouter = require('./routes/name-tag');
const adminRouter = require('./routes/admin');
const adminRostersRouter = require('./routes/admin-rosters');
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
const { defaultDay } = require('./utils/days');

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

app.get('/', (req, res) => {
  res.render('index', { title: 'SH Check-In / Check-Out', defaultDay: defaultDay() });
});

app.use('/kiosk', kioskRouter);
app.use('/kiosk', checkoutRouter);
app.use('/', absenceRouter);
app.use('/', nameTagRouter);
app.use('/', volunteersRouter);
app.use('/', setupRouter);
app.use('/', classScheduleRouter);
app.use('/admin', adminRouter);
app.use('/admin', adminRostersRouter);
app.use('/admin', adminMembersRouter);
app.use('/admin', adminVolunteersRouter);
app.use('/admin', adminSubstitutesRouter);
app.use('/admin', adminSetupRouter);
app.use('/admin', adminNameTagRouter);
app.use('/admin', adminScheduleRouter);
app.use('/admin', adminClassScheduleRouter);

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
