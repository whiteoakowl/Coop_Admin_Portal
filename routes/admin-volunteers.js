const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, formatDateLong, todayISO, weekdayOf } = require('../utils/dates');
const { parseNamesFromUpload, findMemberByName, hasInfantChild, activeParentAndAdminOptions } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { spreadsheetFileFilter } = require('../utils/uploads');
const {
  CLASS_DAY_LABELS_FULL: DAY_LABELS,
  CLASS_DAY_WEEKDAY_FULL,
  requireClassDay,
  listActiveClassDays,
  hoursForDay,
  syncDayMemberRosters,
  syncMemberSchedulesForDay,
  saveHourLabel,
  classesAtRiskForDay,
  removeNonPrimaryParentsFromFloaterTeams,
  checkedInMemberIdsForDate,
  listScheduleCombos,
} = require('../utils/classSchedule');
const {
  RANKS,
  RANK_LABELS,
  getListByDay,
  sectionsForList,
  datesForList,
  activeDatesForList,
  archivedDatesForList,
  membersForSection,
  setSectionRank,
  removeMemberFromSection,
  addMemberToSection,
} = require('../utils/volunteers');
const {
  substituteBoard,
  assignedHourCountsForDate,
  jobAssignmentGrid,
  groupedPermanentJobsForDay,
  groupedTemporaryJobsForDayDate,
} = require('../utils/substitutes');
const { getActiveKioskSemesterId } = require('../utils/kioskSettings');
const { comboSemesterId, qsSemester, appendSemester, findComboId } = require('../utils/scheduleComboLinks');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

const EDIT_DIALOGS = ['dates', 'job', 'temp-job'];

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

// A page like Risk that never calls getListByDay itself (it has no
// volunteer_lists row of its own to read an authoritative .semester_id
// back off, the way the picker preselects on every other Floater page)
// still needs to preselect its own combo picker correctly - resolves the
// exact same way getListByDay's own default does, so the dropdown always
// shows whichever combo this page is actually using.
async function resolveSemesterId(semesterId) {
  return semesterId !== undefined ? semesterId : await getActiveKioskSemesterId();
}

// Floater Assignments is the landing page for Volunteers. Lands on
// whichever day of the week (Settings > Day Settings) is first in
// calendar order, same catalog the Classes grid's own tabs use - falls
// back to Monday on the vanishingly unlikely chance no day has ever been
// activated at all.
router.get('/volunteers', requireAdmin, async (req, res) => {
  const activeDays = await listActiveClassDays();
  res.redirect(`/admin/volunteers/${activeDays[0] || 'monday'}/manage`);
});

// Shared by the full manage page below and its own /fragment route (see
// that route's own comment for why a second, cards-only endpoint exists) -
// this is every bit of substituteBoard's raw output that isn't ready to
// hand straight to the view: each slot's own plain candidate list (and its
// "already picked elsewhere this hour"/"still needs an infant flag"/"how
// many other hour cards today" work) for every slot, on every hour, for
// one day+date.
async function buildHourSections(day, selectedDate) {
  const hourSections = selectedDate ? await substituteBoard(day, selectedDate) : [];
  // A real request: "when someone is assigned it should show (1) next to
  // their name... if they are assigned a job on 2 hour cards that day it
  // will say (2)." One lookup for the whole day rather than per-hour,
  // since it's the same total regardless of which hour's dropdown is
  // asking.
  const assignedHourCounts = selectedDate ? await assignedHourCountsForDate(selectedDate) : {};

  // A real, measured slowdown: this used to compute an infant flag for
  // EVERY active parent/admin site-wide (2 extra queries each via
  // hasInfantChild -> familyOf) on every page load, regardless of how
  // many of them are actually offered as a candidate here - ~300ms with
  // 250 parents in the org vs ~15ms once scoped down to just the members
  // who actually appear in one of this page's own availableFloaters
  // lists (usually a handful). slot.assigned already carries its own
  // infant flag from assignedInfo (utils/substitutes.js), unaffected.
  const candidateIds = new Set();
  hourSections.forEach((hour) => {
    (hour.availableFloaters || []).forEach((p) => candidateIds.add(p.id));
  });
  const infantByMemberId = {};
  for (const id of candidateIds) infantByMemberId[id] = await hasInfantChild(id);
  // A real request: "in the dropdown of members to choose for a
  // position, highlight them green if they have checked in" - same
  // "compute on read from the attendance table" shape (and same green
  // already used for this exact signal elsewhere - see utils/setup.js's
  // own assignmentCardsForDate comment) as checkedInMemberIdsForDate's
  // other caller.
  const checkedInIds = await checkedInMemberIdsForDate(selectedDate);

  hourSections.forEach((hour) => {
    hour.slots.forEach((slot) => {
      const candidates = (hour.availableFloaters || []).map((p) => ({
        id: p.id,
        name: p.name,
        rankLabel: RANK_LABELS[p.rank] || null,
        infant: !!infantByMemberId[p.id],
        assignedHourCount: assignedHourCounts[p.id] || 0,
        checkedIn: checkedInIds.has(p.id),
      }));
      if (slot.assigned && !candidates.some((c) => c.id === slot.assigned.id)) {
        candidates.unshift({
          id: slot.assigned.id,
          name: slot.assigned.name,
          rankLabel: RANK_LABELS[slot.assigned.rank] || null,
          infant: slot.assigned.infant,
          assignedHourCount: assignedHourCounts[slot.assigned.id] || 0,
          checkedIn: checkedInIds.has(slot.assigned.id),
        });
      }
      slot.candidates = candidates;
      slot.noneAvailable = candidates.length === 0;
    });
  });
  return hourSections;
}

