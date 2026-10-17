// Co-op Admin Portal > Teachers/Assistants - a real request: "Add a tab
// called Teachers/Assistants after the classes tab. Teachers/assistants
// shows a lost of Teachers and assistants organized by schedule grid
// semester with a dropdown filter. If a teacher teaches multiple classes
// they will all be listed under the members name with a dropdown arrow
// and minimize feature. You can click on the class and it will go to the
// class. Organized alphabetical by last name. Subpage, instructor
// profiles, list of members who are signed up as teachers with check
// mark for enable/disable instructors profile. Click on each member and
// you can edit their instructor profile. It asks email, phone number,
// about me, experience/qualifications (check box for include this).
// Teachers can edit their instructor profile on the teacher portal if
// they are given permission to view that portal and if their profile has
// been enabled." See routes/teacher-portal.js's own GET/POST /teacher/
// instructor-profile for that self-edit side of the same feature.
const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');
const db = require('../db');
const { byLastName } = require('../utils/members');
const { CLASS_DAY_ORDER } = require('../utils/classDays');
const { allClassesList, staffForClass, listSemesters } = require('../utils/classSchedule');
const { getActiveKioskSemesterId } = require('../utils/kioskSettings');
const { instructorProfilesByMemberIds, instructorProfile, setInstructorProfileEnabled, saveInstructorProfile } = require('../utils/instructorProfiles');

// "Schedule grid semester" is the same active-semester concept the Kiosk
// Settings dropdown drives everywhere else (Classes grid default,
// Volunteers/Setup-Cleanup/Check-in) - defaulting to it here means this
// page opens already scoped to whichever semester is "current" instead of
// an admin having to pick it by hand every time, same as admin-schedule.js's
// own resolveSemesterId. ?semesterId= (including the literal empty string
// from "All Semesters") always wins when present.
async function resolveSemesterId(req) {
  if (req.query.semesterId !== undefined) {
    return req.query.semesterId ? parseInt(req.query.semesterId, 10) : null;
  }
  return getActiveKioskSemesterId();
}

// Every active teacher/assistant staffed on at least one class in scope,
// grouped under their own member record - one entry per class they're
// staffed on, not one entry per class_staff row rendered flat, since the
// real request was explicit: "they will all be listed under the members
// name." allClassesList's own semesterId matching is an EXACT match (no
// semester given means no filter at all - see its own comment) - a
// dedicated "who's teaching this semester" report reading that literally
// is simpler and less surprising than the Classes grid's own "selected
// semester OR untagged" fallback would be here.
async function teachersAndAssistantsForSemester(semesterId) {
  const classes = await allClassesList(null, semesterId);
  const byMember = new Map();
  for (const cls of classes) {
    const staff = await staffForClass(cls.id);
    for (const s of staff) {
      if (!byMember.has(s.id)) byMember.set(s.id, { id: s.id, name: s.name, classes: [] });
      byMember.get(s.id).classes.push({
        id: cls.id,
        className: cls.class_name,
        day: cls.day,
        dayLabel: cls.dayLabel,
        hourPosition: cls.hour_position,
        room: cls.room,
        timeLabel: cls.timeLabel,
        role: s.role,
      });
    }
  }
  const members = [...byMember.values()];
  members.forEach((m) => {
    m.classes.sort((a, b) => CLASS_DAY_ORDER[a.day] - CLASS_DAY_ORDER[b.day] || a.hourPosition - b.hourPosition);
  });
  return members.sort(byLastName);
}

router.get('/teachers', requireAdmin, async (req, res) => {
  const semesterId = await resolveSemesterId(req);
  const members = await teachersAndAssistantsForSemester(semesterId);
  res.render('admin-teachers', {
    title: 'Teachers/Assistants',
    members,
    semesters: await listSemesters(),
    selectedSemesterId: semesterId,
  });
});

// Registered ahead of GET /teachers/instructor-profiles/:id below so
// "instructor-profiles" itself is never swallowed as a member id, same
// reasoning every other admin list's own literal-subpath-before-:id
// route ordering already documents (e.g. routes/main-admin-members.js's
// own grade-level-report).
router.get('/teachers/instructor-profiles', requireAdmin, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT DISTINCT m.id, m.name FROM members m
       JOIN class_staff cs ON cs.member_id = m.id
       WHERE m.active = 1`
    )
    .all();
  const members = rows.sort(byLastName);
  const profiles = await instructorProfilesByMemberIds(members.map((m) => m.id));
  res.render('admin-teachers-instructor-profiles', {
    title: 'Instructor Profiles',
    members: members.map((m) => ({ ...m, profile: profiles[m.id] || null })),
    notice: req.query.notice || null,
  });
});

router.post('/teachers/instructor-profiles/:id/enabled', requireAdmin, async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  await setInstructorProfileEnabled(memberId, !!req.body.enabled);
  res.redirect('/admin/teachers/instructor-profiles');
});

router.get('/teachers/instructor-profiles/:id/edit', requireAdmin, async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) return res.status(404).send('Not found');
  res.render('admin-teachers-instructor-profile-edit', {
    title: `Instructor Profile - ${member.name}`,
    member,
    profile: (await instructorProfile(memberId)) || {},
    backTo: '/admin/teachers/instructor-profiles',
    formAction: `/admin/teachers/instructor-profiles/${memberId}/edit`,
  });
});

router.post('/teachers/instructor-profiles/:id/edit', requireAdmin, async (req, res) => {
  const memberId = parseInt(req.params.id, 10);
  await saveInstructorProfile(memberId, {
    email: (req.body.email || '').trim(),
    phone: (req.body.phone || '').trim(),
    aboutMe: (req.body.aboutMe || '').trim(),
    qualifications: (req.body.qualifications || '').trim(),
    qualificationsVisible: !!req.body.qualificationsVisible,
  });
  res.redirect('/admin/teachers/instructor-profiles?notice=' + encodeURIComponent('Instructor profile saved.'));
});

module.exports = router;
