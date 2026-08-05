const db = require('../db');
const { HOUR_POSITIONS, gridForDay, absentMemberIdsForDate } = require('./classSchedule');
const { getListByDay, sectionsForList, membersForList } = require('./volunteers');

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
    .prepare('INSERT INTO permanent_jobs (day, hour_position, title) VALUES (?, ?, ?)')
    .run(fields.day, fields.hourPosition, fields.title);
  return info.lastInsertRowid;
}

function updatePermanentJob(id, fields) {
  db.prepare('UPDATE permanent_jobs SET hour_position = ?, title = ? WHERE id = ?').run(fields.hourPosition, fields.title, id);
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

// Everyone on the day's Floater Assignments list for a given hour block -
// the pool substitute suggestions are drawn from. Hour positions line up
// 1-4 across both features by convention.
function floaterMembersForHour(day, hourPosition) {
  const list = getListByDay(day);
  if (!list) return [];
  const section = sectionsForList(list.id).find((s) => s.position === hourPosition);
  if (!section) return [];
  return membersForList(list.id).filter((m) => m.sectionIds.includes(section.id));
}

function assignmentFor(date, slotType, slotId) {
  if (!date) return null;
  return db.prepare('SELECT * FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').get(date, slotType, slotId);
}

function memberName(memberId) {
  const row = db.prepare('SELECT name FROM members WHERE id = ?').get(memberId);
  return row ? row.name : null;
}

function setAssignment(date, slotType, slotId, memberId, isOverride) {
  db.prepare(
    `INSERT INTO substitute_assignments (session_date, slot_type, slot_id, member_id, is_override)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_date, slot_type, slot_id) DO UPDATE SET member_id = excluded.member_id, is_override = excluded.is_override`
  ).run(date, slotType, slotId, memberId, isOverride ? 1 : 0);
}

function clearAssignment(date, slotType, slotId) {
  db.prepare('DELETE FROM substitute_assignments WHERE session_date = ? AND slot_type = ? AND slot_id = ?').run(date, slotType, slotId);
}

// The full "needs a substitute" board for a day, optionally scoped to a
// specific date (no date = no absence data yet, so classes never need a
// sub but permanent jobs still show since they need someone every
// session). Each hour lists its slots - a class whose only/all teachers
// are absent, or a permanent job - each carrying a computed suggestion
// (first available floater for that hour, preferring a job's own
// preferred-floater list) plus the full floater pool as alternates, and
// whatever's actually been assigned for that date, if anything.
function substituteBoard(day, date) {
  const absentIds = date ? absentMemberIdsForDate(date) : new Set();
  const grid = gridForDay(day);
  const jobs = permanentJobsForDay(day);
  const jobsByHour = {};
  jobs.forEach((j) => {
    if (!jobsByHour[j.hour_position]) jobsByHour[j.hour_position] = [];
    jobsByHour[j.hour_position].push(j);
  });

  return grid.map((hourGroup) => {
    const hourPosition = hourGroup.position;
    const floaterPool = floaterMembersForHour(day, hourPosition).filter((m) => !absentIds.has(m.id));
    const usedThisHour = new Set();
    const slots = [];

    // Assigned members occupy their spot first, so they're never
    // suggested for a second slot in the same hour.
    function reserveExisting(slotType, slotId) {
      const existing = assignmentFor(date, slotType, slotId);
      if (existing) usedThisHour.add(existing.member_id);
      return existing;
    }

    function pickSuggestion(preferredIds) {
      const preferred = (preferredIds || [])
        .map((id) => floaterPool.find((m) => m.id === id))
        .filter((m) => m && !usedThisHour.has(m.id));
      if (preferred.length > 0) return preferred[0];
      const fallback = floaterPool.find((m) => !usedThisHour.has(m.id));
      return fallback || null;
    }

    hourGroup.classes.forEach((cls) => {
      const teachers = cls.staff.filter((s) => s.role === 'teacher');
      if (teachers.length === 0) return;
      const allAbsent = teachers.every((t) => absentIds.has(t.id));
      if (!allAbsent) return;

      const existing = reserveExisting('class', cls.id);
      const suggestion = existing ? null : pickSuggestion(null);
      if (suggestion) usedThisHour.add(suggestion.id);

      slots.push({
        slotType: 'class',
        slotId: cls.id,
        label: cls.class_name,
        detail: cls.room ? `Room ${cls.room}` : '',
        reason: `Teacher${teachers.length > 1 ? 's' : ''} absent: ${teachers.map((t) => t.name).join(', ')}`,
        suggestion,
        assigned: existing ? { id: existing.member_id, name: memberName(existing.member_id), isOverride: !!existing.is_override } : null,
      });
    });

    (jobsByHour[hourPosition] || []).forEach((job) => {
      const existing = reserveExisting('job', job.id);
      const suggestion = existing ? null : pickSuggestion(floaterIdsForJob(job.id));
      if (suggestion) usedThisHour.add(suggestion.id);

      slots.push({
        slotType: 'job',
        slotId: job.id,
        label: job.title,
        detail: 'Permanent Job',
        reason: 'Staffed every session',
        suggestion,
        assigned: existing ? { id: existing.member_id, name: memberName(existing.member_id), isOverride: !!existing.is_override } : null,
      });
    });

    return { position: hourPosition, label: hourGroup.label, slots };
  });
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
  clearAssignment,
  substituteBoard,
};