// Old Teachers/Assistants tabs - that info now lives right on each class's
// card on the Schedules day grid (and its own manage page's Teachers &
// Assistants roster), so these are just graceful redirects for anyone with
// an old link/bookmark rather than a still-maintained separate view.
router.get('/volunteers/:day/teachers', requireAdmin, requireClassDay, (req, res) => res.redirect(`/admin/class-schedule/${req.params.day}`));
router.get('/volunteers/:day/assistants', requireAdmin, requireClassDay, (req, res) => res.redirect(`/admin/class-schedule/${req.params.day}`));

// --- Floater Assignments: position/room/name planning grid + Substitutes Needed ---

router.get('/volunteers/:day/manage', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  // getListByDay can return undefined if this day's volunteer_lists row
  // hasn't been seeded yet (db/bootstrapPg.js) - normally impossible once
  // app.ready has resolved, guarded here the same as every other lookup-
  // by-possibly-missing-row in this app.
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const hours = await hoursForDay(day);
  const dates = await datesForList(list.id);
  const dateLabels = dates.map(formatDateLabel);
  const archivedSet = new Set(await archivedDatesForList(list.id));
  const today = todayISO();

  // One date now drives the whole page - each hour's floater chart and
  // its "needs a substitute" list are two columns of the same section,
  // so they always describe the same session rather than two
  // independently picked dates. archivedSet only ever holds dates an
  // admin archived back when that feature existed (the Archive tab/
  // button have since been removed - nothing archives a date anymore,
  // but any already-archived date stays excluded here rather than
  // silently reappearing). Defaults to the nearest still-upcoming date
  // so the page isn't blank on first load; falls back to the most
  // recent active date if every active date has already passed.
  const activeDates = dates.filter((d) => !archivedSet.has(d));
  const upcomingActiveDates = activeDates.filter((d) => d >= today);
  const defaultDate = upcomingActiveDates[0] || activeDates[activeDates.length - 1] || null;
  const selectedDate = activeDates.includes(req.query.date) ? req.query.date : defaultDate;

  // The chart itself is now the assign UI - every permanent job (whether
  // filled or not) plus any class whose teacher(s) are absent, one row
  // each, so there's a single list instead of a separate "needs a sub"
  // section. substituteBoard already carries a suggested (or already-
  // approved) candidate per slot, auto-picked by rank and filtered to
  // whoever's actually available for this date (excludes anyone checked
  // in absent or excluded via an absence/late form for that date - see
  // absentMemberIdsForDate/absenceFormMemberIdsForDate in
  // utils/classSchedule.js, both already scoped to `date`). See
  // buildHourSections above for the candidate-list decoration itself
  // (shared with the /fragment route below).
  const hourSections = await buildHourSections(day, selectedDate);

  const positionGroups = await groupedPermanentJobsForDay(day);
  const temporaryPositionGroups = selectedDate ? await groupedTemporaryJobsForDayDate(day, selectedDate) : [];
  const combos = await listScheduleCombos();

  res.render('admin-volunteers', {
    title: `${DAY_LABELS[day]} Floater Assignments`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    activeDays: await listActiveClassDays(),
    dayLabels: DAY_LABELS,
    combos,
    selectedComboId: findComboId(combos, day, list.semester_id),
    semesterId: qsSemester(list.semester_id),
    hours,
    dates: dates.map((d, i) => ({ date: d, label: dateLabels[i] })),
    dateLabels,
    activeDates: activeDates.map((d) => ({ date: d, label: formatDateLong(d) })),
    selectedDate,
    hourSections,
    positionGroups,
    temporaryPositionGroups,
    openDialog: dialogParam(req),
    rankLabels: RANK_LABELS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real request: "make it to where the page doesn't refresh every time
// you click assign or unassigned - it should simply assign and allow you
// to continue clicking assignment until you're done." routes/admin-
// substitutes.js's own assign/unassign/approve routes now respond to a
// fetch-driven POST with JSON instead of a redirect (see that file), and
// public/js/floater-assign.js re-fetches just this cards grid afterward
// and swaps it in - a full re-fetch rather than a single-row patch
// because one assignment can change OTHER slots' own candidate lists
// this same hour (see buildHourSections' own "used this hour" dedup
// comment above), so the whole grid has to be recomputed either way.
router.get('/volunteers/:day/fragment', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.status(404).send('Not found');
  const activeDates = await activeDatesForList(list.id);
  const today = todayISO();
  const upcomingActiveDates = activeDates.filter((d) => d >= today);
  const defaultDate = upcomingActiveDates[0] || activeDates[activeDates.length - 1] || null;
  const selectedDate = activeDates.includes(req.query.date) ? req.query.date : defaultDate;
  const hourSections = await buildHourSections(day, selectedDate);
  res.render('floater-chart-cards-fragment', { day, dayLabel: DAY_LABELS[day], selectedDate, hourSections, semesterId: qsSemester(list.semester_id) });
});

router.post('/volunteers/:day/dates/add', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.redirect(manageUrl(day, { error: 'Floater list not found.', semesterId: qsSemester(semesterId) }));
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare(
    'INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?) ON CONFLICT (volunteer_list_id, session_date) DO NOTHING'
  );
  for (const d of dates) await insertDate.run(list.id, d);
  res.redirect(manageUrl(day, { notice: `Added ${dates.length} date(s).`, dialog: dialogParam(req), semesterId: qsSemester(semesterId) }));
});

router.post('/volunteers/:day/dates/:date/remove', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.redirect(manageUrl(day, { error: 'Floater list not found.', semesterId: qsSemester(semesterId) }));
  const date = req.params.date;
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').run(list.id, date);
    await tx.prepare("DELETE FROM substitute_assignments WHERE session_date = ? AND slot_type = 'job'").run(date);
  });
  res.redirect(manageUrl(day, { notice: `Removed ${formatDateLabel(date)}.`, dialog: dialogParam(req), semesterId: qsSemester(semesterId) }));
});

