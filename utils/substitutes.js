const db = require('../db');
const { HOUR_POSITIONS, gridForDay, absentMemberIdsForDate, absenceFormMemberIdsForDate } = require('./classSchedule');
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
function assignedIsOverdue(existing, date, hourLabel) {
  if (!existing || existing.status !== 'approved') return false;
  if (date !== todayISO()) return false;
  const { startRaw } = splitTimeRange(hourLabel);
  const startMin = parseClockMinutes(startRaw);
  if (startMin === null) return false;
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < startMin + 5) return false;
  const checkedIn = db
    .prepare(`SELECT 1 FROM attendance WHERE member_id = ? AND session_date = ? AND check_in_time IS NOT NULL LIMIT 1`)
    .get(existing.member_id, date);
  return !checkedIn;
}

function permanentJobsForDay(day) {
  return db.prepare('SELECT * FROM permanent_jobs WHERE day = ? ORDER BY hour_position, title COLLATE NOCASE').all(day);
}

function getPermanentJob(id) {
  return db.prepare('SELECT * FROM permanent_jobs WHERE id = ?').get(id);
}

function floaterIdsForJob(jobId) {
  return db.prepare('SELECT member_id FROM permanent_job_floaters WHERE job_id = ?').all(jobId).map((r) => r.member_id);
}

function createPermanentJob(fields) {
  const info = db
    .prepare('INSERT INTO permanent_jobs (day, hour_position, title, room) VALUES (?, ?, ?, ?)')
    .run(fields.day, fields.hourPosition, fields.title, fields.room || null);
  return info.lastInsertRowid;
}

function updatePermanentJob(id, fields) {
  db.prepare('UPDATE permanent_jobs SET hour_position = ?, title = ?, room = ? WHERE id = ?').run(
    fields.hourPosition,
    fields.title,
    fields.room || null,
    id
  );
}

function deletePermanentJob(id) {
  db.prepare("DELETE FROM substitute_assignments WHERE slot_type = 'job' AND slot_id = ?").run(id);
  db.prepare('DELETE FROM permanent_jobs WHERE id = ?').run(id);
}

function setJobFloaters(jobId, memberIds) {
  db.prepare('DELETE FROM permanent_job_floaters WHERE job_id = ?').run(jobId);
  const link = db.prepare('INSERT OR IGNORE INTO permanent_job_floaters (job_id, member_id) VALUES (?, ?)');
  for (const memberId of memberIds) link.run(jobId, memberId);
}

function rankSort(members) {
  return [...members].sort((a, b) => (RANK_ORDER[a.rank] ?? 1) - (RANK_ORDER[b.rank] ?? 1));
}

// Everyone on the day's Floater Assignments list for a given hour block,
// ranked (Choose First before Sometimes before Backup Only) - the pool
// substitute suggestions are drawn from, best candidate first. Hour
// positions line up 1-4 across both features by convention. Reads each
// member's rank for THIS specific hour (membersForSection), not a
// single member-wide rank, since Floater Teams now lets rank vary hour
// to hour.
function floaterMembersForHour(day, hourPosition) {
  const list = getListByDay(day);
  if (!list) return [];
  const section = sectionsForList(list.id).find((s) => s.position === hourPosition);
  if (!section) return [];
  return rankSort(membersForSection(list.id, section.id));
}

