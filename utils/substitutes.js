const db = require('../db');
const { HOUR_POSITIONS, hoursForDay, gridForDay, missingMemberIdsForDate, floaterPositionsCoveredByClass } = require('./classSchedule');
const { getListByDay, sectionsForList, membersForSection, RANK_ORDER } = require('./volunteers');
const { hasInfantChild } = require('./members');
const { todayISO, formatTimestamp } = require('./dates');
const { parseClockMinutes } = require('./schedule');

// True once it's more than 5 minutes past an hour's start time on today's
// date and the person assigned to cover it still hasn't checked in
// anywhere - the board re-flags the slot as still needing a substitute
// instead of quietly trusting a no-show assignment. Only meaningful for
// today (there's no "current time" to compare a future/past date against).
//
// A real bug found while wiring isAutoLateForClass below (same 5-minute
// rule, added for a real request): this used to take the HOUR'S OWN
// LABEL (class_schedule_hours.label - free text an admin types, like
// "Hour 1", not necessarily a time at all) and try to parse a clock time
// out of it via splitTimeRange - which only works if that label happens
// to literally BE a time range. hourStartTime is the hour's actual
// start_time column instead (the same field the Start Time form field on
// the class schedule's own Edit Dates dialog writes to, already a plain
// parseable clock string) - a real time regardless of whatever text the
// label carries.
async function assignedIsOverdue(existing, date, hourStartTime) {
  if (!existing || existing.status !== 'approved') return false;
  if (date !== todayISO()) return false;
  const startMin = parseClockMinutes(hourStartTime);
  if (startMin === null) return false;
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < startMin + 5) return false;
  const checkedIn = await db
    .prepare(`SELECT 1 FROM attendance WHERE member_id = ? AND session_date = ? AND check_in_time IS NOT NULL LIMIT 1`)
    .get(existing.member_id, date);
  return !checkedIn;
}

// A real request: "if a teacher or assistant doesn't check in by 5 minutes
// after their class starts, the teaching or class assistant position
// should show as a floater needed position." Same "more than 5 minutes
// past the hour's start, still no check-in today" rule assignedIsOverdue
// above already uses to re-flag a no-show FLOATER - this is that same
// clock check applied to the teacher/assistant slot itself, before
// anyone's explicitly marked them absent/late at all. Purely a computed,
// read-time signal (like assignedIsOverdue - never written back to the
// attendance table): an admin who does later mark them present or absent
// simply changes what missingMemberIdsForDate already reports, no
// separate auto-written row to reconcile. Today-only, same reasoning as
// assignedIsOverdue - there's no "current time" to compare a future or
// past date's own start time against. Takes the hour's own start_time
// column (see assignedIsOverdue's own comment on why NOT its label).
async function isAutoLateForClass(memberId, date, hourStartTime) {
  if (date !== todayISO()) return false;
  const startMin = parseClockMinutes(hourStartTime);
  if (startMin === null) return false;
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < startMin + 5) return false;
  const checkedIn = await db
    .prepare(`SELECT 1 FROM attendance WHERE member_id = ? AND session_date = ? AND check_in_time IS NOT NULL LIMIT 1`)
    .get(memberId, date);
  return !checkedIn;
}

// session_date IS NULL - the recurring jobs this function has always
// returned. A Temporary Position (see temporaryJobsForDayDate below)
// deliberately never shows up here, so it can't leak into the recurring
// Add/Edit Position dialog's own group list.
async function permanentJobsForDay(day) {
  return db.prepare('SELECT * FROM permanent_jobs WHERE day = ? AND session_date IS NULL ORDER BY hour_position, LOWER(title)').all(day);
}

// A real request: "add a button on floater assignment page ... called
// add/edit temporary position ... the job is only available that day."
// Same permanent_jobs row shape (and the exact same substitute_assignments
// assign/unassign machinery permanentJobsForDay's own rows already use -
// see the migration's own comment), just scoped to one specific date
// instead of recurring every session.
async function temporaryJobsForDayDate(day, date) {
  return db.prepare('SELECT * FROM permanent_jobs WHERE day = ? AND session_date = ? ORDER BY hour_position, LOWER(title)').all(day, date);
}

async function getPermanentJob(id) {
  return db.prepare('SELECT * FROM permanent_jobs WHERE id = ?').get(id);
}

async function floaterIdsForJob(jobId) {
  return (await db.prepare('SELECT member_id FROM permanent_job_floaters WHERE job_id = ?').all(jobId)).map((r) => r.member_id);
}

async function createPermanentJob(fields) {
  const info = await db
    .prepare('INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES (?, ?, ?, ?)')
    .run(fields.day, fields.hourPosition, fields.title, fields.room || null);
  return info.lastInsertRowid;
}

async function createTemporaryJob(fields) {
  const info = await db
    .prepare('INSERT INTO permanent_jobs (day, hour_position, title, room, session_date) VALUES (?, ?, ?, ?, ?)')
    .run(fields.day, fields.hourPosition, fields.title, fields.room || null, fields.date);
  return info.lastInsertRowid;
}

async function updatePermanentJob(id, fields) {
  await db.prepare('UPDATE permanent_jobs SET hour_position = ?, title = ?, room = ? WHERE id = ?').run(
    fields.hourPosition,
    fields.title,
    fields.room || null,
    id
  );
}

