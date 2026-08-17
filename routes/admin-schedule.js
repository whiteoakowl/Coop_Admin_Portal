const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const requireAdmin = require('../middleware/requireAdmin');
const requireFullAdmin = require('../middleware/requireFullAdmin');
const { isValidISODate } = require('../utils/dates');
const { defaultDateFor, parseDayValue } = require('../utils/days');
const { toCsvRow, sendCsv, buildTemplateWorkbook, readRowsFromFile } = require('../utils/spreadsheet');
const {
  DAY_LABELS,
  getMemberSchedule,
  schedulesForMembers,
  scheduleList,
  archiveMemberSchedules,
  listMemberScheduleArchives,
  deleteMemberScheduleArchive,
  deleteAllMemberScheduleArchives,
} = require('../utils/schedule');
const { byLastName } = require('../utils/members');
const {
  DAY_LABELS: CLASS_DAY_LABELS,
  hoursForDay,
  roomGridForDay,
  roomsForDay,
  GRADE_LEVELS,
  COLOR_PALETTE,
  activeMembersForStaff,
  absentMemberIdsForDate,
  setEnrollment,
  addStaff,
  syncDayMemberRosters,
  listClassArchives,
} = require('../utils/classSchedule');
const { CARD_WIDTH, CARD_HEIGHT } = require('../utils/scheduleCardBadge');
const { scheduleCardDataForMembers, getScheduleCardTemplate } = require('../utils/scheduleCardData');
const NameTagRenderCore = require('../public/js/name-tag-render-core');
const { imageFileFilter, spreadsheetFileFilter } = require('../utils/uploads');
const { sweepScheduleCardImages } = require('../utils/designImageGC');
const { createStorageClient, publicUrl } = require('../utils/storage');
const { saveUpload } = require('../utils/uploadBackend');

const uploadScheduleImport = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 }, fileFilter: spreadsheetFileFilter });

const DESIGN_IMAGE_DIR = path.join(__dirname, '..', 'public', 'uploads', 'schedule-cards');
const SCHEDULE_CARD_IMAGES_BUCKET = 'schedule-card-images';
const storageClient = createStorageClient();
// Only needed as a local-disk fallback - a serverless deployment's
// filesystem is read-only outside /tmp, so this must not run when
// Storage is actually configured.
if (!storageClient && !fs.existsSync(DESIGN_IMAGE_DIR)) fs.mkdirSync(DESIGN_IMAGE_DIR, { recursive: true });

const uploadDesignImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
});

const SCHEDULE_TABS = ['monday', 'wednesday', 'students', 'parents', 'archive'];
const ARCHIVE_TYPES = ['class', 'student', 'parent'];
const PAGE_SIZE = 25;