function assignmentFor(date, slotType, slotId) {
  if (!date) return null;
  return db.prepare('SELECT * FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(date, slotType, slotId);
}

function memberName(memberId) {
  const row = db.prepare('SELECT name FROM members WHERE id = ?').get(memberId);
  return row ? row.name : null;
}

// An admin actively choosing someone (accepting a pending pick as-is,
// or overriding with someone else entirely) is always the final word -
// always lands as 'approved', whether or not a pending row already
// existed for this slot.
function setAssignment(date, slotType, slotId, memberId, isOverride) {
  db.prepare(
    `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status)
     VALUES (?, ?, ?, ?, ?, 'approved')
     ON CONFLICT(session_date, slot_type, slot_id) DO UPDATE SET member_id = excluded.member_id, is_override = excluded.is_override, status = 'approved'`
  ).run(date, slotType, slotId, memberId, isOverride ? 1 : 0);
}

// The automated sub system's own pick - only written when nothing exists
// yet for this slot, so it never clobbers an admin's approved choice (or
// someone else's still-pending pick from a moment ago).
function autoAssign(date, slotType, slotId, memberId) {
  db.prepare(
    `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override, status)
     VALUES (?, ?, ?, ?, 0, 'pending')
     ON CONFLICT(session_date, slot_type, slot_id) DO NOTHING`
  ).run(date, slotType, slotId, memberId);
}

// Admin confirms the automated pick without changing who it is.
function approveAssignment(date, slotType, slotId) {
  db.prepare(
    `UPDATE substitute_assignments SET status = 'approved' WHERE session_date = ? AND slot_type = ? AND slot_id = ? AND status = 'pending'`
  ).run(date, slotType, slotId);
}

function clearAssignment(date, slotType, slotId) {
  db.prepare('DELETE FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').run(date, slotType, slotId);
}

function assignedInfo(existing) {
  if (!existing) return null;
  return {
    id: existing.member_id,
    name: memberName(existing.member_id),
    isOverride: !!existing.is_override,
    status: existing.status,
    infant: hasInfantChild(existing.member_id),
    updatedLabel: formatTimestamp(existing.created_at),
  };
}

// The full "needs a substitute" board for a day, optionally scoped to a
// specific date (no date = no absence data yet, so classes never need a
// sub but permanent jobs still show since they need someone every
// session). Each hour lists its slots - a class whose only/all teachers
// are absent, or a permanent job. Any slot with no existing assignment
// yet and an available candidate gets one auto-picked right here (best
// rank first, preferring a job's own preferred-floater list) and
// persisted as 'pending', so approving it is a one-click confirm instead
// of a fresh choice every time the board is viewed.
function substituteBoard(day, date) {
  const absentIds = date ? absentMemberIdsForDate(date) : new Set();
  const formExcludedIds = date ? absenceFormMemberIdsForDate(date) : new Set();
  const grid = gridForDay(day);
  const jobs = permanentJobsForDay(day);
  const jobsByHour = {};
  jobs.forEach((j) => {
    if (!jobsByHour[j.hour_position]) jobsByHour[j.hour_position] = [];
    jobsByHour[j.hour_position].push(j);
  });

  return grid.map((hourGroup) => {
    const hourPosition = hourGroup.position;
    const floaterPool = floaterMembersForHour(day, hourPosition).filter((m) => !absentIds.has(m.id) && !formExcludedIds.has(m.id));
    const usedThisHour = new Set();
    const slots = [];

    function pickCandidate(preferredIds) {
      const preferred = rankSort(
        (preferredIds || []).map((id) => floaterPool.find((m) => m.id === id)).filter((m) => m && !usedThisHour.has(m.id))
      );
      if (preferred.length > 0) return preferred[0];
      return floaterPool.find((m) => !usedThisHour.has(m.id)) || null;
    }

    function resolveSlot(slotType, slotId, preferredIds) {
      let existing = assignmentFor(date, slotType, slotId);
      if (!existing && date) {
        const candidate = pickCandidate(preferredIds);
        if (candidate) {
          autoAssign(date, slotType, slotId, candidate.id);
          existing = assignmentFor(date, slotType, slotId);
        }
      }
      if (existing) usedThisHour.add(existing.member_id);
      return existing;
    }

    hourGroup.classes.forEach((cls) => {
      const teachers = cls.staff.filter((s) => s.role === 'teacher');
      if (teachers.length === 0) return;
      const allAbsent = teachers.every((t) => absentIds.has(t.id));
      if (!allAbsent) return;

      const existing = resolveSlot('class', cls.id, null);

      slots.push({
        slotType: 'class',
        slotId: cls.id,
        label: cls.class_name,
        detail: cls.room ? `Room ${cls.room}` : '',
        ageGroup: cls.age_group || '',
        reason: `Teacher${teachers.length > 1 ? 's' : ''} absent: ${teachers.map((t) => t.name).join(', ')}`,
        assigned: assignedInfo(existing),
        overdue: assignedIsOverdue(existing, date, hourGroup.label),
      });
    });

    (jobsByHour[hourPosition] || []).forEach((job) => {
      const existing = resolveSlot('job', job.id, floaterIdsForJob(job.id));

      slots.push({
        overdue: assignedIsOverdue(existing, date, hourGroup.label),
        slotType: 'job',
        slotId: job.id,
        label: job.title,
        room: job.room || '',
        detail: 'Permanent Job',
        reason: 'Staffed every session',
        assigned: assignedInfo(existing),
      });
    });

    // Ranked, still-available candidates for this hour (best/"Choose
    // First" ranked members first) - the Substitutes Needed card's assign
    // dropdown lists these ahead of everyone else so the best-fit floater
    // is the top suggestion, while still allowing an admin to pick anyone.
    const suggestedFloaters = rankSort(floaterPool.filter((m) => !usedThisHour.has(m.id)));

    return { position: hourPosition, label: hourGroup.label, slots, suggestedFloaters };
  });
}

// Multi-date planning grid for the Monday/Wednesday Floater Assignments
// tab: every permanent job, grouped by hour, with one assigned-member
// column per session date - the forward-planning counterpart to
// substituteBoard's single-date "who needs a sub today" view. Both read
// the same substitute_assignments table (setAssignment/assignmentFor), so
// assigning someone here is exactly the same action as approving a
// substitute - there's only one "who's covering this slot" system,
// whether it's being planned weeks ahead or filled last-minute.
function jobAssignmentGrid(day, dates) {
  const jobs = permanentJobsForDay(day);
  const byHour = {};
  jobs.forEach((j) => {
    if (!byHour[j.hour_position]) byHour[j.hour_position] = [];
    byHour[j.hour_position].push(j);
  });
  return HOUR_POSITIONS.map((hourPosition) => ({
    position: hourPosition,
    jobs: (byHour[hourPosition] || []).map((job) => ({
      id: job.id,
      title: job.title,
      room: job.room || '',
      cells: dates.map((date) => ({
        date,
        assigned: assignedInfo(assignmentFor(date, 'job', job.id)),
      })),
    })),
  })).filter((h) => h.jobs.length > 0);
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
function pendingApprovalsForToday() {
  const date = todayISO();
  const items = [];
  DAYS.filter((day) => weekdayOf(date) === DAY_WEEKDAY[day]).forEach((day) => {
    const board = substituteBoard(day, date);
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
  });
  return { count: items.length, items, date };
}

module.exports = {
  HOUR_POSITIONS,
  permanentJobsForDay,
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
  pendingApprovalsForToday,
};
