require('dotenv').config();
const path = require('path');
const os = require('os');
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
const volunteersRouter = require('./routes/volunteers');
const adminSetupRouter = require('./routes/admin-setup');
const setupRouter = require('./routes/setup');
const adminNameTagRouter = require('./routes/admin-name-tag');
const adminScheduleRouter = require('./routes/admin-schedule');
const { defaultDay } = require('./utils/days');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'sh-check-in-out-dev-secret-change-me',
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
app.use('/admin', adminRouter);
app.use('/admin', adminRostersRouter);
app.use('/admin', adminMembersRouter);
app.use('/admin', adminVolunteersRouter);
app.use('/admin', adminSetupRouter);
app.use('/admin', adminNameTagRouter);
app.use('/admin', adminScheduleRouter);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
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
