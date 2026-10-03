const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { isValidISODate, easternInputToUtcText, formatTimestamp, ageFromBirthday, todayISO, weekdayOf } = require('../utils/dates');
const { listWindows, createWindow, deleteWindow } = require('../utils/registrationWindows');
const { toCsvRow, sendCsv, buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const {
  getMemberSchedule,
  schedulesForMembers,
  scheduleList,
  archiveMemberSchedules,
  listMemberScheduleArchives,
  deleteMemberScheduleArchive,
  deleteAllMemberScheduleArchives,
} = require('../utils/schedule');
const { byLastName, allFamilies } = require('../utils/members');
const {
  CLASS_DAYS,
  CLASS_DAY_LABELS_FULL: CLASS_DAY_LABELS,
  CLASS_DAY_WEEKDAY_FULL,
  parseClassDayValue,
  listClassSchedules,
  listActiveClassDays,
  createClassSchedule,
  updateClassSchedule,
  deleteClassSchedule,
  hoursForDay,
  roomGridForDay,
  roomsForDay,
  GRADE_LEVELS,
  AGE_OPTIONS,
  COLOR_PALETTE,
  activeMembersForStaff,
  absentMemberIdsForDate,
  setEnrollment,
  addStaff,
  syncDayMemberRosters,
  listClassArchives,
  listSemesters,
  createSemester,
  renameSemester,
  deleteSemester,
  classGlobalSettings,
  saveClassGlobalSettings,
  listScheduleCombos,
} = require('../utils/classSchedule');
const { comboSemesterId, qsSemester, findComboId } = require('../utils/scheduleComboLinks');
const { CLASS_DAY_ORDER } = require('../utils/classDays');
const { countMissingSemesterData, totalMissing, assignMissingSemesterData } = require('../utils/semesterAssignment');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { SCHEDULE_CARD_SAFE_INSET } = require('../utils/duplexPrint');
const { scheduleCardDataForMembers, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { imageFileFilter, spreadsheetFileFilter } = require('../utils/uploads');
const { sweepScheduleCardImages } = require('../utils/designImageGC');
const { createStorageClient, publicUrl } = require('../utils/storage');
const { saveUpload } = require('../utils/uploadBackend');
const { getActiveKioskSemesterId, setActiveKioskSemesterId } = require('../utils/kioskSettings');

const uploadScheduleImport = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

const DESIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'schedule-cards');
const SCHEDULE_CARD_IMAGES_BUCKET = 'schedule-card-images';
const storageClient = createStorageClient();
// Only needed as a local-disk fallback - a serverless deployment's
// filesystem is read-only outside /tmp, so this must not run when
// Storage is actually configured.
if (!storageClient && !fs.existsSync(DESIGN_IMAGE_DIR)) {
  try {
    fs.mkdirSync(DESIGN_IMAGE_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${DESIGN_IMAGE_DIR}:`, err.message);
  }
}

const uploadDesignImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

const SPECIAL_SCHEDULE_TABS = ['members', 'archive', 'settings'];
const SETTINGS_SUBTABS = ['general', 'semester', 'registration', 'kiosk', 'days'];
const ARCHIVE_TYPES = ['class', 'student', 'parent'];
const MEMBER_TYPE_FILTERS = ['student', 'parent'];
const PAGE_SIZE = 25;

// A real request: "I need to be able to switch between semester views
// on... classes." The Classes grid itself still loads every class for
// the day regardless of semester and filters client-side (the Filter
// popup's own Semester dropdown, public/js/class-schedule-filters.js) -
// not yet converted to a real per-semester query, unlike Floater
// Assignments/Setup-Cleanup's own full per-combo data swap. The new
// Semester/Day combo picker above the grid still gives the same "Fall
// 2026 - Monday" navigation everywhere else has, by pre-selecting that
// same Filter dropdown to match (see class-schedule-grid.ejs's own
// comment) rather than re-querying. resolveSemesterId mirrors routes/
// admin-setup.js's own helper, for pages here (Settings' own Day
// Settings/General tabs, Risk-equivalent spots) that need the combo
// picker's effective semester without a single authoritative row of
// their own to read it back off.
async function resolveSemesterId(semesterId) {
  return semesterId !== undefined ? semesterId : await getActiveKioskSemesterId();
}

// utils/days.js's own defaultDateFor is still Monday/Wednesday-only (see
// that file's header comment) - this is its exact same "only meaningful
// when today itself falls on the given day" logic, just keyed off the
// full 7-day CLASS_DAY_WEEKDAY_FULL instead, so viewing a newly-activated
// day's (e.g. Tuesday) own grid on an actual Tuesday still defaults the
// date picker to today instead of silently landing on no date at all.
function defaultDateForClassDay(day) {
  const today = todayISO();
  return weekdayOf(today) === CLASS_DAY_WEEKDAY_FULL[day] ? today : '';
}

router.get('/schedule', requireAdmin, async (req, res) => {
  // A real request: "merge Parent + Student Schedules tabs into 'Member
  // Schedules' with filter popup" - the two separate top-level tabs are
  // now one Member Schedules tab with a Filter popup (Member Type: All/
  // Students/Parents, see the ?type= handling below) instead. Old
  // ?tab=students / ?tab=parents links (bookmarks, the Member profile's
  // own "back to Schedules" link - see returnType below) still work,
  // redirected to the merged tab with the matching type filter carried
  // over so nothing that used to point at just parents (or just
  // students) suddenly shows everyone.
  if (req.query.tab === 'students' || req.query.tab === 'parents') {
    const qs = new URLSearchParams(req.query);
    qs.set('tab', 'members');
    qs.set('type', req.query.tab === 'students' ? 'student' : 'parent');
    return res.redirect('/admin/schedule?' + qs.toString());
  }

  // A real request: "Full 7 day expansion so multiple semesters can be
  // created and managed... now day settings." The day-tab list is no
  // longer the hardcoded Monday/Wednesday pair - it's every day of the
  // week that's ever been activated via a class_schedules row (Settings >
  // Day Settings, below), in calendar order. ?tab=monday/?tab=wednesday
  // keep working exactly as before since those two are always seeded.
  const activeDays = await listActiveClassDays();
  const defaultTab = activeDays[0] || 'monday';
  let tab = SPECIAL_SCHEDULE_TABS.includes(req.query.tab) || activeDays.includes(req.query.tab) ? req.query.tab : defaultTab;

  // Member Schedules, the Class Archive, and Settings are all
  // full-Admin-only. A Co-op Admin only gets the read-only day grid.
  if ((tab === 'members' || tab === 'archive' || tab === 'settings') && !res.locals.isFullAdmin) {
    tab = defaultTab;
  }

  if (CLASS_DAYS.includes(tab)) {
    const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultDateForClassDay(tab);
    const missingSemesterBreakdown = res.locals.isFullAdmin ? await countMissingSemesterData() : null;
    const combos = await listScheduleCombos();
    const resolvedSemesterId = await resolveSemesterId(comboSemesterId(req));
    return res.render('admin-schedule', {
      title: 'Schedules',
      tab,
      topTab: 'schedules',
      day: tab,
      dayLabel: CLASS_DAY_LABELS[tab],
      activeDays,
      classDayLabels: CLASS_DAY_LABELS,
      combos,
      selectedComboId: findComboId(combos, tab, resolvedSemesterId),
      selectedSemesterId: qsSemester(resolvedSemesterId),
      hours: await hoursForDay(tab),
      roomGrid: await roomGridForDay(tab),
      rooms: await roomsForDay(tab),
      gradeLevels: GRADE_LEVELS,
      ageOptions: AGE_OPTIONS,
      colorPalette: COLOR_PALETTE,
      availableStaff: await activeMembersForStaff(),
      sections: await db.prepare('SELECT * FROM sections ORDER BY name').all(),
      selectedDate,
      absentIds: await absentMemberIdsForDate(selectedDate),
      // Needed for the Bulk Edit dialog's own semester dropdown and the
      // "Add/Edit Semester" dialog (both new - a real request), neither
      // of which previously existed on this tab (only the Settings tab
      // had the semester list before).
      semesters: await listSemesters(),
      missingSemesterBreakdown,
      missingSemesterCount: missingSemesterBreakdown ? totalMissing(missingSemesterBreakdown) : 0,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Archive: a pill toggle (Class/Student/Parent) switches between classes
  // archived from either day's grid (see archiveClasses in
  // utils/classSchedule.js) and members archived from the Member
  // Schedules tab (see archiveMemberSchedules in utils/schedule.js) - two
  // different tables, same "flatten to plain text, drop the FK-linked
  // detail" archive philosophy either way.
  if (tab === 'archive') {
    const archiveType = ARCHIVE_TYPES.includes(req.query.type) ? req.query.type : 'class';
    const archives = archiveType === 'class' ? await listClassArchives() : await listMemberScheduleArchives(archiveType);
    // A member-schedule archive's own daySchedules only ever holds
    // whichever days were active when IT was archived (see
    // listMemberScheduleArchives' own comment on the two row shapes this
    // merges) - the table needs one column per day that shows up across
    // ANY of them, in calendar order, not just whatever's active today.
    const archiveDays =
      archiveType === 'class'
        ? []
        : [...new Set(archives.flatMap((a) => Object.keys(a.daySchedules)))].sort((a, b) => CLASS_DAY_ORDER[a] - CLASS_DAY_ORDER[b]);
    return res.render('admin-schedule', {
      title: 'Schedules',
      tab,
      topTab: 'archive',
      archiveType,
      archives,
      archiveDays,
      dayLabels: CLASS_DAY_LABELS,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Schedules > Settings tab - a real request rebuilt this entirely into
  // "Co-op Class Settings": genuinely co-op-wide settings only (age/grade
  // restriction defaults, Enable Parent/Volunteer Registration,
  // cancellation policy, credit adjustments), Semesters (a co-op-wide
  // list of titles), and Registration Schedule (already co-op-wide).
  // Registration Open, Parents Can Complete Lessons, Parents Can Use
  // Class Chat, and Semester assignment are all per-class now and live on
  // each class's own Details tab instead (views/admin-class-schedule-
  // manage.ejs) - no more per-class table on this page at all.
  //
  // A real request: "There needs to be tabs for this page general,
  // semester, registration schedule. Move all those features to there
  // designated pages only" - the three sections used to all render
  // stacked on one long page; now each one only renders under its own
  // sub-tab (same ?settingsTab= pattern as this page's own Archive
  // Class/Student/Parent sub-tabs).
  if (tab === 'settings') {
    const settingsTab = SETTINGS_SUBTABS.includes(req.query.settingsTab) ? req.query.settingsTab : 'general';
    const windowRows = await listWindows();
    const missingSemesterBreakdown = await countMissingSemesterData();
    return res.render('admin-schedule', {
      title: 'Co-op Class Settings',
      tab,
      topTab: 'settings',
      settingsTab,
      dayLabels: CLASS_DAY_LABELS,
      windows: windowRows.map((w) => ({ ...w, opensLabel: formatTimestamp(w.opens_at), closesLabel: formatTimestamp(w.closes_at) })),
      roles: await db.prepare('SELECT key, label FROM roles ORDER BY label').all(),
      sections: await db.prepare('SELECT * FROM sections ORDER BY name').all(),
      semesters: await listSemesters(),
      missingSemesterBreakdown,
      missingSemesterCount: totalMissing(missingSemesterBreakdown),
      classSettings: await classGlobalSettings(),
      // Settings > Kiosk - a real request: "the kiosk page and all of its
      // features are linked to [this semester]... this way the kiosk can
      // be changed each semester seamlessly." See utils/kioskSettings.js.
      activeKioskSemesterId: await getActiveKioskSemesterId(),
      // Settings > Day Settings - a real request: "Full 7 day expansion
      // so multiple semesters can be created and managed... now day
      // settings." classDays is every weekday CLASS_DAY_LABELS can offer
      // in the Add/Edit Day Schedule dialog; classSchedules is the
      // existing list (title/day/semester/dates) shown and edited here.
      classDays: CLASS_DAYS,
      classDayLabels: CLASS_DAY_LABELS,
      classSchedules: await listClassSchedules(),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Member Schedules: every active member matching the Filter popup's
  // Member Type choice (All/Students/Parents - see the dialog in
  // admin-schedule.ejs), shown as their actual Schedule Card (same
  // design/rendering as the printable card - see partials/name-tag-
  // badge.ejs), laid out side by side in alphabetical-by-last-name order.
  // The old free-text search is a dropdown of every name matching the
  // current type filter, jumping straight to one person's card via the
  // memberId filter scheduleList already supports. A Parent-filtered (or
  // unfiltered) view includes admin/leader members too - a real bug
  // report: "when viewing parent schedules under parent tab it won't
  // show admins. wherever there is a parent filter it should include
  // admins too." Admins regularly teach/assist/floater/staff a team just
  // like any other adult, so their own schedule belongs here.
  const typeFilter = MEMBER_TYPE_FILTERS.includes(req.query.type) ? req.query.type : '';
  const memberType = typeFilter === 'student' ? 'student' : typeFilter === 'parent' ? ['parent', 'admin'] : ['student', 'parent', 'admin'];
  const selectedMemberId = req.query.memberId ? parseInt(req.query.memberId, 10) : null;
  // "add to the filter, filter by family name. then you can see the whole
  // families schedules at once" - a real request. scheduleList already
  // supported filters.familyId (the Print route has used it for a while,
  // see /admin/schedule/print?familyId= below) - this just exposes the
  // same filter on the main Member Schedules list.
  const selectedFamilyId = req.query.familyId ? parseInt(req.query.familyId, 10) : null;
  const filters = { memberType, memberId: selectedMemberId || undefined, familyId: selectedFamilyId || undefined };

  const rows = await scheduleList(filters);

  const scheduleCardTemplate = await getScheduleCardTemplate();
  const scheduleCardBgCss = NameTagRenderCore.backgroundCss(scheduleCardTemplate.background, scheduleCardTemplate.backgroundOpacity);

  // r already carries this member's own already-computed monday/wednesday
  // rows (scheduleList batches the whole day once - see its own comment) -
  // passing them through as scheduleByMember skips scheduleCardDataForMembers'
  // own getMemberSchedule call, which would otherwise redo that same live
  // computation a second time per member on this page. This also batches
  // the primaryParentFor phone-number lookup that a per-member
  // scheduleCardDataForMember call would otherwise redo once per row (the
  // same N+1 shape a real ~800-card bulk print timed out on - see
  // scheduleCardDataForMembers' own comment) - this page can list every
  // active member of a type at once.
  const scheduleByMember = {};
  for (const r of rows) scheduleByMember[r.member.id] = { monday: r.byDay.monday, wednesday: r.byDay.wednesday };
  const cardDataByMember = await scheduleCardDataForMembers(
    rows.map((r) => r.member),
    scheduleByMember
  );
  const summarized = rows.map((r) => ({
    member: r.member,
    scheduleCardHtml: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, cardDataByMember[r.member.id]),
  }));
  summarized.sort((a, b) => byLastName(a.member, b.member));

  const memberTypes = Array.isArray(memberType) ? memberType : [memberType];
  const allNames = (
    await db
      .prepare(`SELECT id, name FROM members WHERE active = 1 AND member_type IN (${memberTypes.map(() => '?').join(', ')})`)
      .all(...memberTypes)
  ).sort(byLastName);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(summarized.length / PAGE_SIZE));
  const pageRows = summarized.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  res.render('admin-schedule', {
    title: 'Schedules',
    tab,
    topTab: tab,
    typeFilter,
    rows: pageRows,
    totalCount: summarized.length,
    page,
    totalPages,
    scheduleCardBgCss,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    allNames,
    selectedMemberId,
    families: await allFamilies(),
    selectedFamilyId,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Classes > Settings: Registration Schedule (staged, day/section/
// role-targeted class registration windows - see
// utils/registrationWindows.js's own header comment). A real request:
// "main admin, classes, settings. Add registration schedule. Be able to
// control who can signup on each schedule grid monday/Wednesday. Date,
// time and section and open for teacher or assistant registration" - a
// follow-up confirmed this should live under Co-op Admin's own Classes >
// Settings tab (class settings always live here), not a separate Main
// Admin page, and should gate everyone who registers for a class
// (parents/students/teachers), not just teacher/assistant.
router.post('/schedule/registration-windows', requireFullAdmin, async (req, res) => {
  const label = (req.body.label || '').trim();
  const opensAt = easternInputToUtcText(req.body.opensAt);
  const closesAt = easternInputToUtcText(req.body.closesAt);
  const back = '/admin/schedule?tab=settings&settingsTab=registration';
  if (!label || !opensAt) {
    return res.redirect(back + '&error=' + encodeURIComponent('A label and an opens-at date/time are required.'));
  }
  await createWindow({
    label,
    roleKey: req.body.roleKey || null,
    opensAt,
    closesAt,
    day: req.body.day || null,
    sectionId: req.body.sectionId ? Number(req.body.sectionId) : null,
  });
  res.redirect(back + '&notice=' + encodeURIComponent('Registration window added.'));
});

router.post('/schedule/registration-windows/:id/delete', requireFullAdmin, async (req, res) => {
  await deleteWindow(req.params.id);
  res.redirect('/admin/schedule?tab=settings&settingsTab=registration&notice=' + encodeURIComponent('Registration window removed.'));
});

// --- Classes > Settings: Semesters - a real request: "Overall class
// settings. Add a place to create and add new semester titles." Just a
// title list; each class's own semester assignment is its own dropdown
// on that class's own Details tab (views/admin-class-schedule-manage.ejs).
// A later request put an "Add/Edit Semester" button directly on the
// Monday/Wednesday Classes page too (views/partials/class-schedule-grid.
// ejs's own dialog) - every route here honors an optional ?back= so that
// dialog's own forms land the admin back on the day grid they opened it
// from instead of always bouncing to the Settings tab.
function semesterSettingsBack(req) {
  const back = req.body.back || req.query.back;
  return back && back.startsWith('/admin/schedule') ? back : '/admin/schedule?tab=settings&settingsTab=semester';
}

router.post('/schedule/semesters', requireFullAdmin, async (req, res) => {
  const back = semesterSettingsBack(req);
  const sep = back.includes('?') ? '&' : '?';
  try {
    await createSemester(req.body.title);
  } catch (err) {
    return res.redirect(back + sep + 'error=' + encodeURIComponent(err.message));
  }
  res.redirect(back + sep + 'notice=' + encodeURIComponent('Semester added.'));
});

// A real request: "add button for orientation settings to link training"
// and "on class page add a button that says add/edit semester" both
// assumed an existing semester could be renamed, not just added/deleted -
// the "Edit" half of "Add/Edit Semester" this button is named for.
router.post('/schedule/semesters/:id/rename', requireFullAdmin, async (req, res) => {
  const back = semesterSettingsBack(req);
  const sep = back.includes('?') ? '&' : '?';
  try {
    await renameSemester(req.params.id, req.body.title);
  } catch (err) {
    return res.redirect(back + sep + 'error=' + encodeURIComponent(err.message));
  }
  res.redirect(back + sep + 'notice=' + encodeURIComponent('Semester renamed.'));
});

router.post('/schedule/semesters/:id/delete', requireFullAdmin, async (req, res) => {
  const back = semesterSettingsBack(req);
  const sep = back.includes('?') ? '&' : '?';
  await deleteSemester(req.params.id);
  res.redirect(back + sep + 'notice=' + encodeURIComponent('Semester removed.'));
});

// A real request: "create a fall 2026 semester and connect all classes,
// floater assignments, setup cleanup, attendance, logs, everything on
// co-op admin portal. I don't want to loose any current data." One-click
// fix: tag every still-unassigned Classes/Floater Assignments/Setup-
// Cleanup/Day Settings record with a chosen semester at once (see
// utils/semesterAssignment.js's own header comment for exactly what is
// and isn't touched, and why - nothing is ever deleted or moved, only
// tagged, and a day that already has a real entry under the target
// semester is safely skipped rather than overwritten).
router.post('/schedule/semesters/assign-missing', requireFullAdmin, async (req, res) => {
  const back = semesterSettingsBack(req);
  const sep = back.includes('?') ? '&' : '?';
  const semesterId = parseInt(req.body.semesterId, 10);
  if (!semesterId) {
    return res.redirect(back + sep + 'error=' + encodeURIComponent('Choose a semester first.'));
  }
  const { before, skippedTotal } = await assignMissingSemesterData(semesterId);
  // Also makes this the Kiosk's active semester (Settings > Kiosk) - the
  // Floater Assignments/Setup-Cleanup admin pages and the live Kiosk both
  // resolve "which semester" from that setting, not from "whichever
  // semester a list most recently got tagged with". Without this, the
  // very next visit to those pages (still pointed at whatever semester -
  // or no semester - was active before) would silently start a brand new,
  // empty list instead of showing the data this action just connected.
  await setActiveKioskSemesterId(semesterId);
  const parts = [];
  if (before.classes) parts.push(`${before.classes} class${before.classes === 1 ? '' : 'es'}`);
  if (before.volunteerLists) parts.push(`${before.volunteerLists} Floater List${before.volunteerLists === 1 ? '' : 's'}`);
  if (before.setupTeams) parts.push(`${before.setupTeams} Setup/Cleanup Team${before.setupTeams === 1 ? '' : 's'}`);
  if (before.taskListSections) parts.push(`${before.taskListSections} Task List${before.taskListSections === 1 ? '' : 's'}`);
  if (before.classSchedules) parts.push(`${before.classSchedules} Day Settings record${before.classSchedules === 1 ? '' : 's'}`);
  let notice = parts.length === 0 ? 'Nothing was missing a semester.' : `Connected ${parts.join(', ')} to this semester.`;
  notice += ' This is now the Kiosk’s active semester too.';
  if (skippedTotal > 0) notice += ` ${skippedTotal} item${skippedTotal === 1 ? '' : 's'} already had a conflicting entry under this semester and were left untouched.`;
  res.redirect(back + sep + 'notice=' + encodeURIComponent(notice));
});

// --- Classes > Settings: Day Settings (class_schedules) - a real
// request: "Full 7 day expansion so multiple semesters can be created and
// managed... now day settings. So we can create multiple semester
// schedule grids." Activating a day here (or re-activating it for a new
// semester) is what adds it to the Classes grid's own day-tab row - see
// utils/classSchedule.js's own listActiveClassDays/createClassSchedule.
function classScheduleFields(req) {
  return {
    title: req.body.title,
    dayOfWeek: req.body.dayOfWeek,
    semesterId: req.body.semesterId ? parseInt(req.body.semesterId, 10) : null,
    startDate: isValidISODate(req.body.startDate) ? req.body.startDate : null,
    endDate: isValidISODate(req.body.endDate) ? req.body.endDate : null,
  };
}

router.post('/schedule/class-schedules', requireFullAdmin, async (req, res) => {
  const back = '/admin/schedule?tab=settings&settingsTab=days';
  try {
    await createClassSchedule(classScheduleFields(req));
  } catch (err) {
    return res.redirect(back + '&error=' + encodeURIComponent(err.message));
  }
  res.redirect(back + '&notice=' + encodeURIComponent('Day schedule added.'));
});

router.post('/schedule/class-schedules/:id', requireFullAdmin, async (req, res) => {
  const back = '/admin/schedule?tab=settings&settingsTab=days';
  try {
    await updateClassSchedule(parseInt(req.params.id, 10), classScheduleFields(req));
  } catch (err) {
    return res.redirect(back + '&error=' + encodeURIComponent(err.message));
  }
  res.redirect(back + '&notice=' + encodeURIComponent('Day schedule updated.'));
});

router.post('/schedule/class-schedules/:id/delete', requireFullAdmin, async (req, res) => {
  await deleteClassSchedule(parseInt(req.params.id, 10));
  res.redirect('/admin/schedule?tab=settings&settingsTab=days&notice=' + encodeURIComponent('Day schedule removed.'));
});

// A real request rebuilt Co-op Class Settings entirely: "Remove [the
// per-class registration/cancel settings]... Add the settings shown in
// the images" (a similar co-op class-management product's own General
// Settings page). Every field here is genuinely co-op-wide - see
// utils/classSchedule.js's own classGlobalSettings/CLASS_SETTINGS_DEFAULTS
// for what's stored and utils/classRegistration.js for how each one is
// actually enforced.
router.post('/schedule/class-settings', requireFullAdmin, async (req, res) => {
  await saveClassGlobalSettings({
    ageRestrictionMode: req.body.ageRestrictionMode === 'fixed_date' ? 'fixed_date' : 'start_date',
    ageRestrictionMonth: req.body.ageRestrictionMonth,
    ageRestrictionDay: req.body.ageRestrictionDay,
    defaultLockByAge: req.body.defaultLockByAge === '1',
    defaultLockByGrade: req.body.defaultLockByGrade === '1',
    cancellationPolicy: ['through_end', 'before_start', 'never'].includes(req.body.cancellationPolicy) ? req.body.cancellationPolicy : 'through_end',
    autoCreditOnParentOrSystemRemoval: req.body.autoCreditOnParentOrSystemRemoval === '1',
    autoCreditOnAdminRemoval: req.body.autoCreditOnAdminRemoval === '1',
  });
  res.redirect('/admin/schedule?tab=settings&settingsTab=general&notice=' + encodeURIComponent('Class settings saved.'));
});

// --- Classes > Settings: Kiosk - a real request: "Add a tab in co-op
// admin portal settings called kiosk. There will be a drop down picker
// for choosing a semester that the kiosk page and all of its features
// are linked too. The floater list for that semester, the setup/cleanup,
// check in, check out... This way the kiosk can be changed each semester
// seamlessly." See utils/kioskSettings.js for how Floater/Setup-Cleanup/
// Check-In/Check-Out all resolve this same setting.
router.post('/schedule/kiosk-semester', requireFullAdmin, async (req, res) => {
  const semesterId = parseInt(req.body.semesterId, 10);
  if (!semesterId) {
    return res.redirect('/admin/schedule?tab=settings&settingsTab=kiosk&error=' + encodeURIComponent('Choose a semester first.'));
  }
  await setActiveKioskSemesterId(semesterId);
  res.redirect('/admin/schedule?tab=settings&settingsTab=kiosk&notice=' + encodeURIComponent('Kiosk semester updated.'));
});

// --- Member Schedules: bulk import ---
//
// One row = one whole member's week, up to SCHEDULE_SLOT_COUNT (8)
// classes - unlike the per-class roster import (one row = one student), a
// member can be in several classes across the week, so each row has its
// own numbered Class 1-8 slots (Start Time/Title/Location/Days), the same
// numbered-slot shape Mass Import Families uses for up to 8 kids. This
// mirrors the shape of a real external registration-system export
// (Class Start Time N / Class Title N / Class Location N / Class Days N,
// repeated per class) rather than inventing our own layout, so that kind
// of file can be uploaded here with no reformatting - each slot carries
// its own Day value instead of the day being implied by which numbered
// slot it's in, since a real export freely mixes which slot number lands
// on which day. Each filled-in slot is matched to an existing class by
// day + class name + start time/location (the class has to already exist
// on the Class Schedule - this only ever enrolls/staffs someone onto one,
// it never creates classes): a student row enrolls them as a student, a
// parent row adds them as that class's teacher. A slot whose Class Days
// value isn't Monday/Wednesday (this app has no other class day) can
// never match anything and is just skipped, same as any other unmatched
// slot. An optional Allergy column fills in the member's medical/allergy
// notes if they don't already have any on file - never overwrites an
// existing value, same non-destructive-merge convention the full-profile
// Members Import uses.
const SCHEDULE_SLOT_COUNT = 8;

function normalizeMatchText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Start Time and Location are both optional disambiguators for when more
// than one class shares a day + Class Title - a row is only rejected
// against a candidate when BOTH sides actually have a value and they
// disagree; either side being blank means there's nothing to compare, so
// it's not treated as a mismatch.
function scheduleFieldMismatch(candidateValue, rowValue) {
  if (!rowValue || !candidateValue) return false;
  return normalizeMatchText(candidateValue) !== normalizeMatchText(rowValue);
}

function scheduleImportHeaders() {
  const headers = ['Member First Name', 'Member Last Name', 'Allergy'];
  for (let i = 1; i <= SCHEDULE_SLOT_COUNT; i++) {
    headers.push(`Class Start Time ${i}`, `Class Title ${i}`, `Class Location ${i}`, `Class Days ${i}`);
  }
  return headers;
}

// base: [firstName, lastName, allergy]. filledSlots: an array of
// { position, startTime, className, room, days } for however many of
// this row's up to 8 slots are actually filled in - every other slot's 4
// columns are left blank.
function scheduleExampleRow(base, filledSlots) {
  const row = [...base];
  for (let i = 1; i <= SCHEDULE_SLOT_COUNT; i++) {
    const slot = filledSlots.find((s) => s.position === i);
    row.push(slot ? slot.startTime : '', slot ? slot.className : '', slot ? slot.room : '', slot ? slot.days : '');
  }
  return row;
}

router.get('/schedule/:tab/import-template.xlsx', requireFullAdmin, (req, res) => {
  if (req.params.tab !== 'members') return res.status(404).send('Not found');

  const exampleRow1 = scheduleExampleRow(['Jane', 'Smith', ''], [
    { position: 1, startTime: '9:00 AM', className: 'Art Adventures', room: 'Room 3', days: 'Mon' },
  ]);
  const exampleRow2 = scheduleExampleRow(['John', 'Smith', 'Peanut allergy'], [
    { position: 1, startTime: '9:00 AM', className: 'Art Adventures', room: 'Room 3', days: 'Mon' },
    { position: 2, startTime: '10:00 AM', className: 'PE', room: 'Gym', days: 'Wed' },
  ]);

  const buffer = buildTemplateWorkbook(scheduleImportHeaders(), [exampleRow1, exampleRow2]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="member-schedule-import-template.xlsx"');
  res.send(buffer);
});

function normalizeScheduleImportRow(row) {
  const lowerMap = {};
  for (const key of Object.keys(row)) lowerMap[key.trim().toLowerCase()] = row[key];
  const get = (label) => {
    const v = lowerMap[label.toLowerCase()];
    return v === undefined || v === null ? '' : String(v).trim();
  };
  const getFirst = (labels) => {
    for (const label of labels) {
      const v = get(label);
      if (v) return v;
    }
    return '';
  };

  const firstName = getFirst(['Member First Name', 'Student First Name', 'Student First', 'First Name']);
  const lastName = getFirst(['Member Last Name', 'Student Last Name', 'Student Last', 'Last Name']);
  const allergy = getFirst(['Allergy', 'Allergies', 'Medical/Allergy Notes', 'Medical Notes', 'Medical Note']);

  const slots = [];
  for (let i = 1; i <= SCHEDULE_SLOT_COUNT; i++) {
    const className = getFirst([`Class Title ${i}`, `Class Name ${i}`]);
    if (!className) continue;
    slots.push({
      className,
      day: parseClassDayValue(get(`Class Days ${i}`)),
      startTime: get(`Class Start Time ${i}`),
      room: getFirst([`Class Location ${i}`, `Room ${i}`]),
    });
  }

  return { name: [firstName, lastName].filter(Boolean).join(' '), allergy, slots };
}

router.post('/schedule/:tab/import', requireFullAdmin, uploadScheduleImport.single('file'), async (req, res) => {
  if (req.params.tab !== 'members') return res.status(404).send('Not found');
  // The browsing tab is merged (Member Schedules, filtered by Member
  // Type), but a spreadsheet import still has to know which role to
  // apply a match under - the "Import As" radio in the dialog (views/
  // admin-schedule.ejs) carries that instead of the old per-tab mapping.
  const memberType = req.body.memberType === 'parent' ? 'parent' : 'student';
  const redirectBase = `/admin/schedule?tab=members&type=${memberType}`;

  if (!req.file) {
    return res.redirect(`${redirectBase}&error=` + encodeURIComponent('Please choose a file to import.'));
  }

  let rows;
  try {
    rows = (await readRowsFromFile(req.file.buffer)).map(normalizeScheduleImportRow).filter((r) => r.name);
  } catch (err) {
    return res.redirect(`${redirectBase}&error=` + encodeURIComponent('Could not read that file. Please use the example spreadsheet format.'));
  }

  let matched = 0;
  let skipped = 0;
  // setEnrollment/addStaff each default to rebuilding that whole day's
  // rosters/schedules from scratch on every call - fine one at a time via
  // the admin UI, but far too slow run once per matched slot across a
  // whole file (a member can have up to SCHEDULE_SLOT_COUNT slots, so a
  // real import calls these dozens to hundreds of times). Both accept
  // skipSync to skip that per-call rebuild; the affected day(s) are synced
  // once each after the whole file's been processed instead.
  const touchedDays = new Set();

  // A live-reported timeout: the original version ran the member lookup,
  // the class lookup, AND (for students) an existing-roster lookup as
  // separate sequential queries for EVERY slot of EVERY row - a real
  // file (hundreds of rows, up to SCHEDULE_SLOT_COUNT slots each) fired
  // thousands of tiny round trips at a real, network-latency-bound
  // Postgres connection and never finished before Netlify's own function
  // timeout. Members and classes are fetched ONCE up front instead (same
  // fix shape as archiveMemberSchedules' own N+1 fix in
  // utils/schedule.js) and matched against these in-memory maps for the
  // rest of the scan - no query at all per slot until the actual writes
  // below.
  const membersByName = new Map();
  (await db.prepare('SELECT id, name, medical_notes FROM members WHERE member_type = ? AND active = 1').all(memberType)).forEach((m) => {
    membersByName.set(m.name.toLowerCase(), m);
  });
  const classesByDayName = new Map();
  (await db.prepare('SELECT * FROM classes').all()).forEach((c) => {
    const key = `${c.day}|${c.class_name.toLowerCase()}`;
    if (!classesByDayName.has(key)) classesByDayName.set(key, []);
    classesByDayName.get(key).push(c);
  });

  const allergyUpdates = [];
  const allergyUpdatedMemberIds = new Set(); // first row wins for a repeated name, matching the original per-row order
  const newStudentsByClass = new Map(); // classId -> Set(studentId)
  const staffToAdd = []; // { classId, memberId }

  for (const r of rows) {
    const member = membersByName.get(r.name.toLowerCase());
    if (!member) { skipped += r.slots.length || 1; continue; }

    if (r.allergy && !member.medical_notes && !allergyUpdatedMemberIds.has(member.id)) {
      allergyUpdates.push({ memberId: member.id, allergy: r.allergy });
      allergyUpdatedMemberIds.add(member.id);
    }

    for (const slot of r.slots) {
      const candidates = classesByDayName.get(`${slot.day}|${slot.className.toLowerCase()}`) || [];
      let cls = candidates[0];
      if (candidates.length > 1) {
        cls = candidates.find((c) => !scheduleFieldMismatch(c.start_time, slot.startTime) && !scheduleFieldMismatch(c.room, slot.room)) || null;
      } else if (candidates.length === 1) {
        cls = scheduleFieldMismatch(candidates[0].start_time, slot.startTime) || scheduleFieldMismatch(candidates[0].room, slot.room) ? null : candidates[0];
      }
      if (!cls) { skipped++; continue; }

      if (memberType === 'student') {
        if (!newStudentsByClass.has(cls.id)) newStudentsByClass.set(cls.id, new Set());
        newStudentsByClass.get(cls.id).add(member.id);
      } else {
        staffToAdd.push({ classId: cls.id, memberId: member.id });
      }
      touchedDays.add(cls.day);
      matched++;
    }
  }

  for (const { memberId, allergy } of allergyUpdates) {
    await db.prepare('UPDATE members SET medical_notes = ? WHERE id = ?').run(allergy, memberId);
  }

  // One setEnrollment call per distinct class touched by this import, not
  // per matched student - the original per-slot version called it once
  // per (student, class) pair, and setEnrollment's own DELETE-then-
  // reinsert-the-whole-roster shape made that quadratic in a popular
  // class's size (importing its 30th student re-wrote all 30 rows, not
  // just the new one). Merging every newly-matched student for a class
  // against its already-existing roster and writing it back once keeps
  // this additive (same as the original) at a fraction of the cost.
  for (const [classId, newIds] of newStudentsByClass) {
    const existingIds = (await db.prepare('SELECT student_id FROM class_enrollments WHERE class_id = ?').all(classId)).map((e) => e.student_id);
    const merged = new Set([...existingIds, ...newIds]);
    if (merged.size !== existingIds.length) await setEnrollment(classId, [...merged], { skipSync: true });
  }
  for (const { classId, memberId } of staffToAdd) {
    await addStaff(classId, memberId, 'teacher', { skipSync: true });
  }

  for (const d of touchedDays) await syncDayMemberRosters(d);

  res.redirect(
    `${redirectBase}&notice=` +
      encodeURIComponent(`Matched ${matched} schedule row(s)` + (skipped ? `, ${skipped} skipped (no matching class or member).` : '.'))
  );
});

// Archives the checked schedule cards (checkboxes on the Member Schedules
// grid, or its "Select All") - unenrolls each member from every class
// they're currently on, saving a snapshot of what they were on first. A
// selection can freely mix students and parents (archiveMemberSchedules
// already splits them internally), which the merged tab makes possible
// now that both are browsed together. See archiveMemberSchedules' own
// comment in utils/schedule.js.
router.post('/schedule/:tab/archive', requireFullAdmin, async (req, res) => {
  if (req.params.tab !== 'members') return res.status(404).send('Not found');
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/schedule?tab=members&error=' + encodeURIComponent('Select at least one member to archive.'));
  }
  const count = await archiveMemberSchedules(memberIds);
  res.redirect('/admin/schedule?tab=members&notice=' + encodeURIComponent(`Archived ${count} member schedule(s) - see the Archive tab.`));
});

router.get('/schedule/archive/:type/export.csv', requireFullAdmin, async (req, res) => {
  const type = req.params.type;
  if (!['student', 'parent'].includes(type)) return res.status(404).send('Not found');
  const archives = await listMemberScheduleArchives(type);
  const archiveDays = [...new Set(archives.flatMap((a) => Object.keys(a.daySchedules)))].sort((a, b) => CLASS_DAY_ORDER[a] - CLASS_DAY_ORDER[b]);
  const lines = [
    toCsvRow(['Name', ...archiveDays.map((d) => `${CLASS_DAY_LABELS[d]} Schedule`), 'Archived At']),
    ...archives.map((a) => toCsvRow([a.member_name, ...archiveDays.map((d) => a.daySchedules[d] || ''), a.archived_at])),
  ];
  sendCsv(res, `${type}-schedule-archive.csv`, lines);
});

router.post('/schedule/archive/:id/delete', requireFullAdmin, async (req, res) => {
  await deleteMemberScheduleArchive(parseInt(req.params.id, 10));
  res.redirect('/admin/schedule?tab=archive&notice=' + encodeURIComponent('Deleted from archive.'));
});

router.post('/schedule/archive/:type/delete-all', requireFullAdmin, async (req, res) => {
  const type = req.params.type;
  if (!['student', 'parent'].includes(type)) return res.status(404).send('Not found');
  const count = await deleteAllMemberScheduleArchives(type);
  res.redirect(`/admin/schedule?tab=archive&type=${type}&notice=` + encodeURIComponent(`Deleted all ${count} archived ${type} schedule(s).`));
});

router.post('/schedule/print-cards', requireFullAdmin, async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect('/admin/design?tab=print&error=' + encodeURIComponent('Select at least one member to print.'));
  }

  const placeholders = memberIds.map(() => '?').join(',');
  const members = (await db.prepare(`SELECT * FROM members WHERE id IN (${placeholders})`).all(...memberIds)).sort(byLastName);

  const template = await getScheduleCardTemplate();
  const bgCss = NameTagRenderCore.backgroundCss(template.background, template.backgroundOpacity);
  // Both days' live schedule rows computed once for this whole batch, not
  // once per member - see scheduleList's own comment on why the
  // per-member version is a severe N+1 (this route already had a
  // documented history of choking at real co-op scale - see the payload-
  // chunking fix on the client side for "Select All" batches). Same shared
  // helper utils/cardPairs.js's buildCardPairs uses now too.
  const scheduleByMember = await schedulesForMembers(members.map((m) => m.id));
  // Batches the primaryParentFor phone-number lookup too, not just the
  // schedule computation above - scheduleCardDataForMember would otherwise
  // still redo that per member even with its schedule precomputed (see
  // scheduleCardDataForMembers' own comment).
  const cardDataByMember = await scheduleCardDataForMembers(members, scheduleByMember);
  const cards = members.map((m) => ({
    html: NameTagRenderCore.renderBadgeElements(template.elements, cardDataByMember[m.id]),
    bgCss,
  }));

  res.render('admin-schedule-print-cards', {
    title: 'Print Schedule Cards',
    cards,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    SCHEDULE_CARD_SAFE_INSET,
  });
});

router.post('/schedule/design/template', requireFullAdmin, async (req, res) => {
  let layout;
  try {
    layout = typeof req.body.layout === 'string' ? JSON.parse(req.body.layout) : req.body.layout;
  } catch (err) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }
  if (!layout || !Array.isArray(layout.elements)) {
    return res.status(400).json({ ok: false, message: 'Invalid layout.' });
  }

  await db
    .prepare(
      `INSERT INTO schedule_card_templates (id, layout_json, updated_at) VALUES (1, ?, now_text())
       ON CONFLICT(id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = now_text()`
    )
    .run(JSON.stringify(layout));

  // See the equivalent comment in routes/admin-name-tag.js's own
  // template-save route - a layout can add/remove any number of image
  // elements with no simple "this upload replaces that one" moment to
  // hook cleanup onto, so this re-derives what's still referenced and
  // sweeps anything left over instead.
  await sweepScheduleCardImages();

  res.json({ ok: true });
});

router.post('/schedule/design-image', requireFullAdmin, uploadDesignImage.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No image uploaded.' });
  // See routes/admin-name-tag.js's identical route for why this hands
  // back a full URL rather than a bare key - a layout's image element
  // `src` is consumed directly as a literal URL by client-side rendering
  // code, with no server-side resolution step at render time.
  const key = await saveUpload({
    client: storageClient,
    bucket: SCHEDULE_CARD_IMAGES_BUCKET,
    localDir: DESIGN_IMAGE_DIR,
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    contentType: req.file.mimetype,
  });
  const url = storageClient ? publicUrl(SCHEDULE_CARD_IMAGES_BUCKET, key) : `/uploads/schedule-cards/${key}`;
  res.json({ ok: true, url });
});

// Read-only - member_schedules is entirely derived from the master Class
// Schedule now (see syncMemberSchedulesForDay in utils/classSchedule.js),
// so there's nothing to hand-edit here anymore. Enroll/staff the member on
// the Schedules page to change what shows up.
router.get('/schedule/member/:id/manage', requireFullAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const member = await db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!member) return res.status(404).send('Not found');
  const schedule = await getMemberSchedule(id);
  res.render('admin-schedule-manage', {
    title: `Schedule - ${member.name}`,
    member,
    schedule,
    dayLabels: CLASS_DAY_LABELS,
    // "All Schedules" back-link on the merged Member Schedules tab -
    // carries this member's own type along as the Filter popup's ?type=
    // so the admin lands back on a sensibly-scoped view instead of
    // always "All Members".
    returnType: member.member_type === 'parent' || member.member_type === 'admin' ? 'parent' : 'student',
  });
});

router.get('/schedule/export.csv', requireFullAdmin, async (req, res) => {
  const activeDays = await listActiveClassDays();
  const filters = {
    search: (req.query.search || '').trim(),
    day: activeDays.includes(req.query.day) ? req.query.day : '',
    grade: req.query.grade || '',
    teacher: req.query.teacher || '',
    room: req.query.room || '',
    className: req.query.className || '',
    rosterId: req.query.rosterId ? parseInt(req.query.rosterId, 10) : null,
    memberId: req.query.memberId ? parseInt(req.query.memberId, 10) : null,
  };
  const rows = await scheduleList(filters);

  const lines = [toCsvRow(['Member Name', 'Day', 'Class Number', 'Time', 'Class Name', 'Room', 'Teacher'])];
  rows.forEach((r) => {
    activeDays.forEach((day) => {
      r.byDay[day].forEach((c) => {
        if (!c.class_name && !c.room && !c.time && !c.teacher) return;
        lines.push(toCsvRow([r.member.name, day, c.class_number, c.time || '', c.class_name || '', c.room || '', c.teacher || '']));
      });
    });
  });

  sendCsv(res, 'class-schedules.csv', lines);
});

router.get('/schedule/print', requireFullAdmin, async (req, res) => {
  const familyId = req.query.familyId ? parseInt(req.query.familyId, 10) : null;
  const activeDays = await listActiveClassDays();
  const filters = {
    search: (req.query.search || '').trim(),
    day: activeDays.includes(req.query.day) ? req.query.day : '',
    grade: req.query.grade || '',
    teacher: req.query.teacher || '',
    room: req.query.room || '',
    className: req.query.className || '',
    rosterId: req.query.rosterId ? parseInt(req.query.rosterId, 10) : null,
    memberId: req.query.memberId ? parseInt(req.query.memberId, 10) : null,
    familyId,
  };
  let rows = await scheduleList(filters);
  // A family's "View All" print (routes/admin-members.js's Class Schedule
  // tab) uses a compact one-row-per-member table instead of the normal
  // one-card-per-member layout below - a family of even 3-4 people
  // already runs each member's own two full 4-row day tables past a
  // single printed page, which defeats the entire point of printing them
  // together.
  // A real request: "List parents first, then students starting with the
  // oldest." scheduleList's own default order is just byLastName - only
  // reordered here, for this one family print, not the Class Schedules
  // page's own list.
  if (familyId) {
    rows = [...rows].sort((a, b) => {
      const aIsStudent = a.member.member_type === 'student';
      const bIsStudent = b.member.member_type === 'student';
      if (aIsStudent !== bIsStudent) return aIsStudent ? 1 : -1;
      if (aIsStudent) {
        const aAge = ageFromBirthday(a.member.birthday);
        const bAge = ageFromBirthday(b.member.birthday);
        if (aAge == null && bAge == null) return 0;
        if (aAge == null) return 1;
        if (bAge == null) return -1;
        return bAge - aAge;
      }
      return 0;
    });
  }
  res.render('admin-schedule-print', { title: 'Print Schedules', rows, activeDays, dayLabels: CLASS_DAY_LABELS, compact: !!familyId });
});

module.exports = router;
