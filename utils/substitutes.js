const db = require('../db');
const { HOUR_POSITIONS, hoursForDay, gridForDay, missingMemberIdsForDate } = require('./classSchedule');
const { DAYS, DAY_LABELS, getListByDay, sectionsForList, membersForSection, RANK_ORDER } = require('./volunteers');
const { hasInfantChild } = require('./members');
const { todayISO, weekdayOf, formatTimestamp } = require('./dates');
const { parseClockMinutes, splitTimeRange } = require('./schedule');

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };

// True once it's more than 5 minutes past an hour's start time on today's
// date and the person assigned to cover it still hasn't checked in
// anywhere - the board re-flags the slot as still needing a substitute
// instead of quietly trusting a no-show assignment. Only meaningful for
// today (there's no "current time" to compare a future/past date against).
async function assignedIsOverdue(existing, date, hourLabel) {
  if (!existing || existing.status !== 'approved') return false;
  if (date !== todayISO()) return false;
  const { startRaw } = splitTimeRange(hourLabel);
  const startMin = parseClockMinutes(startRaw);
  if (startMin === null) return false;
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < startMin + 5) return false;
  const checkedIn = await db
    .prepare(`SELECT 1 FROM attendance WHERE member_id = ? AND session_date = ? AND check_in_time IS NOT NULL LIMIT 1`)
    .get(existing.member_id, date);
  return !checkedIn;
}

async function permanentJobsForDay(day) {
  return db.prepare('SELECT * FROM permanent_jobs WHERE day = ? ORDER BY hour_position, LOWER(title)').all(day);
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
  const row = await db.prepare('SELECT name FROM members WHERE id = ?').get(memberId);
  return row ? row.name : null;
}

// An admin actively choosing someone (accepting a pending pick as-is,
// or overriding with someone else entirely) is always the final word -
// always lands as 'approved', whether or not a pending row already
// existed for this slot.
async function setAssignment(date, slotType, slotId, memberId, isOverride) {
  await db.prepare(
    `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status)
     VALUES (?, ?, ?, ?, ?, 'approved')
     ON CONFLICT(session_date, slot_type, slot_id) DO UPDATE SET member_id = excluded.member_id, is_override = excluded.is_override, status = 'approved'`
  ).run(date, slotType, slotId, memberId, isOverride ? 1 : 0);
}

// The automated sub system's own pick - only written when nothing exists
// yet for this slot, so it never clobbers an admin's approved choice (or
// someone else's still-pending pick from a moment ago).
async function autoAssign(date, slotType, slotId, memberId) {
  await db.prepare(
    `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status)
     VALUES (?, ?, ?, ?, 0, 'pending')
     ON CONFLICT(session_date, slot_type, slot_id) DO NOTHING`
  ).run(date, slotType, slotId, memberId);
}

// Admin confirms the automated pick without changing who it is.
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
// label for a slot's already-assigned floater even when suggestedFloaters
// itself no longer lists them (they're excluded there once used this
// hour - see resolveSlot) - routes/admin-volunteers.js unshifts this same
// assigned person back into the dropdown's own candidate list precisely
// because suggestedFloaters dropped them, so without this it silently
// showed a generic "(Available)" instead of their real rank, most visibly
// for a backup-only floater (the only tier this can ever silently misdi
// as anything looking like a "better" rank).
async function assignedInfo(existing, floaterPool) {
  if (!existing) return null;
  return {
    id: existing.member_id,
    name: await memberName(existing.member_id),
    isOverride: !!existing.is_override,
    status: existing.status,
    infant: await hasInfantChild(existing.member_id),
    updatedLabel: formatTimestamp(existing.created_at),
    rank: floaterPool ? floaterPool.find((m) => m.id === existing.member_id)?.rank ?? null : null,
  };
}

