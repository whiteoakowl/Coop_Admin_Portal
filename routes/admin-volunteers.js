const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const { isValidISODate, formatDateLabel, formatDateLong, todayISO, weekdayOf } = require('../utils/dates');
const { parseNamesFromUpload, findMemberByName, hasInfantChild, activeParentAndAdminOptions } = require('../utils/members');
const { toCsvRow, sendCsv } = require('../utils/spreadsheet');
const { spreadsheetFileFilter } = require('../utils/uploads');
const { defaultDay, requireDay } = require('../utils/days');
const {
  hoursForDay,
  syncDayMemberRosters,
  syncMemberSchedulesForDay,
  saveHourLabel,
  classesAtRiskForDay,
  removeNonPrimaryParentsFromFloaterTeams,
} = require('../utils/classSchedule');
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
  groupedPermanentJobsForDay,
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

// Shared by the full manage page below and its own /fragment route (see
// that route's own comment for why a second, cards-only endpoint exists) -
// this is every bit of substituteBoard's raw output that isn't ready to
// hand straight to the view: the suggested-floater candidate list (and its
// "already picked elsewhere this hour"/"still needs an infant flag" work)
// for every slot, on every hour, for one day+date.
async function buildHourSections(day, selectedDate) {
  const infantByMemberId = {};
  for (const p of await activeParentAndAdminOptions()) infantByMemberId[p.id] = await hasInfantChild(p.id);

  const hourSections = selectedDate ? await substituteBoard(day, selectedDate) : [];
  hourSections.forEach((hour) => {
    hour.slots.forEach((slot) => {
      const candidates = (hour.suggestedFloaters || []).map((p) => ({
        id: p.id,
        name: p.name,
        rankLabel: RANK_LABELS[p.rank] || null,
        infant: !!infantByMemberId[p.id],
      }));
      if (slot.assigned && !candidates.some((c) => c.id === slot.assigned.id)) {
        candidates.unshift({ id: slot.assigned.id, name: slot.assigned.name, rankLabel: RANK_LABELS[slot.assigned.rank] || null, infant: slot.assigned.infant });
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
router.get('/volunteers/:day/teachers', requireAdmin, requireDay, (req, res) => res.redirect(`/admin/class-schedule/${req.params.day}`));
router.get('/volunteers/:day/assistants', requireAdmin, requireDay, (req, res) => res.redirect(`/admin/class-schedule/${req.params.day}`));

// --- Floater Assignments: position/room/name planning grid + Substitutes Needed ---

router.get('/volunteers/:day/manage', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  // getListByDay can return undefined if this day's volunteer_lists row
  // hasn't been seeded yet (db/bootstrapPg.js) - normally impossible once
  // app.ready has resolved, guarded here the same as every other lookup-
  // by-possibly-missing-row in this app.
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const hours = await hoursForDay(day);
  const dates = await datesForList(list.id);
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
    positionGroups,
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
router.get('/volunteers/:day/fragment', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.status(404).send('Not found');
  const dates = await datesForList(list.id);
  const today = todayISO();
  const upcomingDates = dates.filter((d) => d >= today);
  const selectedDate = upcomingDates.includes(req.query.date) ? req.query.date : upcomingDates[0] || null;
  const hourSections = await buildHourSections(day, selectedDate);
  res.render('floater-chart-cards-fragment', { day, selectedDate, hourSections });
});

router.post('/volunteers/:day/dates/add', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.redirect(manageUrl(day, { error: 'Floater list not found.' }));
  const dates = [...new Set([].concat(req.body.dates || []).map((d) => d.trim()).filter(isValidISODate))];
  const insertDate = db.prepare(
    'INSERT INTO volunteer_dates (volunteer_list_id, session_date) VALUES (?, ?) ON CONFLICT (volunteer_list_id, session_date) DO NOTHING'
  );
  for (const d of dates) await insertDate.run(list.id, d);
  res.redirect(manageUrl(day, { notice: `Added ${dates.length} date(s).`, dialog: dialogParam(req) }));
});

router.post('/volunteers/:day/dates/:date/remove', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.redirect(manageUrl(day, { error: 'Floater list not found.' }));
  const date = req.params.date;
  await db.withTransaction(async (tx) => {
    await tx.prepare('DELETE FROM volunteer_dates WHERE volunteer_list_id = ? AND session_date = ?').run(list.id, date);
    await tx.prepare("DELETE FROM substitute_assignments WHERE session_date = ? AND slot_type = 'job'").run(date);
  });
  res.redirect(manageUrl(day, { notice: `Removed ${formatDateLabel(date)}.`, dialog: dialogParam(req) }));
});

router.get('/volunteers/:day/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
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

// --- Floater Archive: past session dates' assignment cards, read-only ---

// A date only counts as "archived" once it's actually passed and was one
// of this day's real session dates - guards the three routes below from
// a tampered/stale date in the URL surfacing an upcoming (still-editable-
// via-Substitutes-Needed) date under the read-only Archive routes.
async function loadArchivedDate(day, date) {
  if (!isValidISODate(date) || date >= todayISO()) return false;
  const list = await getListByDay(day);
  if (!list) return false;
  return (await datesForList(list.id)).includes(date);
}

router.get('/volunteers/:day/archive', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.status(404).render('404', { title: 'Not Found' });
  const allDates = await datesForList(list.id);
  const today = todayISO();
  const pastDates = allDates.filter((d) => d < today).sort().reverse();

  const dateFilter = pastDates.includes(req.query.date) ? req.query.date : null;
  const rows = await archivedDateSummaries(day, dateFilter ? [dateFilter] : pastDates);

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

router.get('/volunteers/:day/archive/:date/view-fragment', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  if (!(await loadArchivedDate(day, date))) return res.status(404).send('Not found');

  res.render('volunteer-archive-view-fragment', {
    day,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: formatDateLong(date),
    cards: await dailyAssignmentCardsWithLabels(day, date),
  });
});

router.get('/volunteers/:day/archive/:date/print', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  if (!(await loadArchivedDate(day, date))) return res.status(404).send('Not found');

  res.render('volunteer-archive-print', {
    title: `${DAY_LABELS[day]} Floater Assignments — ${formatDateLong(date)}`,
    dayLabel: DAY_LABELS[day],
    date,
    dateLabel: formatDateLong(date),
    cards: await dailyAssignmentCardsWithLabels(day, date),
  });
});

router.get('/volunteers/:day/archive/:date/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const date = req.params.date;
  if (!(await loadArchivedDate(day, date))) return res.status(404).send('Not found');

  const cards = await dailyAssignmentCardsWithLabels(day, date);
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

router.get('/volunteers/:day/risk', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const today = todayISO();
  const alertDate = weekdayOf(today) === RISK_DAY_WEEKDAY[day] ? today : null;

  res.render('admin-volunteer-risk', {
    title: `${DAY_LABELS[day]} Class Cancellation Risk`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
    classesAtRisk: await classesAtRiskForDay(day, alertDate),
  });
});

// --- Floater Teams: who's on the list for each hour, ranked ---

router.get('/volunteers/:day/teams', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
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

  res.render('admin-volunteer-teams', {
    title: `${DAY_LABELS[day]} Floater Teams`,
    tab: 'floater',
    day,
    dayLabel: DAY_LABELS[day],
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
router.get('/volunteers/:day/teams/print', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
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
router.post('/volunteers/:day/teams/cleanup', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const removed = await removeNonPrimaryParentsFromFloaterTeams(day);
  const notice = removed
    ? `Removed ${removed} non-primary parent assignment(s).`
    : 'No non-primary parent assignments found to remove.';
  res.redirect(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent(notice));
});

router.post('/volunteers/:day/teams/add-member', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'));
  const memberId = parseInt(req.body.memberId, 10);
  const sectionId = parseInt(req.body.sectionId, 10);
  if (memberId && sectionId) {
    await addMemberToSection(list.id, memberId, sectionId);
    // A floater's own schedule/roster picks this hour up too - see
    // syncDayMemberRosters/syncMemberSchedulesForDay in utils/classSchedule.
    await syncDayMemberRosters(day);
  }
  res.redirect(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent('Member added.'));
});

// Renames the shared hour label a floater team's card displays (the same
// class_schedule_hours row the Class Schedule page's own "Edit" dialog
// edits) - one card's Save, so this only ever touches that one hour's
// position (saveHourLabel, not the bulk saveHourLabels every position at
// once), and re-syncs schedule cards the same way that dialog does.
router.post('/volunteers/:day/teams/:sectionId/hour-label', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'));
  const sectionId = parseInt(req.params.sectionId, 10);
  const section = (await sectionsForList(list.id)).find((s) => s.id === sectionId);
  if (!section) {
    return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Team not found.'));
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

  await syncMemberSchedulesForDay(day);
  res.redirect(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent(removeIds.length ? `Hour updated. Removed ${removeIds.length} member(s).` : 'Hour renamed.'));
});

router.post('/volunteers/:day/teams/:sectionId/members/:memberId/rank', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'));
  await setSectionRank(list.id, parseInt(req.params.memberId, 10), parseInt(req.params.sectionId, 10), req.body.rank);
  res.redirect(`/admin/volunteers/${day}/teams`);
});

router.post('/volunteers/:day/teams/:sectionId/members/:memberId/remove', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'));
  await removeMemberFromSection(list.id, parseInt(req.params.memberId, 10), parseInt(req.params.sectionId, 10));
  await syncDayMemberRosters(day);
  res.redirect(`/admin/volunteers/${day}/teams?notice=` + encodeURIComponent('Removed from team.'));
});

router.get('/volunteers/:day/teams/export.csv', requireAdmin, requireDay, async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
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

router.post('/volunteers/:day/import', requireAdmin, requireDay, upload.single('file'), async (req, res) => {
  const day = req.params.day;
  const list = await getListByDay(day);
  if (!list) return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Floater list not found.'));
  const firstSection = (await sectionsForList(list.id))[0];
  if (!req.file) {
    return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Please choose a file to import.'));
  }
  if (!firstSection) {
    return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('No hour sections exist yet.'));
  }
  let names;
  try {
    names = await parseNamesFromUpload(req.file.buffer, req.file.originalname);
  } catch (err) {
    return res.redirect(`/admin/volunteers/${day}/teams?error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
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
    `/admin/volunteers/${day}/teams?notice=` +
      encodeURIComponent(`Imported ${added} member(s) added to ${firstSection.label}` + (notFound ? `, ${notFound} name(s) not found in Members.` : '.'))
  );
});

module.exports = router;
