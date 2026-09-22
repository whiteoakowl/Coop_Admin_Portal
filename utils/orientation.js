// Co-op Admin's own Orientation tracker - a real request: "Add an
// orientation tab. List of members registered for classes on either day.
// Columns, member name, day Monday/Wednesday, orientation video,
// orientation meet up, teacher training and tour... check in for the
// tour, check in for orientation meet up, complete the parent
// orientation video and teacher orientation video." Orientation/tour/
// teacher training is a FAMILY-level obligation (the tour and orientation
// meetup are things a parent attends, the two videos are a parent's own
// and a teacher's own training), not a per-student one - so a family
// with two students enrolled in the same day's classes shows up once for
// that day, not twice. Reuses primaryParentsFor (utils/scheduleCardData.js)
// for "whose obligation is this" the exact same way Schedule Cards
// already do, including "admins count as parents" (a real request from
// earlier this same feature area).
const db = require('../db');
const { primaryParentsFor } = require('./scheduleCardData');

// A real request: "add a column for open house" - same shape as the 4
// original circle columns (openHouse -> open_house_complete/
// open_house_completed_at, see the orientation_open_house migration).
const FIELDS = ['video', 'meetup', 'teacherTraining', 'tour', 'openHouse'];
const COLUMN_PREFIX = { video: 'video', meetup: 'meetup', teacherTraining: 'teacher_training', tour: 'tour', openHouse: 'open_house' };

// Every (primary parent, day) pair that has at least one enrolled,
// active student in a class on that day, joined to whatever progress
// already exists (a pair with no orientation_progress row yet just reads
// as all-incomplete - the row is only actually created on the first
// toggle/check-in, same lazy-upsert shape utils/classSchedule.js's own
// updateClassSettings assumes for a brand new class).
async function orientationRows() {
  const enrolled = await db
    .prepare(
      `SELECT DISTINCT ce.student_id, c.day
       FROM class_enrollments ce
       JOIN classes c ON c.id = ce.class_id
       JOIN members student ON student.id = ce.student_id
       WHERE student.active = 1`
    )
    .all();
  if (enrolled.length === 0) return [];

  const studentIds = [...new Set(enrolled.map((e) => e.student_id))];
  const students = await db.prepare(`SELECT * FROM members WHERE id IN (${studentIds.map(() => '?').join(',')})`).all(...studentIds);
  const parentByStudent = await primaryParentsFor(students);

  const byKey = new Map();
  for (const e of enrolled) {
    const parent = parentByStudent[e.student_id];
    if (!parent) continue; // no parent on file for this family - nothing to track an obligation against
    const key = `${parent.id}:${e.day}`;
    if (!byKey.has(key)) byKey.set(key, { memberId: parent.id, memberName: parent.name, day: e.day });
  }
  const pairs = [...byKey.values()];
  if (pairs.length === 0) return [];

  const progressRows = await db.prepare('SELECT * FROM orientation_progress').all();
  const progressByKey = new Map(progressRows.map((r) => [`${r.member_id}:${r.day}`, r]));

  return pairs
    .map((pair) => {
      const progress = progressByKey.get(`${pair.memberId}:${pair.day}`) || {};
      const flags = {
        video: Number(progress.video_complete) === 1,
        meetup: Number(progress.meetup_complete) === 1,
        teacherTraining: Number(progress.teacher_training_complete) === 1,
        tour: Number(progress.tour_complete) === 1,
        openHouse: Number(progress.open_house_complete) === 1,
      };
      const doneCount = Object.values(flags).filter(Boolean).length;
      return {
        memberId: pair.memberId,
        memberName: pair.memberName,
        day: pair.day,
        ...flags,
        percentComplete: Math.round((doneCount / FIELDS.length) * 100),
      };
    })
    .sort((a, b) => a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' }) || a.day.localeCompare(b.day));
}

// Toggles one of the 4 circles for one (member, day) pair - `field` is
// checked against FIELDS first so this never interpolates a column name
// straight from a request body, same defensive shape utils/
// classSchedule.js's own updateClassSettings/CLASS_SETTINGS_FIELDS uses.
async function setOrientationField(memberId, day, field, value) {
  if (!FIELDS.includes(field)) throw new Error(`Unknown orientation field: ${field}`);
  if (day !== 'monday' && day !== 'wednesday') throw new Error(`Unknown orientation day: ${day}`);
  const prefix = COLUMN_PREFIX[field];
  const completeCol = `${prefix}_complete`;
  const atCol = `${prefix}_completed_at`;
  const atExpr = value ? 'now_text()' : 'NULL';
  await db
    .prepare(
      `INSERT INTO orientation_progress (member_id, day, ${completeCol}, ${atCol})
       VALUES (?, ?, ?, ${atExpr})
       ON CONFLICT (member_id, day) DO UPDATE SET ${completeCol} = ?, ${atCol} = ${atExpr}`
    )
    .run(memberId, day, value ? 1 : 0, value ? 1 : 0);
}

module.exports = { FIELDS, orientationRows, setOrientationField };