// The full "needs a substitute" board for a day, optionally scoped to a
// specific date (no date = no absence data yet, so classes never need a
// sub but permanent jobs still show since they need someone every
// session). Each hour lists its slots - one per class's missing teacher
// or assistant (a class with two missing staff gets two slots, one per
// person - see classStaffSlotId), plus one per permanent job. Any slot
// with no existing assignment yet and an available candidate gets one
// auto-picked right here (best rank first, preferring a job's own
// preferred-floater list) and persisted as 'pending', so approving it is
// a one-click confirm instead of a fresh choice every time the board is
// viewed.
async function substituteBoard(day, date) {
  const missingById = date ? await missingMemberIdsForDate(date) : new Map();
  const grid = await gridForDay(day);
  const jobs = await permanentJobsForDay(day);
  const jobsByHour = {};
  jobs.forEach((j) => {
    if (!jobsByHour[j.hour_position]) jobsByHour[j.hour_position] = [];
    jobsByHour[j.hour_position].push(j);
  });

  const result = [];
  // Tracks WHEN (not just whether) everyone auto-picked or already
  // assigned at any earlier hour today was last used, across the whole
  // day - not reset per hour, unlike usedThisHour below. A real request:
  // "suggest different floaters each hour. try to not suggested the same
  // person different hours in a day unless necessary... exhaust the list
  // all 4 hours and all positions before suggesting someone else again."
  // A plain "have they been used today at all" boolean Set (the original
  // fix for the first half of that request) only gets a pool through ONE
  // pass before it's useless: once literally everyone's been used once,
  // every remaining slot's "fresh" pool is empty, and the fallback below
  // always fell back to the exact same rank/alphabetically-first person
  // for the REST of the day - confirmed live with a 2-person pool and 4
  // one-job hours: hour 1/2 correctly split Alpha/Beta, but hours 3 AND 4
  // both landed back on Alpha, 3 assignments to Beta's 1, instead of
  // continuing to alternate. lastUsedSeq (member id -> the sequence
  // number they were used at) instead of a boolean lets bestAvailable
  // below pick whoever's gone longest since their last turn - a real
  // round-robin that keeps rotating through the whole pool for as many
  // repeat passes as the day's slot count needs, not just one.
  const lastUsedSeq = new Map();
  let useSeq = 0;
  for (const hourGroup of grid) {
    const hourPosition = hourGroup.position;
    const floaterPool = (await floaterMembersForHour(day, hourPosition)).filter((m) => !missingById.has(m.id));
    const usedThisHour = new Set();
    const slots = [];

    // Whoever has gone longest without a turn today wins (never-used-yet
    // counts as "longest," ahead of anyone with a real lastUsedSeq) -
    // `list` arrives already rank-sorted, and scanning it in that order
    // while only replacing on a STRICTLY lower key keeps rank as the
    // tiebreak whenever recency is otherwise equal (i.e. everyone in
    // contention is equally never-used-today), the same tiebreak the old
    // rank-order fallback gave every time - the difference is this now
    // keeps rotating through repeat passes too, instead of collapsing
    // back to a single "favorite" the moment the pool's first pass ends.
    function bestAvailable(list) {
      let best = null;
      let bestKey = Infinity;
      for (const m of list) {
        const key = lastUsedSeq.has(m.id) ? lastUsedSeq.get(m.id) : -1;
        if (key < bestKey) { best = m; bestKey = key; }
      }
      return best;
    }

    function pickCandidate(preferredIds) {
      const preferred = rankSort(
        (preferredIds || []).map((id) => floaterPool.find((m) => m.id === id)).filter((m) => m && !usedThisHour.has(m.id))
      );
      if (preferred.length > 0) return bestAvailable(preferred);
      return bestAvailable(floaterPool.filter((m) => !usedThisHour.has(m.id)));
    }

    async function resolveSlot(slotType, slotId, preferredIds) {
      let existing = await assignmentFor(date, slotType, slotId);
      // A real bug report: "the suggested floater name dropdown menus are
      // not updating as the floater teams are updated." A still-'pending'
      // pick (auto-suggested, never admin-approved) is just that - a
      // suggestion - but nothing here ever re-checked one's own
      // eligibility once written, so removing that exact person from the
      // Floater Team (or them becoming newly absent for this date - see
      // floaterPool's own missingById filter above) left the board still
      // showing them as "currently assigned" indefinitely, since resolve
      // Slot only ever auto-picks when NO row exists yet. Clearing a
      // pending row here the moment its own person no longer belongs to
      // this hour's pool makes the pickCandidate() call below immediately
      // re-derive a fresh, still-eligible suggestion instead of leaving a
      // stale name pinned in place. Never touches status:'approved' - an
      // admin's own deliberate pick stands until THEY change it.
      if (existing && existing.status === 'pending' && !floaterPool.some((m) => m.id === existing.member_id)) {
        await clearAssignment(date, slotType, slotId);
        existing = null;
      }
      if (!existing && date) {
        const candidate = pickCandidate(preferredIds);
        if (candidate) {
          await autoAssign(date, slotType, slotId, candidate.id);
          existing = await assignmentFor(date, slotType, slotId);
        }
      }
      if (existing) {
        usedThisHour.add(existing.member_id);
        lastUsedSeq.set(existing.member_id, useSeq++);
      }
      return existing;
    }

    // Every missing teacher or assistant on a class is its own slot - a
    // class with two staff out that hour needs two floaters, so it shows
    // up on the chart twice, once per person, each with its own
    // assign/accept flow. A "late" status counts the same as "absent"
    // here (see missingMemberIdsForDate) - either way that staff member
    // isn't going to be covering their spot.
    for (const cls of hourGroup.classes) {
      for (const person of cls.staff) {
        if (person.role !== 'teacher' && person.role !== 'assistant') continue;
        const status = missingById.get(person.id);
        if (!status) continue;

        const slotId = classStaffSlotId(cls.id, person.id);
        const existing = await resolveSlot('class', slotId, null);
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
          overdue: await assignedIsOverdue(existing, date, hourGroup.label),
        });
      }
    }

    for (const job of jobsByHour[hourPosition] || []) {
      const existing = await resolveSlot('job', job.id, await floaterIdsForJob(job.id));

      slots.push({
        overdue: await assignedIsOverdue(existing, date, hourGroup.label),
        slotType: 'job',
        slotId: job.id,
        label: job.title,
        room: job.room || '',
        detail: 'Permanent Job',
        reason: 'Staffed every session',
        assigned: await assignedInfo(existing, floaterPool),
      });
    }

    // Ranked, still-available candidates for this hour (best/"Choose
    // First" ranked members first) - the Substitutes Needed card's assign
    // dropdown lists these ahead of everyone else so the best-fit floater
    // is the top suggestion, while still allowing an admin to pick anyone.
    const suggestedFloaters = rankSort(floaterPool.filter((m) => !usedThisHour.has(m.id)));

    result.push({ position: hourPosition, label: hourGroup.label, slots, suggestedFloaters });
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

