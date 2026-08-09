const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, formatDateLong, todayISO, weekdayOf } = require('../utils/dates');
const { parseNamesFromUpload, findMemberByName, hasInfantChild, activeParentOptions } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { spreadsheetFileFilter } = require('../utils/uploads');
const { defaultDay, requireDay } = require('../utils/days');
const { hoursForDay, syncDayMemberRosters, classesAtRiskForDay } = require('../utils/classSchedule');
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
  substituteBoard,
  jobAssignmentGrid,
  dailyAssignmentCardsWithLabels,
  archivedDateSummaries,
} = require('../utils/substitutes');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

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
  const today = todayISO();

  // One date now drives the whole page - each hour's floater chart and
  // its "needs a substitute" list are two columns of the same section,
  // so they always describe the same session rather than two
  // independently picked dates. Only today/future dates are offered,
  // since anything that's already passed belongs on the read-only
  // Archive tab instead. Defaults to the nearest upcoming date so the
  // page isn't blank on first load.
  const upcomingDates = dates.filter((d) => d >= today);
  const selectedDate = upcomingDates.includes(req.query.date) ? req.query.date : upcomingDates[0] || null;

  const allParents = activeParentOptions();
  const infantByMemberId = {};
  allParents.forEach((p) => { infantByMemberId[p.id] = hasInfantChild(p.id); });

  // The chart itself is now the assign UI - every permanent job (whether
  // filled or not) plus any class whose teacher(s) are absent, one row
  // each, so there's a single list instead of a separate "needs a sub"
  // section. substituteBoard already carries a suggested (or already-
  // approved) candidate per slot, auto-picked by rank and filtered to
  // whoever's actually available for this date (excludes anyone checked
  // in absent or excluded via an absence/late form for that date - see
  // absentMemberIdsForDate/absenceFormMemberIdsForDate in
  // utils/classSchedule.js, both already scoped to `date`).
  const hourSections = selectedDate ? substituteBoard(day, selectedDate) : [];
  hourSections.forEach((hour) => {
    hour.slots.forEach((slot) => {
      const usedIds = {};
      const rankedCandidates = (hour.suggestedFloaters || []).map((p) => {
        usedIds[p.id] = true;
        return { id: p.id, name: p.name, rankLabel: RANK_LABELS[p.rank] || null, infant: !!infantByMemberId[p.id] };
      });
      const otherCandidates = allParents
        .filter((p) => !usedIds[p.id])
        .map((p) => ({ id: p.id, name: p.name, rankLabel: null, infant: !!infantByMemberId[p.id] }));
      const candidates = [...rankedCandidates, ...otherCandidates];
      // The row's own current pick (approved or still-pending-suggested)
      // always has to be a selectable <option>, even if resolving other
      // rows in this hour already marked them "used" above.
      if (slot.assigned && !candidates.some((c) => c.id === slot.assigned.id)) {
        candidates.unshift({ id: slot.assigned.id, name: slot.assigned.name, rankLabel: null, infant: slot.assigned.infant });
      }
      slot.candidates = candidates;
      slot.noneAvailable = candidates.length === 0;
    });
  });

  res.render('admin-volunteers', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    hours,
    dates: dates.map((d, i) => ({ date: d, label: dateLabels[i] })),
    dateLabels,
    upcomingDates: upcomingDates.map((d) => ({ date: d, label: formatDateLong(d) })),
    selectedDate,
    hourSections,
    openDialog: dialogParam(req),
    allParents,
    infantByMemberId,
    rankLabels: RANK_LABELS,
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

// --- Floater Archive: past session dates' assignment cards, read-only ---

// A date only counts as "archived" once it's actually passed and was one
// of this day's real session dates - guards the three routes below from
// a tampered/stale date in the URL surfacing an upcoming (still-editable-
// via-Substitutes-Needed) date under the read-only Archive routes.
function loadArchivedDate(day, date) {
  if (!isValidISODate(date) || date >= todayISO()) return false;
  const list = getListByDay(day);
  return datesForList(list.id).includes(date);
}

router.get('/volunteers/:day/archive', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const list = getListByDay(day);
  const allDates = datesForList(list.id);
  const today = todayISO();
  const pastDates = allDates.filter((d) => d < today).sort().reverse();

  const dateFilter = pastDates.includes(req.query.date) ? req.query.date : null;
  const rows = archivedDateSummaries(day, dateFilter ? [dateFilter] : pastDates);

  res.render('admin-volunteer-archive', {
    title: `${DAY_LABELS[day]} Floater Archive`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    dateOptions: pastDates.map((d) => ({ date: d, label: formatDateLong(d) })),
    dateFilter,
    rows: rows.map((r) => ({ ...r, label: formatDateLong(r.date) })),
  });
});

router.get('/volunteers/:day/archive/:date/view-fragment', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  if (!loadArchivedDate(day, date)) return res.status(404).send('Not found');

  res.render('volunteer-archive-view-fragment', {
    day,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: formatDateLong(date),
    cards: dailyAssignmentCardsWithLabels(day, date),
  });
});

router.get('/volunteers/:day/archive/:date/print', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  if (!loadArchivedDate(day, date)) return res.status(404).send('Not found');

  res.render('volunteer-archive-print', {
    title: `${DAY_LABELS[day]} Floater Assignments — ${formatDateLong(date)}`,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: formatDateLong(date),
    cards: dailyAssignmentCardsWithLabels(day, date),
  });
});

router.get('/volunteers/:day/archive/:date/export.csv', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  if (!loadArchivedDate(day, date)) return res.status(404).send('Not found');

  const cards = dailyAssignmentCardsWithLabels(day, date);
  const lines = [toCsvRow(['Hour', 'Position', 'Room', 'Floater Assigned'])];
  cards.forEach((hour) => {
    hour.jobs.forEach((job) => {
      lines.push(toCsvRow([hour.label, job.title, job.room || '', job.assigned ? job.assigned.name : 'Unassigned']));
    });
  });

  sendCsv(res, `${day}-floater-assignments-${date}.csv`, lines);
});

// --- Class Cancellation Risk: same list as the Logs tab, surfaced right
// on the Floater Assignments page too (a class at risk of low turnout is
// exactly the kind of thing someone planning floaters wants to see
// without leaving this page). ---

const RISK_DAY_WEEKDAY = { monday: 1, wednesday: 3 };

router.get('/volunteers/:day/risk', requireAdmin, requireDay, (req, res) => {
  const day = req.params.day;
  const today = todayISO();
  const alertDate = weekdayOf(today) === RISK_DAY_WEEKDAY[day] ? today : null;

  res.render('admin-volunteer-risk', {
    title: `${DAY_LABELS[day]} Class Cancellation Risk`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    classesAtRisk: classesAtRiskForDay(day, alertDate),
  });
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
  if (memberId && sectionId) {
    addMemberToSection(list.id, memberId, sectionId);
    // A floater's own schedule/roster picks this hour up too - see
    // syncDayMemberRosters/syncMemberSchedulesForDay in utils/classSchedule.
    syncDayMemberRosters(day);
  }
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
  syncDayMemberRosters(day);
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
  if (added) syncDayMemberRosters(day);
  res.redirect(
    `/admin/volunteers/${day}/teams?notice=` +
      encodeURIComponent(`Imported ${added} member(s) added to ${firstSection.label}` + (notFound ? `, ${notFound} name(s) not found in Members.` : '.'))
  );
});

module.exports = router;
