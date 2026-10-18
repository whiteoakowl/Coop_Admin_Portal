const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePortalAuth } = require('../middleware/portalAuth');
const { memberForAccount } = require('../utils/portalAuth');
const { activeAdminPositionsWithRecipients, recipientEmailsForPosition } = require('../utils/adminPositions');
const emailProvider = require('../utils/emailProvider');

// A real request: "On parent, student and teacher portal on mobile add an
// email icon at the top for contacting group leaders. On desktop it says
// contact admins." This page used to be Co-op-Admin-only (requireAdmin),
// sourced from the orphaned leadership_contacts table - repurposed per the
// requester's own choice to reuse the existing Admin Positions feature for
// the department dropdown and reopen the page itself to every portal
// (requirePortalAuth, same gate Chat/Store/Photos already use), not just
// Co-op Admin.
//
// portalTitle resolution mirrors res.locals.sharedPortalTitle
// (middleware/portalAuth.js), extended to cover Teacher and Main Admin too
// (sharedPortalTitle only ever disambiguates Parent vs. Student) - needed
// here since partials/portal-nav.ejs itself requires an exact portalTitle
// string to pick the right nav shell.
function resolvePortalTitle(req) {
  const roles = req.portalRoles || [];
  const hasParent = roles.some((r) => r.key === 'parent');
  const hasStudent = roles.some((r) => r.key === 'student');
  const hasTeacher = roles.some((r) => r.key === 'teacher');
  const hasMainAdmin = roles.some((r) => r.key === 'main_admin');
  const requestedPortal = req.query.portal;
  if (requestedPortal === 'parent' && hasParent) return 'Parent Portal';
  if (requestedPortal === 'student' && hasStudent) return 'Student Portal';
  if (requestedPortal === 'teacher' && hasTeacher) return 'Teacher Portal';
  if (hasParent) return 'Parent Portal';
  if (hasStudent) return 'Student Portal';
  if (hasTeacher) return 'Teacher Portal';
  if (hasMainAdmin) return 'Main Admin';
  return 'Parent Portal';
}

// TEMPORARY diagnostic route (see MIGRATION.md's "Session update: the
// first real production deployment" troubleshooting notes - this is the
// same "plain-text GET route showing the real underlying error instead
// of the generic 500 page" pattern that found the tableHasIdColumn/
// auth.sessions bug during the first real deploy). A real bug report:
// the live Contact Admins page shows the generic "Something went wrong"
// error, with no Netlify log access on the free tier to see why.
// Deliberately open (no requirePortalAuth) and checks each query this
// feature depends on one at a time, so it still reports something useful
// even if auth/session handling itself turns out to be part of the
// problem. Remove this route once the real cause is found.
router.get('/contact-admins-diagnostic', async (req, res) => {
  res.type('text/plain');
  const lines = [];

  try {
    const positions = await db.prepare('SELECT * FROM admin_positions ORDER BY position, LOWER(title)').all();
    lines.push(`1. admin_positions query: OK (${positions.length} row(s))`);
  } catch (err) {
    lines.push(`1. admin_positions query: FAILED - ${err.message}`);
    return res.send(lines.join('\n'));
  }

  try {
    const rows = await db
      .prepare(
        `SELECT map.admin_position_id AS "positionId", map.contact_email AS "contactEmail", m.id, m.name, m.email, m.phone
         FROM member_admin_positions map JOIN members m ON m.id = map.member_id
         ORDER BY LOWER(m.name)`
      )
      .all();
    lines.push(`2. member_admin_positions join (reads the contact_email column): OK (${rows.length} row(s))`);
  } catch (err) {
    lines.push(`2. member_admin_positions join (reads the contact_email column): FAILED - ${err.message}`);
    return res.send(lines.join('\n'));
  }

  try {
    const departments = await activeAdminPositionsWithRecipients();
    lines.push(`3. activeAdminPositionsWithRecipients(): OK (${departments.length} department(s) with at least one recipient)`);
  } catch (err) {
    lines.push(`3. activeAdminPositionsWithRecipients(): FAILED - ${err.message}`);
    return res.send(lines.join('\n'));
  }

  try {
    const row = await db.prepare('SELECT COUNT(*) AS "c" FROM contact_admin_messages').get();
    lines.push(`4. contact_admin_messages query: OK (${row.c} row(s))`);
  } catch (err) {
    lines.push(`4. contact_admin_messages query: FAILED - ${err.message}`);
    return res.send(lines.join('\n'));
  }

  lines.push('', 'All 4 checks passed - the error is most likely in session/auth handling (req.portalAccount, memberForAccount) or the view template itself, not these queries.');
  res.send(lines.join('\n'));
});

router.get('/contact-admins', requirePortalAuth, async (req, res) => {
  const [departments, member] = await Promise.all([
    activeAdminPositionsWithRecipients(),
    memberForAccount(req.portalAccount.id),
  ]);
  res.render('contact-admins', {
    title: 'Contact Admins',
    portalTitle: resolvePortalTitle(req),
    portalQueryString: req.query.portal ? '?portal=' + encodeURIComponent(req.query.portal) : '',
    departments,
    senderEmail: (member && member.email) || '',
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Builds /contact-admins?portal=teacher&notice=... (or &error=...) -
// req.query.portal (set by contactAdminsPortalQuery in portal-nav.ejs)
// has to survive the redirect too, or a dual-role account's next GET would
// lose the portal it actually clicked from, the exact bug class
// sharedPortalTitle's own comment (middleware/portalAuth.js) describes.
function redirectTo(req, res, params) {
  const query = new URLSearchParams(req.query.portal ? { portal: req.query.portal } : {});
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  res.redirect('/contact-admins?' + query.toString());
}

router.post('/contact-admins', requirePortalAuth, async (req, res) => {
  const positionId = parseInt(req.body.positionId, 10);
  const title = (req.body.title || '').trim();
  const message = (req.body.message || '').trim();
  const member = await memberForAccount(req.portalAccount.id);
  const senderEmail = (member && member.email) || '';

  if (!positionId || !title || !message) {
    return redirectTo(req, res, { error: 'Please fill in every field.' });
  }

  const [department, recipients] = await Promise.all([
    db.prepare('SELECT title FROM admin_positions WHERE id = ?').get(positionId),
    recipientEmailsForPosition(positionId),
  ]);
  if (!department) {
    return redirectTo(req, res, { error: 'Please choose a department.' });
  }

  await db.prepare(
    'INSERT INTO contact_admin_messages (leadership_team, sender_email, sender_name, sender_member_id, title, message, recipient_email) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(department.title, senderEmail, (member && member.name) || null, (member && member.id) || null, title, message, recipients.join(', ') || null);

  for (const recipientEmail of recipients) {
    await emailProvider.send(recipientEmail, 'Contact Admins: ' + title, message + '\n\nFrom: ' + (senderEmail || 'a co-op member'));
  }

  redirectTo(req, res, { notice: 'Your message was sent to ' + department.title + '.' });
});

module.exports = router;