// Single-date "Floater Assignment Dashboard" cards (the Chart tab's view,
// and the Archive tab's popup/print record for a date that's passed) -
// same permanent-job/substitute_assignments data as jobAssignmentGrid,
// just reshaped for one date's cards instead of a multi-date table (each
// job gets one `assigned` directly, not a one-element `cells` array).
async function dailyAssignmentCards(day, date) {
  return (await jobAssignmentGrid(day, [date])).map((hour) => ({
    position: hour.position,
    jobs: hour.jobs.map((job) => ({ id: job.id, title: job.title, room: job.room, assigned: job.cells[0].assigned })),
  }));
}

// dailyAssignmentCards with each hour's real label merged in - shared by
// the Archive tab/print page and the public kiosk view
// (partials/floater-assignment-cards.ejs needs `label` on every hour).
async function dailyAssignmentCardsWithLabels(day, date) {
  const hourLabelByPosition = {};
  (await hoursForDay(day)).forEach((h) => { hourLabelByPosition[h.position] = h.label; });
  return (await dailyAssignmentCards(day, date)).map((hour) => ({ ...hour, label: hourLabelByPosition[hour.position] || `Hour ${hour.position}` }));
}

// Archive tab: one row per date that's already passed, with how many of
// that day's permanent-job positions ended up with an approved floater -
// same underlying data as dailyAssignmentCards, just counted instead of
// rendered, for the log list before an admin opens one date's full record.
async function archivedDateSummaries(day, dates) {
  const jobs = await permanentJobsForDay(day);
  const result = [];
  for (const date of dates) {
    let assignedCount = 0;
    for (const j of jobs) {
      const a = await assignmentFor(date, 'job', j.id);
      if (a && a.status === 'approved') assignedCount++;
    }
    result.push({ date, totalPositions: jobs.length, assignedCount });
  }
  return result;
}

// Auto-fills (see substituteBoard) and collects every slot left in
// 'pending' status for today across both days - the source for the
// sitewide "needs approval" popup on the admin portal. Scoped to today
// since that's the only date the portal can proactively check without a
// background scheduler; anything for a future date surfaces once that
// date's Substitutes board is actually viewed. Only checks a day whose
// weekday actually matches today - otherwise "today" isn't a real
// session for that list and permanent jobs would get auto-filled
// against a date that was never one of their sessions.
async function pendingApprovalsForToday() {
  const date = todayISO();
  const items = [];
  for (const day of DAYS.filter((day) => weekdayOf(date) === DAY_WEEKDAY[day])) {
    const board = await substituteBoard(day, date);
    board.forEach((hour) => {
      hour.slots.forEach((slot) => {
        if (slot.assigned && slot.assigned.status === 'pending') {
          items.push({
            day,
            dayLabel: DAY_LABELS[day],
            date,
            hourLabel: hour.label,
            slotLabel: slot.label,
            memberName: slot.assigned.name,
          });
        }
      });
    });
  }
  return { count: items.length, items, date };
}

module.exports = {
  HOUR_POSITIONS,
  permanentJobsForDay,
  groupedPermanentJobsForDay,
  savePositionGroup,
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
  substituteBoard,
  jobAssignmentGrid,
  dailyAssignmentCards,
  dailyAssignmentCardsWithLabels,
  archivedDateSummaries,
  pendingApprovalsForToday,
};
