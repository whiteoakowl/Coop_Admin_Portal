require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

require('./db'); // initialize database + seed default admin

const kioskRouter = require('./routes/kiosk');
const checkoutRouter = require('./routes/checkout');
const absenceRouter = require('./routes/absence');
const adminRouter = require('./routes/admin');

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
  res.render('index', { title: 'SH Check-In / Check-Out' });
});

app.use('/kiosk', kioskRouter);
app.use('/kiosk', checkoutRouter);
app.use('/', absenceRouter);
app.use('/admin', adminRouter);

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

app.listen(PORT, () => {
  console.log(`SH Check-In/Out running at http://localhost:${PORT}`);
});