router.get('/volunteers/:day/export.csv', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day, comboSemesterId(req));
  if (!list) return res.status(404).send('Not found');
  const dates = await datesForList(list.id);
  const grid = await jobAssignmentGrid(day, dates);
  const hours = await hoursForDay(day);
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

// --- Class Cancellation Risk: same list as the Logs tab, surfaced right
// on the Floater Assignments page too (a class at risk of low turnout is
// exactly the kind of thing someone planning floaters wants to see
// without leaving this page). ---

router.get('/volunteers/:day/risk', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const today = todayISO();
  const alertDate = weekdayOf(today) === CLASS_DAY_WEEKDAY_FULL[day] ? today : null;
  const combos = await listScheduleCombos();
  const resolvedSemesterId = await resolveSemesterId(comboSemesterId(req));

  res.render('admin-volunteer-risk', {
    title: `${DAY_LABELS[day]} Class Cancellation Risk`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    activeDays: await listActiveClassDays(),
    dayLabels: DAY_LABELS,
    combos,
    semesterId: qsSemester(resolvedSemesterId),
    // Risk's own classesAtRiskForDay (utils/classSchedule.js) still loads
    // every class for the day regardless of semester - the same "load
    // everything, filter client-side" model the Classes grid itself still
    // uses today (not yet converted to a real per-semester query - a
    // separate, bigger change tracked for the Classes grid's own picker
    // pass). The combo picker here is for navigation consistency with its
    // Floater Assignments/Teams siblings; it doesn't yet change
    // which classes this one list considers at risk.
    selectedComboId: findComboId(combos, day, resolvedSemesterId),
    classesAtRisk: await classesAtRiskForDay(day, alertDate),
  });
});

// --- Floater Teams: who's on the list for each hour, ranked ---

