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
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const member = db
    .prepare("SELECT * FROM members WHERE username = ? AND active = 1 AND password_hash IS NOT NULL")
    .get(username);

  if (!member || !bcrypt.compareSync(password, member.password_hash)) {
    return res.render('index', { title: 'SH Check-In / Check-Out', error: 'Invalid username or password.' });
  }

  const grantedRoles = PORTAL_ROLE_PRIORITY.filter((role) => member[`portal_${role}`]);
  if (grantedRoles.length === 0) {
    return res.render('index', {
      title: 'SH Check-In / Check-Out',
      error: "This account doesn't have portal access yet. Ask a co-op admin to grant it.",
    });
  }

  req.session.portalMemberId = member.id;
  req.session.portalRoles = grantedRoles;
  req.session.portalRole = grantedRoles[0];
  res.redirect(grantedRoles[0] === 'coop_admin' ? '/admin' : '/portal');
});

router.post('/portal/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
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
