const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, todayISO, weekdayOf } = require('../utils/dates');
const { parseNamesFromUpload, findMemberByName, hasInfantChild, activeParentOptions } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { defaultDay, requireDay } = require('../utils/days');
const { hoursForDay } = require('../utils/classSchedule');
const {
  DAY_LABELS,
  RANKS,
  RANK_LABELS,
  getListByDay,
  sectionsForList,
  datesForList,
  membersForSection,
  setSectionRank,
  removeMemberFromSection,
  addMemberToSection,
} = require('../utils/volunteers');
const {
  permanentJobsForDay,
  floaterIdsForJob,
  floaterMembersForHour,
  substituteBoard,
  jobAssignmentGrid,
} = require('../utils/substitutes');
const { jsonScriptSafe } = require('../utils/json');

const SUB_DAY_WEEKDAY = { monday: 1, wednesday: 3 };
function defaultSubDateFor(day) {
  const today = todayISO();
  return weekdayOf(today) === SUB_DAY_WEEKDAY[day] ? today : '';
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

const EDIT_DIALOGS = ['dates', 'job'];

// Every Edit Dates/Add Permanent Job action lives inside a <dialog>, and a
// plain form POST fully reloads the page - so each form's action carries
// ?dialog=<name>, and every redirect back to the manage page echoes it
// through, letting the view reopen the same dialog on load instead of
// dropping the admin back at a closed popup after every save.
function manageUrl(day, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== null && value !== undefined && value !== '') query.set(key, value);
  }
  const qs = query.toString();
  return `/admin/volunteers/${day}/manage` + (qs ? `?${qs}` : '');
}
function dialogParam(req) {
  return EDIT_DIALOGS.includes(req.query.dialog) ? req.query.dialog : null;
}

// Floater Assignments is the landing page for Volunteers.
router.get('/volunteers', requireAdmin, (req, res) => res.redirect(`/admin/volunteers/${defaultDay()}/manage`));

// Old Teachers/Assistants tabs - that info now lives right on each class's
// card on the Schedules day grid (and its own manage page's Teachers &
// Assistants roster), so these are just graceful redirects for anyone with
// an old link/bookmark rather than a still-maintained separate view.
router.get('/volunteers/:day/teachers', requireAdmin, requireDay, (req, res) => res.redirect(`/admin/class-schedule/${req.params.day}`));
router.get('/volunteers/:day/assistants', requireAdmin, requireDay, (req, res) => res.redirect(`/admin/class-schedule/${req.params.day}`));

// --- Floater Assignments: position/room/name planning grid + Substitutes Needed ---

router.get('/volunteers/:day/manage', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const hours = hoursForDay(day);
  const dates = datesForList(list.id);
  const dateLabels = dates.map(formatDateLabel);

  const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultSubDateFor(day);
  const jobs = permanentJobsForDay(day).map((j) => ({ ...j, floaterIds: floaterIdsForJob(j.id) }));
  const allParents = activeParentOptions();
  const infantByMemberId = {};
  allParents.forEach((p) => { infantByMemberId[p.id] = hasInfantChild(p.id); });

  // Every hour's floater pool, embedded once for the client-side edit-in-
  // place dropdown (public/js/floater-grid.js) - keyed by hour_position.
  const floatersByHour = {};
  hours.forEach((h) => {
    floatersByHour[h.position] = floaterMembersForHour(day, h.position).map((m) => ({ id: m.id, name: m.name }));
  });

  res.render('admin-volunteers', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    hours,
    dates: dates.map((d, i) => ({ date: d, label: dateLabels[i] })),
    dateLabels,
    grid: jobAssignmentGrid(day, dates),
    floatersByHourJson: jsonScriptSafe(floatersByHour),
    openDialog: dialogParam(req),
    selectedDate,
    board: substituteBoard(day, selectedDate),
    jobs,
    allParents,
    infantByMemberId,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/volunteers/:day/dates/add', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare('INSERT OR IGNORE INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?)');
  for (const d of dates) insertDate.run(list.id, d);
  res.redirect(manageUrl(day, { notice: `Added ${dates.length} date(s).`, dialog: dialogParam(req) }));
});