router.get('/volunteers/:day/teams', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const sections = await sectionsForList(list.id);
  const hours = await hoursForDay(day);
  const hourLabelByPosition = {};
  hours.forEach((h) => { hourLabelByPosition[h.position] = h.label; });

  const teams = [];
  for (const section of sections) {
    const sectionMembers = [];
    for (const m of await membersForSection(list.id, section.id)) sectionMembers.push({ ...m, infant: await hasInfantChild(m.id) });
    teams.push({
      section,
      hourLabel: hourLabelByPosition[section.position] || section.label,
      members: sectionMembers,
    });
  }

  const combos = await listScheduleCombos();
  res.render('admin-volunteer-teams', {
    title: `${DAY_LABELS[day]} Floater Teams`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    activeDays: await listActiveClassDays(),
    dayLabels: DAY_LABELS,
    combos,
    selectedComboId: findComboId(combos, day, list.semester_id),
    semesterId: qsSemester(list.semester_id),
    teams,
    ranks: RANKS,
    rankLabels: RANK_LABELS,
    // Admins can be added to a Floater Team just like any other adult
    // volunteer - a real bug/request: "admins should still be included
    // in lists of members/parents etc. for selecting ANYTHING across
    // the site."
    availableParents: await activeParentAndAdminOptions(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// A real bug report: "floater team and setup cleanup teams should have a
// print preview before going to print." (see admin-setup.js's own
// matching route/comment for Setup/Cleanup Teams). This page's own Print
// button used to call window.print() directly on itself with no review
// step - lands on a dedicated read-only preview page instead, matching
// every other print button site-wide.
router.get('/volunteers/:day/teams/print', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day, comboSemesterId(req));
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const sections = await sectionsForList(list.id);
  const hours = await hoursForDay(day);
  const hourLabelByPosition = {};
  hours.forEach((h) => { hourLabelByPosition[h.position] = h.label; });

  const teams = [];
  for (const section of sections) {
    const sectionMembers = [];
    for (const m of await membersForSection(list.id, section.id)) sectionMembers.push({ ...m, infant: await hasInfantChild(m.id) });
    teams.push({
      section,
      hourLabel: hourLabelByPosition[section.position] || section.label,
      members: sectionMembers,
    });
  }

  res.render('admin-volunteer-teams-print', {
    title: `${DAY_LABELS[day]} Floater Teams`,
    day,
    dayLabel: DAY_LABELS[day],
    teams,
  });
});

// Explicit, admin-triggered cleanup for floater team membership that
// accumulated non-primary parents before/outside the "only the family's
// primary parent gets auto-floated" rule - see
// removeNonPrimaryParentsFromFloaterTeams's own comment for why nothing
// else ever removes these automatically. Re-runnable any time; a no-op
// once nothing is left to remove.
router.post('/volunteers/:day/teams/cleanup', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const removed = await removeNonPrimaryParentsFromFloaterTeams(day);
  const notice = removed
    ? `Removed ${removed} non-primary parent assignment(s).`
    : 'No non-primary parent assignments found to remove.';
  res.redirect(appendSemester(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent(notice), semesterId));
});

// A real request: "when adding floaters to teams it should have check
// boxes with each hour so you can choose multiple and save." One Add now
// places a member on every hour checked at once instead of just one.
router.post('/volunteers/:day/teams/add-member', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'), semesterId));
  const memberId = parseInt(req.body.memberId, 10);
  const sectionIds = [...new Set([].concat(req.body.sectionIds || []).map((id) => parseInt(id, 10)).filter(Boolean))];
  if (memberId && sectionIds.length > 0) {
    for (const sectionId of sectionIds) await addMemberToSection(list.id, memberId, sectionId);
    // A floater's own schedule/roster picks this hour up too - see
    // syncDayMemberRosters/syncMemberSchedulesForDay in utils/classSchedule.
    await syncDayMemberRosters(day);
  }
  res.redirect(appendSemester(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent(`Member added to ${sectionIds.length} hour(s).`), semesterId));
});