async function deletePermanentJob(id) {
  await db.prepare("DELETE FROM substitute_assignments WHERE slot_type = 'job' AND slot_id = ?").run(id);
  await db.prepare('DELETE FROM permanent_jobs WHERE id = ?').run(id);
}

// Groups permanentJobsForDay's per-hour rows into one entry per distinct
// title - the shape the Add/Edit Position dialog edits (see
// createPermanentJob's own comment: one "position" spanning several hours
// really is several rows, one per hour, all sharing the same title/room,
// so an admin editing "Front Desk" needs to see and change all of them at
// once, not one row at a time). keyId is just the first row's own id
// encountered for that title - stable enough to use as this group's own
// form-field key; savePositionGroup below looks its siblings back up by
// day+title at save time, not by this id specifically, so it doesn't need
// to be any particular row.
async function groupedPermanentJobsForDay(day) {
  const jobs = await permanentJobsForDay(day);
  const groups = new Map();
  for (const job of jobs) {
    if (!groups.has(job.title)) groups.set(job.title, { keyId: job.id, title: job.title, room: job.room || '', hours: [] });
    groups.get(job.title).hours.push(job.hour_position);
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// Applies one edited (or brand new) position group from the Add/Edit
// Position dialog. keyId null means "this is the blank Add New Position
// row at the bottom of the dialog", not an edit of an existing group -
// only creates rows there, and only if a title was actually given.
// Otherwise, title/room apply to every hour still checked; any hour that
// was previously part of this group but is no longer checked gets its own
// row deleted (this is also how a position is removed entirely - uncheck
// every hour, or clear its title, which forces every hour off the same
// way); any newly-checked hour gets a new row. Existing rows for hours
// that stay checked are updated in place rather than deleted+recreated,
// so their own floater list (permanent_job_floaters, set separately via
// setJobFloaters) isn't wiped out just because the title or room changed.
async function savePositionGroup(day, keyId, title, room, hours) {
  if (keyId == null) {
    if (!title || hours.length === 0) return;
    for (const hourPosition of hours) await createPermanentJob({ day, hourPosition, title, room });
    return;
  }
  const anchor = await getPermanentJob(keyId);
  if (!anchor) return;
  const desiredHours = title ? hours : [];
  const siblings = await db.prepare('SELECT * FROM permanent_jobs WHERE day = ? AND title = ?').all(day, anchor.title);
  const existingHours = new Set(siblings.map((r) => r.hour_position));
  for (const row of siblings) {
    if (desiredHours.includes(row.hour_position)) {
      await updatePermanentJob(row.id, { hourPosition: row.hour_position, title, room });
    } else {
      await deletePermanentJob(row.id);
    }
  }
  for (const hourPosition of desiredHours) {
    if (!existingHours.has(hourPosition)) await createPermanentJob({ day, hourPosition, title, room });
  }
}

// A real bug report: "next to each position in that pop up there should
// be a trashcan symbol to remove that position. once you click the trash
// can the position is deleted." Before this, removing a position was only
// possible implicitly via savePositionGroup (uncheck every hour, then
// Save). keyId is a group's own anchor job id (see groupedPermanentJobsForDay);
// a group can be several permanent_jobs rows (one per hour it runs), all
// sharing day+title, so every sibling row - not just the anchor - has to
// go. Returns the deleted group's title (for the notice message), or null
// if keyId didn't resolve to a real job (already deleted/stale form).
async function deletePositionGroup(day, keyId) {
  const anchor = await getPermanentJob(keyId);
  if (!anchor) return null;
  const siblings = await db.prepare('SELECT id FROM permanent_jobs WHERE day = ? AND title = ?').all(day, anchor.title);
  for (const row of siblings) await deletePermanentJob(row.id);
  return anchor.title;
}

// Temporary Position's own version of groupedPermanentJobsForDay/
// savePositionGroup/deletePositionGroup above - identical shape, just
// grouped (and its siblings looked back up) by day+date+title instead of
// day+title, so a temporary position never gets confused with a
// recurring one that happens to share the same title on the same day.
async function groupedTemporaryJobsForDayDate(day, date) {
  const jobs = await temporaryJobsForDayDate(day, date);
  const groups = new Map();
  for (const job of jobs) {
    if (!groups.has(job.title)) groups.set(job.title, { keyId: job.id, title: job.title, room: job.room || '', hours: [] });
    groups.get(job.title).hours.push(job.hour_position);
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

async function saveTemporaryPositionGroup(day, date, keyId, title, room, hours) {
  if (keyId == null) {
    if (!title || hours.length === 0) return;
    for (const hourPosition of hours) await createTemporaryJob({ day, date, hourPosition, title, room });
    return;
  }
  const anchor = await getPermanentJob(keyId);
  if (!anchor) return;
  const desiredHours = title ? hours : [];
  const siblings = await db.prepare('SELECT * FROM permanent_jobs WHERE day = ? AND session_date = ? AND title = ?').all(day, date, anchor.title);
  const existingHours = new Set(siblings.map((r) => r.hour_position));
  for (const row of siblings) {
    if (desiredHours.includes(row.hour_position)) {
      await updatePermanentJob(row.id, { hourPosition: row.hour_position, title, room });
    } else {
      await deletePermanentJob(row.id);
    }
  }
  for (const hourPosition of desiredHours) {
    if (!existingHours.has(hourPosition)) await createTemporaryJob({ day, date, hourPosition, title, room });
  }
}

async function deleteTemporaryPositionGroup(day, date, keyId) {
  const anchor = await getPermanentJob(keyId);
  if (!anchor) return null;
  const siblings = await db.prepare('SELECT id FROM permanent_jobs WHERE day = ? AND session_date = ? AND title = ?').all(day, date, anchor.title);
  for (const row of siblings) await deletePermanentJob(row.id);
  return anchor.title;
}

async function setJobFloaters(jobId, memberIds) {
  await db.prepare('DELETE FROM permanent_job_floaters WHERE job_id = ?').run(jobId);
  const link = db.prepare('INSERT INTO permanent_job_floaters (job_id, member_id) VALUES (?, ?) ON CONFLICT (job_id, member_id) DO NOTHING');
  for (const memberId of memberIds) await link.run(jobId, memberId);
}

function rankSort(members) {
  return [...members].sort((a, b) => (RANK_ORDER[a.rank] ?? 1) - (RANK_ORDER[b.rank] ?? 1));
}

// substitute_assignments keys a slot by (session_date, slot_type, slot_id)
// with slot_id a single INTEGER. A class can now generate more than one
// floater slot - one per missing teacher/assistant - so each pairing needs
// its own synthetic id distinct from the class's own id (rather than one
// slot per class). Class ids and member ids are both small autoincrement
// integers in this app, well under the multiplier, so this stays unique
// and collision-free per class/staff pairing.
function classStaffSlotId(classId, staffMemberId) {
  return classId * 1000000 + staffMemberId;
}

// Same story as classStaffSlotId above, for a different slot_type
// ('vacancy') - a real request: "if class assistant says 1 and there are
// 0 assistants signed for that class, then the positions should appear
// on the floater list each week until someone is added as an assistant
// to that class roster... this also works if the assistant number is
// set to two, only 1 assistant is signed up... then 1 position should
// show up." A class can have more than one still-open seat for the SAME
// role at once (e.g. assistant_slots=2, nobody signed up yet), so each
// needs its own id: roleCode (1=teacher, 2=assistant) keeps the two
// roles apart on the same class, unitIndex (1-based) keeps multiple
// open seats for the same role apart. Up to 99 open seats per role per
// class before this would need widening - no real class gets anywhere
// close. slot_type already keeps this from colliding with 'job'/'class'
// slot ids (see the composite (session_date, slot_type, slot_id) key).
function classVacancySlotId(classId, role, unitIndex) {
  const roleCode = role === 'teacher' ? 1 : 2;
  return classId * 10000 + roleCode * 100 + unitIndex;
}

// Every still-open teacher/assistant seat for ONE class - teacher_slots/
// assistant_slots (utils/classSchedule.js's updateClass/createClass; null
// means "no cap set", not "zero needed", same convention as everywhere
// else those two columns are read) minus however many are actually on the
// class's own roster (class_staff) right now. Deliberately NOT date-scoped
// (unlike a missing-teacher-today slot) - a standing staffing gap needs
// recruiting every single session until it's actually filled, not just
// the one day someone happens to be out. Shape matches the
// missing-teacher-today slots pushed inline in substituteBoard below,
// minus `assigned`/`overdue` (the caller fills those in per its own
// read-vs-write needs).
function classVacancyEntriesForClass(cls) {
  const entries = [];
  [
    { role: 'teacher', needed: cls.teacher_slots, roleLabel: 'Teacher' },
    { role: 'assistant', needed: cls.assistant_slots, roleLabel: 'Assistant' },
  ].forEach(({ role, needed, roleLabel }) => {
    if (needed == null) return;
    const filled = cls.staff.filter((s) => s.role === role).length;
    const short = Math.max(0, needed - filled);
    for (let unitIndex = 1; unitIndex <= short; unitIndex++) {
      entries.push({
        slotType: 'vacancy',
        slotId: classVacancySlotId(cls.id, role, unitIndex),
        label: cls.class_name,
        room: cls.room || '',
        detail: cls.room ? `Room ${cls.room}` : '',
        ageGroup: cls.age_group || '',
        reason: `${roleLabel} needed (${filled} of ${needed} filled)`,
      });
    }
  });
  return entries;
}

// Every class's own vacancy entries (classVacancyEntriesForClass above),
// indexed by every hour position that class's real time overlaps - same
// double-period expansion classStaffByHour already gives the
// missing-teacher-TODAY slots, applied here too. Without this, a
// double-period class's standing vacancy only ever showed up under its
// own single hour_position bucket (gridForDay never files a class under
// more than one), so a real 2-hour class short a teacher silently
// vanished from the SECOND hour's chart - a real bug report: "not showing
// 2 hour classes on the floater list that are missing a teacher." Reuses
// classSchedule.js's own floaterPositionsCoveredByClass, same as
// classStaffByHour.
async function classVacancySlotsByHour(grid) {
  const byHour = {};
  for (const hourGroup of grid) {
    for (const cls of hourGroup.classes) {
      const entries = classVacancyEntriesForClass(cls);
      if (entries.length === 0) continue;
      const { positions } = await floaterPositionsCoveredByClass(cls.id);
      for (const position of positions) {
        if (!byHour[position]) byHour[position] = [];
        byHour[position].push(...entries);
      }
    }
  }
  return byHour;
}

// Every class's teacher/assistant, indexed by every hour position that
// class's own real time overlaps - its own hour_position, plus, for a
// genuine "double period" class (e.g. Forest Wildlings, Preschool, PreK,
// Kinder, DnD, Cooking - one row whose own end_time actually reaches into
// a second hour block), whichever other position(s) that overlap covers.
// Reuses classSchedule.js's own floaterPositionsCoveredByClass - the same
// position-overlap logic that already drives clearing a covered class off
// the Floater Assignments list once a teacher/assistant picks it up. A
// real request: "if a teacher or assistant is absent for a 2 time slot
// class... then the position should appear on the floater list both hours
// the class takes place" - gridForDay only ever files a class under its
// own single hour_position bucket, so without this a double-period
// class's missing-teacher/assistant slot only ever reached ONE of the two
// hours it's actually short-staffed for.
async function classStaffByHour(grid) {
  const byHour = {};
  for (const hourGroup of grid) {
    for (const cls of hourGroup.classes) {
      const { positions } = await floaterPositionsCoveredByClass(cls.id);
      for (const position of positions) {
        if (!byHour[position]) byHour[position] = [];
        for (const person of cls.staff) byHour[position].push({ cls, person });
      }
    }
  }
  return byHour;
}

// Everyone on the day's Floater Assignments list for a given hour block,
// ranked (Choose First before Sometimes before Backup Only) - the pool
// substitute suggestions are drawn from, best candidate first. Hour
// positions line up 1-4 across both features by convention. Reads each
// member's rank for THIS specific hour (membersForSection), not a
// single member-wide rank, since Floater Teams now lets rank vary hour
// to hour.
async function floaterMembersForHour(day, hourPosition) {
  const list = await getListByDay(day);
  if (!list) return [];
  const section = (await sectionsForList(list.id)).find((s) => s.position === hourPosition);
  if (!section) return [];
  return rankSort(await membersForSection(list.id, section.id));
}

async function assignmentFor(date, slotType, slotId) {
  if (!date) return null;
  return db.prepare('SELECT * FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(date, slotType, slotId);
}

async function memberName(memberId) {
  const row = await db.prepare('SELECT name FROM members WHERE id = ? AND active = 1').get(memberId);
  return row ? row.name : null;
}

// An admin actively choosing someone (accepting a pending pick as-is,
// or overriding with someone else entirely) is always the final word -
// always lands as 'approved', whether or not a pending row already
// existed for this slot.
// A slot's own hour position, regardless of which kind it is - a
// permanent job's own hour_position column, or (for a class-coverage
// slot) the hour_position of the class classStaffSlotId encoded it from.
async function hourPositionForSlot(slotType, slotId) {
  if (slotType === 'job') {
    const row = await db.prepare('SELECT hour_position AS "hourPosition" FROM permanent_jobs WHERE id = ?').get(slotId);
    return row ? row.hourPosition : null;
  }
  const classId = Math.floor(slotId / (slotType === 'vacancy' ? 10000 : 1000000));
  const row = await db.prepare('SELECT hour_position AS "hourPosition" FROM classes WHERE id = ?').get(classId);
  return row ? row.hourPosition : null;
}

// A real bug: nothing here ever stopped the SAME member being written
// into two conflicting slots in the same hour - the board's own
// usedThisHour/availableFloaters tracking (substituteBoard, above) only
// ever guards a single render, not the write itself, so a second admin
// tab, a stale page, or two admins acting concurrently could double-book
// one floater into two positions at once with no warning either at
// submit time or afterward. Skips the check entirely if either slot's
// hour can't be resolved (a slot that's since been deleted) rather than
// blocking on stale data.
async function setAssignment(date, slotType, slotId, memberId, isOverride) {
  const targetHour = await hourPositionForSlot(slotType, slotId);
  if (targetHour != null) {
    // Only an already-APPROVED assignment elsewhere counts as a real
    // conflict - a merely 'pending' row (there's no way to write a new
    // one anymore, but a historical row from before the auto-suggest
    // system was removed could still exist) was never an admin's own
    // decision, so it must never block a genuinely different approved
    // assignment for the same member.
    const others = await db
      .prepare(
        `SELECT slot_type AS "slotType", slot_id AS "slotId" FROM substitute_assignments
         WHERE session_date = ? AND member_id = ? AND status = 'approved' AND NOT (slot_type = ? AND slot_id = ?)`
      )
      .all(date, memberId, slotType, slotId);
    for (const o of others) {
      if ((await hourPositionForSlot(o.slotType, o.slotId)) === targetHour) {
        throw new Error('This member is already covering a different position during this same hour.');
      }
    }
  }

  await db.prepare(
    `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status)
     VALUES (?, ?, ?, ?, ?, 'approved')
     ON CONFLICT(session_date, slot_type, slot_id) DO UPDATE SET member_id = excluded.member_id, is_override = excluded.is_override, status = 'approved'`
  ).run(date, slotType, slotId, memberId, isOverride ? 1 : 0);
}

// Admin confirms the automated pick without changing who it is. Nothing
// in this app writes a 'pending' row anymore (see substituteBoard's own
// comment - the auto-suggest system is gone), so this only ever matches
// a genuinely historical row; kept for the one existing route/test that
// still calls it rather than ripping out a working, harmless no-op.
async function approveAssignment(date, slotType, slotId) {
  await db.prepare(
    `UPDATE substitute_assignments SET status = 'approved' WHERE session_date = ? AND slot_type = ? AND slot_id = ? AND status = 'pending'`
  ).run(date, slotType, slotId);
}

async function clearAssignment(date, slotType, slotId) {
  await db.prepare('DELETE FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').run(date, slotType, slotId);
}

// floaterPool (optional - only substituteBoard's own hour-scoped pool has
// one to give) supplies `rank` so the Floater Assignments dropdown can
// still show a correct "(Choose First)"/"(Sometimes)"/"(Backup Only)"
// label for a slot's already-assigned floater even when availableFloaters
// itself no longer lists them (they're excluded there once used this
// hour - see resolveSlot) - routes/admin-volunteers.js unshifts this same
// assigned person back into the dropdown's own candidate list precisely
// because availableFloaters dropped them, so without this it silently
// showed a generic "(Available)" instead of their real rank, most visibly
// for a backup-only floater (the only tier this can ever silently misdi
// as anything looking like a "better" rank).
// A real bug: an admin approves someone for a future date, then that
// member gets archived (routes/admin-members.js's bulk-archive just sets
// active = 0, with no cleanup of substitute_assignments) - the board,
// planning grid, and public kiosk all kept showing them as covering it
// indefinitely, with nothing ever re-flagging the slot as unassigned. An
// inactive member's own name is null now, so treating that the same as
// "no assignment exists" (returning null, same as the !existing case
// above it) puts the slot back into the normal "Needs Substitute" state
// instead of silently pointing at someone who no longer exists here.
async function assignedInfo(existing, floaterPool) {
  if (!existing) return null;
  const name = await memberName(existing.member_id);
  if (!name) return null;
  return {
    id: existing.member_id,
    name,
    isOverride: !!existing.is_override,
    status: existing.status,
    infant: await hasInfantChild(existing.member_id),
    updatedLabel: formatTimestamp(existing.created_at),
    rank: floaterPool ? floaterPool.find((m) => m.id === existing.member_id)?.rank ?? null : null,
  };
}

// How many distinct hour cards each member already has an APPROVED
// assignment for on this date - a real request: "when someone is
// assigned it should show (1) next to their name to show they have been
// assigned one hour that day. if they are assigned a job on 2 hour cards
// that day it will say (2) and so on." Counts distinct hour positions,
// not raw assignment rows, since one person can only ever hold one
// approved assignment per hour anyway (setAssignment's own same-hour
// conflict check) - this is purely informational for an admin filling in
// a LATER hour's dropdown, not a filter (someone already covering hour 1
// is still a valid, listed choice for hour 3).
async function assignedHourCountsForDate(date) {
  if (!date) return {};
  const rows = await db
    .prepare(
      `SELECT member_id AS "memberId", slot_type AS "slotType", slot_id AS "slotId"
       FROM substitute_assignments WHERE session_date = ? AND status = 'approved'`
    )
    .all(date);
  const hoursByMember = new Map();
  for (const row of rows) {
    const hourPosition = await hourPositionForSlot(row.slotType, row.slotId);
    if (hourPosition == null) continue;
    if (!hoursByMember.has(row.memberId)) hoursByMember.set(row.memberId, new Set());
    hoursByMember.get(row.memberId).add(hourPosition);
  }
  const counts = {};
  for (const [memberId, hours] of hoursByMember) counts[memberId] = hours.size;
  return counts;
}

// The full "needs a substitute" board for a day, optionally scoped to a
// specific date (no date = no absence data yet, so classes never need a
// sub but permanent jobs still show since they need someone every
// session). Each hour lists its slots - one per class's missing teacher
// or assistant (a class with two missing staff gets two slots, one per
// person - see classStaffSlotId), plus one per permanent job.
//
// A real request: "don't suggest floaters. just offer the drop down menu
// of choices that aren't already assigned." This used to auto-pick (best
// rank first, round-robin across the day) and persist a 'pending'
// candidate for every open slot the first time a date's board was ever
// computed - an admin then either approved that guess as-is or overrode
// it. Nothing here auto-picks anymore: a slot with no existing assignment
// stays genuinely unassigned (`slot.assigned` is null) until an admin
// explicitly chooses someone from availableFloaters below and the route
// calls setAssignment - always straight to 'approved', never a
// system-guessed 'pending' in between.
async function substituteBoard(day, date) {
  const missingById = date ? await missingMemberIdsForDate(date) : new Map();
  const grid = await gridForDay(day);
  const classStaffByHourPosition = await classStaffByHour(grid);
  const classVacancySlotsByHourPosition = await classVacancySlotsByHour(grid);
  const jobs = await permanentJobsForDay(day);
  const tempJobs = date ? await temporaryJobsForDayDate(day, date) : [];
  const jobsByHour = {};
  [...jobs, ...tempJobs].forEach((j) => {
    if (!jobsByHour[j.hour_position]) jobsByHour[j.hour_position] = [];
    jobsByHour[j.hour_position].push(j);
  });

  const result = [];
  for (const hourGroup of grid) {
    const hourPosition = hourGroup.position;
    const floaterPool = (await floaterMembersForHour(day, hourPosition)).filter((m) => !missingById.has(m.id));
    const usedThisHour = new Set();
    const slots = [];

    // Reads whatever's already been explicitly assigned (setAssignment,
    // always 'approved') - never picks anyone itself. Still tracks who's
    // already covering another slot THIS hour (usedThisHour), so
    // availableFloaters below can leave them off every other slot's own
    // dropdown for the hour - one person obviously can't be in two places
    // at once, but can freely be assigned again in a different hour later
    // the same day (see assignedHourCountsForDate for surfacing that).
    async function resolveSlot(slotType, slotId) {
      const existing = await assignmentFor(date, slotType, slotId);
      if (existing) usedThisHour.add(existing.member_id);
      return existing;
    }

    // Every missing teacher or assistant on a class is its own slot - a
    // class with two staff out that hour needs two floaters, so it shows
    // up on the chart twice, once per person, each with its own
    // assign/accept flow. A "late" status counts the same as "absent"
    // here (see missingMemberIdsForDate) - either way that staff member
    // isn't going to be covering their spot. Falls back to
    // isAutoLateForClass's own computed check (5+ minutes past this
    // hour's own start, still no check-in) when no one's explicitly
    // marked them absent/late yet - a real request: this shouldn't need
    // an admin to notice and mark it by hand first.
    for (const { cls, person } of classStaffByHourPosition[hourPosition] || []) {
      if (person.role !== 'teacher' && person.role !== 'assistant') continue;
      let status = missingById.get(person.id);
      if (!status && date && (await isAutoLateForClass(person.id, date, hourGroup.start_time))) status = 'late';
      if (!status) continue;

      const slotId = classStaffSlotId(cls.id, person.id);
      const existing = await resolveSlot('class', slotId);
      const roleLabel = person.role === 'teacher' ? 'Teacher' : 'Assistant';
      const statusLabel = status === 'late' ? 'running late' : 'absent';

      slots.push({
        slotType: 'class',
        slotId,
        label: cls.class_name,
        room: cls.room || '',
        detail: cls.room ? `Room ${cls.room}` : '',
        ageGroup: cls.age_group || '',
        reason: `${roleLabel} ${statusLabel}: ${person.name}`,
        assigned: await assignedInfo(existing, floaterPool),
        overdue: await assignedIsOverdue(existing, date, hourGroup.start_time),
      });
    }

    // Standing teacher/assistant vacancies - see classVacancyEntriesForClass's
    // own comment on why these aren't date-scoped like the "missing today"
    // slots just above.
    for (const vacancy of classVacancySlotsByHourPosition[hourPosition] || []) {
      const existing = await resolveSlot('vacancy', vacancy.slotId);
      slots.push({
        ...vacancy,
        assigned: await assignedInfo(existing, floaterPool),
        overdue: await assignedIsOverdue(existing, date, hourGroup.start_time),
      });
    }

    for (const job of jobsByHour[hourPosition] || []) {
      const existing = await resolveSlot('job', job.id);

      slots.push({
        overdue: await assignedIsOverdue(existing, date, hourGroup.start_time),
        slotType: 'job',
        slotId: job.id,
        label: job.title,
        room: job.room || '',
        detail: job.session_date ? 'Temporary Position' : 'Permanent Job',
        reason: job.session_date ? 'Added for this date only' : 'Staffed every session',
        assigned: await assignedInfo(existing, floaterPool),
      });
    }

    // Rank-sorted (Choose First before Sometimes before Backup Only), not
    // yet used elsewhere this hour - routes/admin-volunteers.js's own
    // buildHourSections turns this into every slot's own <select> options,
    // plain choices for an admin to pick from, not a pre-picked suggestion.
    const availableFloaters = rankSort(floaterPool.filter((m) => !usedThisHour.has(m.id)));

    result.push({ position: hourPosition, label: hourGroup.label, slots, availableFloaters });
  }
  return result;
}

// Multi-date planning grid for the Monday/Wednesday Floater Assignments
// tab: every permanent job, grouped by hour, with one assigned-member
// column per session date - the forward-planning counterpart to
// substituteBoard's single-date "who needs a sub today" view. Both read
// the same substitute_assignments table (setAssignment/assignmentFor), so
// assigning someone here is exactly the same action as approving a
// substitute - there's only one "who's covering this slot" system,
// whether it's being planned weeks ahead or filled last-minute.
async function jobAssignmentGrid(day, dates) {
  const jobs = await permanentJobsForDay(day);
  const byHour = {};
  jobs.forEach((j) => {
    if (!byHour[j.hour_position]) byHour[j.hour_position] = [];
    byHour[j.hour_position].push(j);
  });
  const hours = [];
  for (const hourPosition of HOUR_POSITIONS) {
    const hourJobs = [];
    for (const job of byHour[hourPosition] || []) {
      const cells = [];
      for (const date of dates) {
        cells.push({ date, assigned: await assignedInfo(await assignmentFor(date, 'job', job.id)) });
      }
      hourJobs.push({ id: job.id, title: job.title, room: job.room || '', cells });
    }
    hours.push({ position: hourPosition, jobs: hourJobs });
  }
  return hours.filter((h) => h.jobs.length > 0);
}

// Single-date "Floater Assignment Dashboard" cards (the Archive tab's own
// popup/print/CSV record for a date that's passed) - same permanent-job
// data as jobAssignmentGrid, reshaped for one date's cards instead of a
// multi-date table (each job gets one `assigned` directly, not a
// one-element `cells` array), PLUS each hour's own approved class-
// coverage slots. A real bug: this used to only ever read permanent_jobs
// - the same gap publicFloaterCardsForDate (the public kiosk's own view)
// was already fixed for - so an approved substitute covering a class's
// own missing teacher/assistant slot was invisible in the Archive tab's
// view, print, and CSV export, even though the live Substitutes Needed
// board (substituteBoard) is exactly where an admin approves those
// slots. Mirrors publicFloaterCardsForDate's own class loop: only ever
// READS existing substitute_assignments rows (never auto-picks/writes,
// unlike substituteBoard), and only surfaces a slot once it's 'approved'
// - a still-pending suggestion has no place in a historical record of
// what actually happened.
async function dailyAssignmentCards(day, date) {
  const jobHours = await jobAssignmentGrid(day, [date]);
  const jobsByHour = {};
  jobHours.forEach((h) => {
    jobsByHour[h.position] = h.jobs.map((job) => ({ id: job.id, title: job.title, room: job.room, assigned: job.cells[0].assigned }));
  });

  const missingById = await missingMemberIdsForDate(date);
  const grid = await gridForDay(day);
  const classStaffByHourPosition = await classStaffByHour(grid);
  const classVacancySlotsByHourPosition = await classVacancySlotsByHour(grid);
  const classesByHour = {};
  for (const hourGroup of grid) {
    const rows = [];
    for (const { cls, person } of classStaffByHourPosition[hourGroup.position] || []) {
      if (person.role !== 'teacher' && person.role !== 'assistant') continue;
      if (!missingById.has(person.id)) continue;
      const existing = await assignmentFor(date, 'class', classStaffSlotId(cls.id, person.id));
      rows.push({
        title: cls.class_name,
        room: cls.room || '',
        assigned: existing && existing.status === 'approved' ? await assignedInfo(existing) : null,
      });
    }
    // Standing teacher/assistant vacancies (see classVacancySlotsByHour) -
    // same "only an approved assignment counts" rule as the class-absence
    // rows just above, so a still-pending auto-suggestion never shows up
    // in this historical/read-only record.
    for (const vacancy of classVacancySlotsByHourPosition[hourGroup.position] || []) {
      const existing = await assignmentFor(date, 'vacancy', vacancy.slotId);
      rows.push({
        title: vacancy.label,
        room: vacancy.room,
        assigned: existing && existing.status === 'approved' ? await assignedInfo(existing) : null,
      });
    }
    if (rows.length) classesByHour[hourGroup.position] = rows;
  }

  return HOUR_POSITIONS.map((position) => ({
    position,
    jobs: [...(jobsByHour[position] || []), ...(classesByHour[position] || [])],
  })).filter((h) => h.jobs.length > 0);
}

// dailyAssignmentCards with each hour's real label merged in - shared by
// the Archive tab/print page and the public kiosk view
// (partials/floater-assignment-cards.ejs needs `label` on every hour).
async function dailyAssignmentCardsWithLabels(day, date) {
  const hourLabelByPosition = {};
  (await hoursForDay(day)).forEach((h) => { hourLabelByPosition[h.position] = h.label; });
  return (await dailyAssignmentCards(day, date)).map((hour) => ({ ...hour, label: hourLabelByPosition[hour.position] || `Hour ${hour.position}` }));
}

// Public kiosk view's own combined per-hour position list - a real bug
// report: "when a member clicks on the floater assignment button on the
// kiosk page it only show[s] permanent positions with floater
// assignments. it's not showing the floater assignments for classes that
// have a missing teacher or assistant. it did allow me to assign
// floaters to missing teacher positions but it isn't showing up on
// member kiosk view." dailyAssignmentCards (the admin Chart tab/Archive's
// own data) only ever reads permanent_jobs - a class's own missing-
// teacher/assistant slot (substituteBoard's slot_type='class', the
// Substitutes Needed board an admin actually assigns those from) was
// never part of it at all, so an approved class-coverage assignment had
// nowhere on the kiosk to ever show up. Deliberately does NOT reuse
// substituteBoard itself - that function auto-picks and PERSISTS a
// 'pending' candidate for every open slot as a side effect of being
// called, which is exactly right for the admin board (an admin is about
// to review/approve those suggestions) but wrong for this public,
// no-login, view-only kiosk screen: a member just glancing at the chart
// must never itself be the trigger that writes new suggested assignments
// into the database. This only ever READS existing substitute_assignments
// rows (assignmentFor, same as jobAssignmentGrid's own permanent-job
// reads) and only ever shows one once its status is 'approved'.
//
// A real request: "do not show positions that don't have someone
// assigned. if it is unassigned it's invisible to members. only admins
// can see it." An unassigned/still-pending position used to render here
// as "Unassigned" (the same admin-facing wording the shared Archive
// partial still uses for dailyAssignmentCards) - this function is the
// ONE place that data feeds the public kiosk (routes/volunteers.js),
// separate from dailyAssignmentCards/dailyAssignmentCardsWithLabels
// (Archive tab + print, admin-only), so dropping unassigned rows here
// only ever affects what a member sees - an admin's own Archive/Chart
// views are untouched.
async function publicFloaterCardsForDate(day, date) {
  const missingById = await missingMemberIdsForDate(date);
  const grid = await gridForDay(day);
  const classStaffByHourPosition = await classStaffByHour(grid);
  const classVacancySlotsByHourPosition = await classVacancySlotsByHour(grid);
  const jobs = await permanentJobsForDay(day);
  const tempJobs = await temporaryJobsForDayDate(day, date);
  const jobsByHour = {};
  [...jobs, ...tempJobs].forEach((j) => {
    if (!jobsByHour[j.hour_position]) jobsByHour[j.hour_position] = [];
    jobsByHour[j.hour_position].push(j);
  });

  const result = [];
  for (const hourGroup of grid) {
    const positions = [];

    for (const { cls, person } of classStaffByHourPosition[hourGroup.position] || []) {
      if (person.role !== 'teacher' && person.role !== 'assistant') continue;
      if (!missingById.has(person.id)) continue;
      const existing = await assignmentFor(date, 'class', classStaffSlotId(cls.id, person.id));
      if (!existing || existing.status !== 'approved') continue;
      positions.push({ title: cls.class_name, room: cls.room || '', assigned: await assignedInfo(existing) });
    }

    for (const vacancy of classVacancySlotsByHourPosition[hourGroup.position] || []) {
      const existing = await assignmentFor(date, 'vacancy', vacancy.slotId);
      if (!existing || existing.status !== 'approved') continue;
      positions.push({ title: vacancy.label, room: vacancy.room, assigned: await assignedInfo(existing) });
    }

    for (const job of jobsByHour[hourGroup.position] || []) {
      const existing = await assignmentFor(date, 'job', job.id);
      if (!existing || existing.status !== 'approved') continue;
      positions.push({ title: job.title, room: job.room || '', assigned: await assignedInfo(existing) });
    }

    if (positions.length > 0) result.push({ position: hourGroup.position, label: hourGroup.label, jobs: positions });
  }
  return result;
}

// Archive tab: one row per date that's already passed, with how many of
// that day's permanent-job positions ended up with an approved floater -
// same underlying data as dailyAssignmentCards, just counted instead of
// rendered, for the log list before an admin opens one date's full record.
// A real bug, the same gap dailyAssignmentCards above was just fixed for:
// this only ever counted permanent_jobs, so a date fully covered by
// approved class-coverage substitutes (with zero permanent-job slots
// needing anyone) showed as "0 of 0" instead of reflecting the real
// class-coverage positions that date actually had.
async function archivedDateSummaries(day, dates) {
  const jobs = await permanentJobsForDay(day);
  const grid = await gridForDay(day);
  const classStaffByHourPosition = await classStaffByHour(grid);
  const classVacancySlotsByHourPosition = await classVacancySlotsByHour(grid);
  const result = [];
  for (const date of dates) {
    let totalPositions = jobs.length;
    let assignedCount = 0;
    for (const j of jobs) {
      const a = await assignmentFor(date, 'job', j.id);
      if (a && a.status === 'approved') assignedCount++;
    }

    const missingById = await missingMemberIdsForDate(date);
    for (const hourGroup of grid) {
      for (const { cls, person } of classStaffByHourPosition[hourGroup.position] || []) {
        if (person.role !== 'teacher' && person.role !== 'assistant') continue;
        if (!missingById.has(person.id)) continue;
        totalPositions++;
        const a = await assignmentFor(date, 'class', classStaffSlotId(cls.id, person.id));
        if (a && a.status === 'approved') assignedCount++;
      }
      for (const vacancy of classVacancySlotsByHourPosition[hourGroup.position] || []) {
        totalPositions++;
        const a = await assignmentFor(date, 'vacancy', vacancy.slotId);
        if (a && a.status === 'approved') assignedCount++;
      }
    }

    result.push({ date, totalPositions, assignedCount });
  }
  return result;
}

module.exports = {
  HOUR_POSITIONS,
  classStaffSlotId,
  classVacancySlotId,
  classVacancyEntriesForClass,
  permanentJobsForDay,
  temporaryJobsForDayDate,
  groupedPermanentJobsForDay,
  savePositionGroup,
  deletePositionGroup,
  groupedTemporaryJobsForDayDate,
  saveTemporaryPositionGroup,
  deleteTemporaryPositionGroup,
  getPermanentJob,
  floaterIdsForJob,
  createPermanentJob,
  updatePermanentJob,
  deletePermanentJob,
  setJobFloaters,
  floaterMembersForHour,
  assignmentFor,
  setAssignment,
  approveAssignment,
  clearAssignment,
  assignedHourCountsForDate,
  substituteBoard,
  jobAssignmentGrid,
  dailyAssignmentCards,
  dailyAssignmentCardsWithLabels,
  publicFloaterCardsForDate,
  archivedDateSummaries,
};