router.post('/volunteers/:day/dates/:date/remove', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const date = req.params.date;
  db.prepare('DELETE FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').run(list.id, date);
  db.prepare("DELETE FROM substitute_assignments WHERE session_date = ? AND slot_type = 'job'").run(date);
  res.redirect(manageUrl(day, { notice: `Removed ${formatDateLabel(date)}.`, dialog: dialogParam(req) }));
});

router.get('/volunteers/:day/export.csv', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const dates = datesForList(list.id);
  const grid = jobAssignmentGrid(day, dates);
  const hours = hoursForDay(day);
  const hourLabel = {};
  hours.forEach((h) => { hourLabel[h.position] = h.label; });

  const header = ['Hour', 'Position', 'Room'];
  dates.forEach((d) => header.push(formatDateLabel(d)));

  const lines = [toCsvRow(header)];
  grid.forEach((hour) => {
    hour.jobs.forEach((job) => {
      const row = [hourLabel[hour.position] || `Hour ${hour.position}`, job.title, job.room || ''];
      job.cells.forEach((cell) => row.push(cell.assigned ? cell.assigned.name : ''));
      lines.push(toCsvRow(row));
    });
  });

  sendCsv(res, `${day}-floater-assignments.csv`, lines);
});

// --- Floater Teams: who's on the list for each hour, ranked ---

router.get('/volunteers/:day/teams', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const sections = sectionsForList(list.id);
  const hours = hoursForDay(day);
  const hourLabelByPosition = {};
  hours.forEach((h) => { hourLabelByPosition[h.position] = h.label; });

  const teams = sections.map((section) => ({
    section,
    hourLabel: hourLabelByPosition[section.position] || section.label,
    members: membersForSection(list.id, section.id).map((m) => ({ ...m, infant: hasInfantChild(m.id) })),
  }));

  res.render('admin-volunteer-teams', {
    title: `${DAY_LABELS[day]} Floater Teams`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    teams,
    ranks: RANKS,
    rankLabels: RANK_LABELS,
    availableParents: activeParentOptions(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/volunteers/:day/teams/add-member', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const memberId = parseInt(req.body.memberId, 10);
  const sectionId = parseInt(req.body.sectionId, 10);
  if (memberId && sectionId) addMemberToSection(list.id, memberId, sectionId);
  res.redirect(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent('Member added.'));
});

router.post('/volunteers/:day/teams/:sectionId/members/:memberId/rank', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  setSectionRank(list.id, parseInt(req.params.memberId, 10), parseInt(req.params.sectionId, 10), req.body.rank);
  res.redirect(`/admin/volunteers/${day}/teams`);
});

router.post('/volunteers/:day/teams/:sectionId/members/:memberId/remove', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  removeMemberFromSection(list.id, parseInt(req.params.memberId, 10), parseInt(req.params.sectionId, 10));
  res.redirect(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent('Removed from team.'));
});

router.get('/volunteers/:day/teams/export.csv', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const sections = sectionsForList(list.id);
  const hours = hoursForDay(day);
  const hourLabelByPosition = {};
  hours.forEach((h) => { hourLabelByPosition[h.position] = h.label; });

  const lines = [toCsvRow(['Hour', 'Name', 'Rank', 'Has Child 2 or Younger'])];
  sections.forEach((section) => {
    membersForSection(list.id, section.id).forEach((m) => {
      lines.push(toCsvRow([hourLabelByPosition[section.position] || section.label, m.name, RANK_LABELS[m.rank] || m.rank, hasInfantChild(m.id) ? 'Yes' : '']));
    });
  });

  sendCsv(res, `${day}-floater-teams.csv`, lines);
});

router.post('/volunteers/:day/import', requireAdmin, requireDay, upload.single('file'), (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const firstSection = sectionsForList(list.id)[0];
  if (!req.file) {
    return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Please choose a file to import.'));
  }
  if (!firstSection) {
    return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('No hour sections exist yet.'));
  }
  const names = parseNamesFromUpload(req.file.buffer, req.file.originalname);
  let added = 0;
  let notFound = 0;
  for (const name of names) {
    const member = findMemberByName(name, 'parent');
    if (!member) { notFound++; continue; }
    addMemberToSection(list.id, member.id, firstSection.id);
    added++;
  }
  res.redirect(
    `/admin/volunteers/${day}/teams?notice=` +
      encodeURIComponent(`Imported ${added} member(s) added to ${firstSection.label}` + (notFound ? `, ${notFound} name(s) not found in Members.` : '.'))
  );
});

module.exports = router;