// Renames the shared hour label a floater team's card displays (the same
// class_schedule_hours row the Class Schedule page's own "Edit" dialog
// edits) - one card's Save, so this only ever touches that one hour's
// position (saveHourLabel, not the bulk saveHourLabels every position at
// once), and re-syncs schedule cards the same way that dialog does.
router.post('/volunteers/:day/teams/:sectionId/hour-label', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'), semesterId));
  const sectionId = parseInt(req.params.sectionId, 10);
  const section = (await sectionsForList(list.id)).find((s) => s.id === sectionId);
  if (!section) {
    return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Team not found.'), semesterId));
  }
  await saveHourLabel(day, section.position, req.body.label);

  // Batched member removals staged by the card's own trash icons - a real
  // request: "when deleting floaters ... it should allow for multiple
  // deletes and then click save before refreshing." Each removal used to
  // be its own immediate POST/reload; removeMemberIds now piggybacks on
  // this same Save submission (see admin-volunteer-teams.ejs's hidden,
  // form-attribute-linked checkboxes) so the label and any number of
  // pending removals all land in one request/one page load. Reuses the
  // exact same removeMemberFromSection + syncDayMemberRosters pairing the
  // standalone .../members/:memberId/remove route below already proved
  // out (a real bug report: without the sync, an auto-floated member's
  // removal didn't stick past the next unrelated sync).
  const removeIds = [].concat(req.body.removeMemberIds || []).map((v) => parseInt(v, 10)).filter(Boolean);
  for (const memberId of removeIds) await removeMemberFromSection(list.id, memberId, sectionId);
  if (removeIds.length) await syncDayMemberRosters(day);

  // Batched rank changes staged by each member's own rank <select> - a
  // real request: "when I edit the floater list and change the choose
  // first/sometimes/backup dropdown it should stay on that screen and
  // not refresh until I click the check mark... I should be able to
  // change several dropdowns... before I click save." Same piggyback-on-
  // this-Save-submission pattern as removeMemberIds above, one
  // rank_<memberId> field per member (admin-volunteer-teams.ejs's own
  // select[name]) instead of each dropdown's own immediate onchange
  // submit/reload. setSectionRank silently no-ops on an invalid rank
  // value, so a stray/tampered field can't corrupt anything.
  for (const [key, value] of Object.entries(req.body)) {
    if (!key.startsWith('rank_')) continue;
    const memberId = parseInt(key.slice('rank_'.length), 10);
    if (!memberId) continue;
    await setSectionRank(list.id, memberId, sectionId, value);
  }

  await syncMemberSchedulesForDay(day);
  res.redirect(appendSemester(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent(removeIds.length ? `Hour updated. Removed ${removeIds.length} member(s).` : 'Hour renamed.'), semesterId));
});

router.post('/volunteers/:day/teams/:sectionId/members/:memberId/rank', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'), semesterId));
  await setSectionRank(list.id, parseInt(req.params.memberId, 10), parseInt(req.params.sectionId, 10), req.body.rank);
  res.redirect(appendSemester(`/admin/volunteers/${day}/teams`, semesterId));
});

router.post('/volunteers/:day/teams/:sectionId/members/:memberId/remove', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'), semesterId));
  await removeMemberFromSection(list.id, parseInt(req.params.memberId, 10), parseInt(req.params.sectionId, 10));
  await syncDayMemberRosters(day);
  res.redirect(appendSemester(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent('Removed from team.'), semesterId));
});

router.get('/volunteers/:day/teams/export.csv', requireAdmin, requireClassDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day, comboSemesterId(req));
  if (!list) return res.status(404).send('Not found');
  const sections = await sectionsForList(list.id);
  const hours = await hoursForDay(day);
  const hourLabelByPosition = {};
  hours.forEach((h) => { hourLabelByPosition[h.position] = h.label; });

  const lines = [toCsvRow(['Hour', 'Name', 'Rank', 'Has Child 2 or Younger'])];
  for (const section of sections) {
    for (const m of await membersForSection(list.id, section.id)) {
      lines.push(
        toCsvRow([hourLabelByPosition[section.position] || section.label, m.name, RANK_LABELS[m.rank] || m.rank, (await hasInfantChild(m.id)) ? 'Yes' : ''])
      );
    }
  }

  sendCsv(res, `${day}-floater-teams.csv`, lines);
});

router.post('/volunteers/:day/import', requireAdmin, requireClassDay, upload.single('file'), async (req, res) => {
  const day = req.params.day;
  const semesterId = comboSemesterId(req);
  const list = await getListByDay(day, semesterId);
  if (!list) return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'), semesterId));
  const firstSection = (await sectionsForList(list.id))[0];
  if (!req.file) {
    return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Please choose a file to import.'), semesterId));
  }
  if (!firstSection) {
    return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('No hour sections exist yet.'), semesterId));
  }
  let names;
  try {
    names = await parseNamesFromUpload(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.redirect(appendSemester(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'), semesterId));
  }
  let added = 0;
  let notFound = 0;
  for (const name of names) {
    const member = await findMemberByName(name, ['parent', 'admin']);
    if (!member) { notFound++; continue; }
    await addMemberToSection(list.id, member.id, firstSection.id);
    added++;
  }
  if (added) await syncDayMemberRosters(day);
  res.redirect(
    appendSemester(
      `/admin/volunteers/${day}/teams?notice=` +
        encodeURIComponent(`Imported ${added} member(s) added to ${firstSection.label}` + (notFound ? `, ${notFound} name(s) not found in Members.` : '.')),
      semesterId
    )
  );
});

module.exports = router;
