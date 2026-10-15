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