router.get('/schedule', requireAdmin, async (req, res) => {
  let tab = SCHEDULE_TABS.includes(req.query.tab) ? req.query.tab : 'monday';

  // Student/Parent Schedules and the Class Archive are full-Admin-only. A
  // Co-op Admin only gets the read-only day grid.
  if ((tab === 'students' || tab === 'parents' || tab === 'archive') && !res.locals.isFullAdmin) {
    tab = 'monday';
  }

  if (tab === 'monday' || tab === 'wednesday') {
    const selectedDate = isValidISODate(req.query.date) ? req.query.date : defaultDateFor(tab);
    return res.render('admin-schedule', {
      title: 'Schedules',
      tab,
      topTab: 'schedules',
      day: tab,
      dayLabel: CLASS_DAY_LABELS[tab],
      hours: await hoursForDay(tab),
      roomGrid: await roomGridForDay(tab),
      rooms: await roomsForDay(tab),
      gradeLevels: GRADE_LEVELS,
      colorPalette: COLOR_PALETTE,
      availableStaff: await activeMembersForStaff(),
      selectedDate,
      absentIds: await absentMemberIdsForDate(selectedDate),
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Archive: a pill toggle (Class/Student/Parent) switches between classes
  // archived from either day's grid (see archiveClasses in
  // utils/classSchedule.js) and members archived from the Student/Parent
  // Schedules tabs (see archiveMemberSchedules in utils/schedule.js) - two
  // different tables, same "flatten to plain text, drop the FK-linked
  // detail" archive philosophy either way.
  if (tab === 'archive') {
    const archiveType = ARCHIVE_TYPES.includes(req.query.type) ? req.query.type : 'class';
    const archives = archiveType === 'class' ? await listClassArchives() : await listMemberScheduleArchives(archiveType);
    return res.render('admin-schedule', {
      title: 'Schedules',
      tab,
      topTab: 'archive',
      archiveType,
      archives,
      dayLabels: CLASS_DAY_LABELS,
      error: req.query.error || null,
      notice: req.query.notice || null,
    });
  }

  // Student Schedules / Parent Schedules: every active member of that
  // type, shown as their actual Schedule Card (same design/rendering as
  // the printable card - see partials/name-tag-badge.ejs), laid out side
  // by side in alphabetical-by-last-name order. The old free-text search
  // is now a dropdown of every name in this tab, jumping straight to one
  // person's card via the memberId filter scheduleList already supports.
  const memberType = tab === 'parents' ? 'parent' : 'student';
  const selectedMemberId = req.query.memberId ? parseInt(req.query.memberId, 10) : null;
  const filters = { memberType, memberId: selectedMemberId || undefined };

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
  for (const r of rows) scheduleByMember[r.member.id] = { monday: r.monday, wednesday: r.wednesday };
  const cardDataByMember = await scheduleCardDataForMembers(
    rows.map((r) => r.member),
    scheduleByMember
  );
  const summarized = rows.map((r) => ({
    member: r.member,
    scheduleCardHtml: NameTagRenderCore.renderBadgeElements(scheduleCardTemplate.elements, cardDataByMember[r.member.id]),
  }));
  summarized.sort((a, b) => byLastName(a.member, b.member));

  const allNames = (await db.prepare('SELECT id, name FROM members WHERE active = 1 AND member_type = ?').all(memberType)).sort(byLastName);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalPages = Math.max(1, Math.ceil(summarized.length / PAGE_SIZE));
  const pageRows = summarized.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  res.render('admin-schedule', {
    title: 'Schedules',
    tab,
    topTab: tab,
    rows: pageRows,
    totalCount: summarized.length,
    page,
    totalPages,
    scheduleCardBgCss,
    cardWidth: CARD_WIDTH,
    cardHeight: CARD_HEIGHT,
    allNames,
    selectedMemberId,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// --- Student/Parent Schedules: bulk import ---
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
const SCHEDULE_IMPORT_TABS = { students: 'student', parents: 'parent' };
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
  const tab = req.params.tab;
  if (!SCHEDULE_IMPORT_TABS[tab]) return res.status(404).send('Not found');

  const exampleRow1 = scheduleExampleRow(['Jane', 'Smith', ''], [
    { position: 1, startTime: '9:00 AM', className: 'Art Adventures', room: 'Room 3', days: 'Mon' },
  ]);
  const exampleRow2 = scheduleExampleRow(['John', 'Smith', 'Peanut allergy'], [
    { position: 1, startTime: '9:00 AM', className: 'Art Adventures', room: 'Room 3', days: 'Mon' },
    { position: 2, startTime: '10:00 AM', className: 'PE', room: 'Gym', days: 'Wed' },
  ]);

  const buffer = buildTemplateWorkbook(scheduleImportHeaders(), [exampleRow1, exampleRow2]);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${tab}-schedule-import-template.xlsx"`);
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
      day: parseDayValue(get(`Class Days ${i}`)),
      startTime: get(`Class Start Time ${i}`),
      room: getFirst([`Class Location ${i}`, `Room ${i}`]),
    });
  }

  return { name: [firstName, lastName].filter(Boolean).join(' '), allergy, slots };
}

router.post('/schedule/:tab/import', requireFullAdmin, uploadScheduleImport.single('file'), async (req, res) => {
  const tab = req.params.tab;
  const memberType = SCHEDULE_IMPORT_TABS[tab];
  if (!memberType) return res.status(404).send('Not found');
  const redirectBase = `/admin/schedule?tab=${tab}`;

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

// Archives the checked schedule cards (checkboxes on the Student/Parent
// Schedules grid, or its "Select All") - unenrolls each member from every
// class they're currently on, saving a snapshot of what they were on
// first. See archiveMemberSchedules' own comment in utils/schedule.js.
router.post('/schedule/:tab/archive', requireFullAdmin, async (req, res) => {
  const tab = req.params.tab;
  const memberType = SCHEDULE_IMPORT_TABS[tab];
  if (!memberType) return res.status(404).send('Not found');
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10)).filter(Boolean);
  if (memberIds.length === 0) {
    return res.redirect(`/admin/schedule?tab=${tab}&error=` + encodeURIComponent('Select at least one member to archive.'));
  }
  const count = await archiveMemberSchedules(memberIds);
  res.redirect(`/admin/schedule?tab=${tab}&notice=` + encodeURIComponent(`Archived ${count} member schedule(s) - see the Archive tab.`));
});

router.get('/schedule/archive/:type/export.csv', requireFullAdmin, async (req, res) => {
  const type = req.params.type;
  if (!['student', 'parent'].includes(type)) return res.status(404).send('Not found');
  const archives = await listMemberScheduleArchives(type);
  const lines = [
    toCsvRow(['Name', 'Monday Schedule', 'Wednesday Schedule', 'Archived At']),
    ...archives.map((a) => toCsvRow([a.member_name, a.monday_schedule || '', a.wednesday_schedule || '', a.archived_at])),
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
  const members = await db
    .prepare(`SELECT * FROM members WHERE id IN (${placeholders}) ORDER BY LOWER(name)`)
    .all(...memberIds);

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
  const { monday, wednesday } = await getMemberSchedule(id);
  res.render('admin-schedule-manage', {
    title: `Schedule - ${member.name}`,
    member,
    monday,
    wednesday,
    dayLabels: DAY_LABELS,
    returnTab: member.member_type === 'parent' ? 'parents' : 'students',
  });
});

router.get('/schedule/export.csv', requireFullAdmin, async (req, res) => {
  const filters = {
    search: (req.query.search || '').trim(),
    day: ['monday', 'wednesday'].includes(req.query.day) ? req.query.day : '',
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
    [['monday', r.monday], ['wednesday', r.wednesday]].forEach(([day, dayRows]) => {
      dayRows.forEach((c) => {
        if (!c.class_name && !c.room && !c.time && !c.teacher) return;
        lines.push(toCsvRow([r.member.name, day, c.class_number, c.time || '', c.class_name || '', c.room || '', c.teacher || '']));
      });
    });
  });

  sendCsv(res, 'class-schedules.csv', lines);
});

router.get('/schedule/print', requireFullAdmin, async (req, res) => {
  const familyId = req.query.familyId ? parseInt(req.query.familyId, 10) : null;
  const filters = {
    search: (req.query.search || '').trim(),
    day: ['monday', 'wednesday'].includes(req.query.day) ? req.query.day : '',
    grade: req.query.grade || '',
    teacher: req.query.teacher || '',
    room: req.query.room || '',
    className: req.query.className || '',
    rosterId: req.query.rosterId ? parseInt(req.query.rosterId, 10) : null,
    memberId: req.query.memberId ? parseInt(req.query.memberId, 10) : null,
    familyId,
  };
  const rows = await scheduleList(filters);
  // A family's "View All" print (routes/admin-members.js's Class Schedule
  // tab) uses a compact one-row-per-member table instead of the normal
  // one-card-per-member layout below - a family of even 3-4 people
  // already runs each member's own two full 4-row day tables past a
  // single printed page, which defeats the entire point of printing them
  // together.
  res.render('admin-schedule-print', { title: 'Print Schedules', rows, compact: !!familyId });
});

module.exports = router;
