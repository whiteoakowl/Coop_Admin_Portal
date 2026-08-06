const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const requireMemberPortal = require('../middleware/requireMemberPortal');
const { familyOf } = require('../utils/members');
const { gridForDay, DAYS, DAY_LABELS } = require('../utils/classSchedule');
const { defaultDay } = require('../utils/days');
const { formatDateLabel, formatTime } = require('../utils/dates');

// Checked in priority order when a member has been granted more than one
// portal - Co-op Admin first (the more privileged surface), then Parent,
// then Student. The portal switcher (once a member is logged in) lets them
// move between every portal they're actually granted.
const PORTAL_ROLE_PRIORITY = ['coop_admin', 'parent', 'student'];

router.post('/login', (req, res) => {
  // The sign-in card asks for "Email Address" (matching members' own
  // contact email), but accounts are still set up with an admin-chosen
  // username - so a login attempt matches either, whichever the member
  // actually types.
  const identifier = (req.body.username || '').trim();
  const password = req.body.password || '';
  const member = db
    .prepare(
      "SELECT * FROM members WHERE (username = ? OR email = ?) AND active = 1 AND password_hash IS NOT NULL"
    )
    .get(identifier, identifier);

  if (!member || !bcrypt.compareSync(password, member.password_hash)) {
    return res.redirect('/');
  }

  const grantedRoles = PORTAL_ROLE_PRIORITY.filter((role) => member[`portal_${role}`]);
  if (grantedRoles.length === 0) {
    return res.redirect('/');
  }

  req.session.portalMemberId = member.id;
  req.session.portalRoles = grantedRoles;
  req.session.portalRole = grantedRoles[0];
  res.redirect(grantedRoles[0] === 'coop_admin' ? '/admin' : '/portal');
});

router.post('/portal/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Switches which of a member's granted portals is active this session -
// only ever between roles they actually hold, so this can't be used to
// grant access they weren't given on their profile.
router.post('/portal/switch-role', requireMemberPortal, (req, res) => {
  const role = req.body.role;
  if (req.session.portalRoles && req.session.portalRoles.includes(role)) {
    req.session.portalRole = role;
  }
  res.redirect(req.session.portalRole === 'coop_admin' ? '/admin' : '/portal');
});

// A Student only ever sees their own info; a Parent sees their whole
// family group (themselves plus anyone sharing their family_id).
function familyMembersFor(member, portalRole) {
  if (portalRole === 'student') return [member];
  return [member, ...familyOf(member.id)];
}

function recentAttendanceFor(memberIds) {
  if (memberIds.length === 0) return [];
  const placeholders = memberIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT a.session_date, a.status, a.check_in_time, m.name AS memberName
       FROM attendance a JOIN members m ON m.id = a.member_id
       WHERE a.member_id IN (${placeholders})
       ORDER BY a.session_date DESC, a.recorded_at DESC
       LIMIT 15`
    )
    .all(...memberIds)
    .map((r) => ({
      dateLabel: formatDateLabel(r.session_date),
      status: r.status,
      memberName: r.memberName,
      checkInTime: formatTime(r.check_in_time),
    }));
}

// This week's classes any family member is enrolled in (as a student) or
// staffing (as teacher/assistant), across both session days.
function classScheduleFor(memberIds) {
  const idSet = new Set(memberIds);
  return DAYS.map((day) => {
    const items = [];
    gridForDay(day).forEach((hour) => {
      hour.classes.forEach((cls) => {
        const myStudents = cls.students.filter((s) => idSet.has(s.id));
        const myStaff = cls.staff.filter((s) => idSet.has(s.id));
        if (myStudents.length === 0 && myStaff.length === 0) return;
        const roles = [
          ...myStudents.map((s) => `${s.name} (Student)`),
          ...myStaff.map((s) => `${s.name} (${s.role === 'teacher' ? 'Teacher' : 'Assistant'})`),
        ];
        items.push({ hourLabel: hour.label, className: cls.class_name, room: cls.room, roles });
      });
    });
    return { day, dayLabel: DAY_LABELS[day], items };
  });
}

// Every portal member's account hub - basic info + a self-service password
// change (only Full Admin gets its own account page at /admin/settings;
// everyone else's Profile button lands here). Also where Log Out lives for
// the Parent/Student portal, since the shared top bar doesn't have room
// for it (see partials/portal-topbar.ejs).
router.get('/portal/profile', requireMemberPortal, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.session.portalMemberId);
  if (!member) {
    req.session.destroy(() => res.redirect('/'));
    return;
  }
  res.render('portal-profile', {
    title: 'Profile',
    member,
    portalRole: req.session.portalRole,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/portal/profile/password', requireMemberPortal, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.session.portalMemberId);
  if (!member) {
    req.session.destroy(() => res.redirect('/'));
    return;
  }

  const { currentPassword, newPassword } = req.body;
  if (!bcrypt.compareSync(currentPassword || '', member.password_hash)) {
    return res.redirect('/portal/profile?error=' + encodeURIComponent('Current password is incorrect.'));
  }
  if (!newPassword || newPassword.length < 8) {
    return res.redirect('/portal/profile?error=' + encodeURIComponent('New password must be at least 8 characters.'));
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hash, member.id);
  res.redirect('/portal/profile?notice=' + encodeURIComponent('Password updated.'));
});

router.get('/portal', requireMemberPortal, (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.session.portalMemberId);
  if (!member) {
    req.session.destroy(() => res.redirect('/'));
    return;
  }
  const portalRole = req.session.portalRole;
  const familyMembers = familyMembersFor(member, portalRole);
  const familyMemberIds = familyMembers.map((m) => m.id);

  res.render('portal-home', {
    title: `${portalRole === 'student' ? 'Student' : 'Parent'} Portal`,
    member,
    portalRole,
    familyMembers,
    recentAttendance: recentAttendanceFor(familyMemberIds),
    classSchedule: classScheduleFor(familyMemberIds),
    defaultDay: defaultDay(),
  });
});

module.exports = router;
