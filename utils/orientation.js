// Co-op Admin's own Orientation tracker - a real request: "Add an
// orientation tab. List of members registered for classes on either day.
// Columns, member name, day Monday/Wednesday, orientation video,
// orientation meet up, teacher training and tour... check in for the
// tour, check in for orientation meet up, complete the parent
// orientation video and teacher orientation video." Orientation/tour/
// teacher training is a FAMILY-level obligation (the tour and orientation
// meetup are things a parent attends, the two videos are a parent's own
// and a teacher's own training), not a per-student one - so a family
// with two students enrolled shows up once, not twice. Reuses
// primaryParentsFor (utils/scheduleCardData.js) for "whose obligation is
// this" the exact same way Schedule Cards already do, including "admins
// count as parents" (a real request from earlier this same feature area).
//
// A later request rebuilt this to be Semester-scoped: "Now each
// orientation semester is created with all members registered for
// classes that semester. Members are only listed once with arrow
// dropdown for children to expand and close. If member is signed up for
// Monday and Wednesday it will show both in the same column." See the
// 20261012010000_orientation_semesters migration's own comment for the
// data-model shift this required (orientation_progress keyed by
// (member, semester) instead of (member, day) - which day(s) a family
// attends is now purely a display value computed live from
// class_enrollments, not something progress itself is keyed by).
const db = require('../db');
const { primaryParentsFor } = require('./scheduleCardData');
const { CLASS_DAY_LABELS_FULL } = require('./classDays');
const { byLastName } = require('./members');

// A real request: "add a column for open house" - same shape as the 4
// original circle columns (openHouse -> open_house_complete/
// open_house_completed_at, see the orientation_open_house migration).
const FIELDS = ['video', 'teacherTraining', 'tour', 'openHouse'];
const COLUMN_PREFIX = { video: 'video', teacherTraining: 'teacher_training', tour: 'tour', openHouse: 'open_house' };

// The most recently created semester - the default view when no
// ?semesterId is given, so the page always opens on a concrete semester
// once any exist rather than the old global/unscoped view.
async function defaultSemesterId() {
  const row = await db.prepare('SELECT id FROM semesters ORDER BY id DESC LIMIT 1').get();
  return row ? row.id : null;
}

// Every primary parent with at least one enrolled, active student in a
// class this semester (semesterId null = every class regardless of
// semester, the fallback view for a co-op that hasn't created any
// semesters yet), joined to whatever progress already exists for that
// (parent, semester) pair - a pair with no orientation_progress row yet
// just reads as all-incomplete, the row is only actually created on the
// first toggle/check-in, same lazy-upsert shape utils/classSchedule.js's
// own updateClassSettings assumes for a brand new class.
async function orientationRows(semesterId) {
  const enrolled = await db
    .prepare(
      `SELECT DISTINCT ce.student_id, c.day
       FROM class_enrollments ce
       JOIN classes c ON c.id = ce.class_id
       JOIN members student ON student.id = ce.student_id
       WHERE student.active = 1 AND (?::int IS NULL OR c.semester_id = ?::int)`
    )
    .all(semesterId || null, semesterId || null);
  if (enrolled.length === 0) return [];

  const studentIds = [...new Set(enrolled.map((e) => e.student_id))];
  const students = await db.prepare(`SELECT * FROM members WHERE id IN (${studentIds.map(() => '?').join(',')})`).all(...studentIds);
  const studentById = new Map(students.map((s) => [s.id, s]));
  const parentByStudent = await primaryParentsFor(students);

  // One entry per primary parent, collecting every day they have a
  // student enrolled and every child (student) driving that obligation -
  // "members are only listed once with arrow dropdown for children to
  // expand and close... if member is signed up for Monday and Wednesday
  // it will show both in the same column."
  const byParent = new Map();
  for (const e of enrolled) {
    const parent = parentByStudent[e.student_id];
    if (!parent) continue; // no parent on file for this family - nothing to track an obligation against
    if (!byParent.has(parent.id)) byParent.set(parent.id, { memberId: parent.id, memberName: parent.name, days: new Set(), children: new Map() });
    const entry = byParent.get(parent.id);
    entry.days.add(e.day);
    const student = studentById.get(e.student_id);
    if (!entry.children.has(e.student_id)) entry.children.set(e.student_id, { id: e.student_id, name: student.name, days: new Set() });
    entry.children.get(e.student_id).days.add(e.day);
  }
  const parents = [...byParent.values()];
  if (parents.length === 0) return [];

  const progressRows = await db
    .prepare('SELECT * FROM orientation_progress WHERE (?::int IS NULL AND semester_id IS NULL) OR semester_id = ?::int')
    .all(semesterId || null, semesterId || null);
  const progressByMember = new Map(progressRows.map((r) => [r.member_id, r]));

  const dayLabelFor = (days) => days.sort().map((d) => CLASS_DAY_LABELS_FULL[d]).join(', ');

  return parents
    .map((entry) => {
      const progress = progressByMember.get(entry.memberId) || {};
      const flags = {
        video: Number(progress.video_complete) === 1,
        teacherTraining: Number(progress.teacher_training_complete) === 1,
        tour: Number(progress.tour_complete) === 1,
        openHouse: Number(progress.open_house_complete) === 1,
      };
      const doneCount = Object.values(flags).filter(Boolean).length;
      // A real request: "Add a column for date completed" - the date
      // orientation became FULLY complete (every circle checked), the
      // latest of the 5 fields' own _completed_at timestamps; blank
      // until all 5 are done, rather than a half-finished date that
      // would read as "done" at a glance.
      const dateCompleted =
        doneCount === FIELDS.length
          ? FIELDS.map((f) => progress[`${COLUMN_PREFIX[f]}_completed_at`])
              .filter(Boolean)
              .sort()
              .slice(-1)[0] || null
          : null;
      return {
        memberId: entry.memberId,
        memberName: entry.memberName,
        dayLabel: dayLabelFor([...entry.days]),
        children: [...entry.children.values()].map((c) => ({ id: c.id, name: c.name, dayLabel: dayLabelFor([...c.days]) })),
        ...flags,
        percentComplete: Math.round((doneCount / FIELDS.length) * 100),
        dateCompleted,
      };
    })
    .sort((a, b) => a.memberName.localeCompare(b.memberName, undefined, { sensitivity: 'base' }));
}

// Toggles one of the 5 circles for one (member, semester) pair - `field`
// is checked against FIELDS first so this never interpolates a column
// name straight from a request body, same defensive shape utils/
// classSchedule.js's own updateClassSettings/CLASS_SETTINGS_FIELDS uses.
async function setOrientationField(memberId, semesterId, field, value) {
  if (!FIELDS.includes(field)) throw new Error(`Unknown orientation field: ${field}`);
  const prefix = COLUMN_PREFIX[field];
  const completeCol = `${prefix}_complete`;
  const atCol = `${prefix}_completed_at`;
  const atExpr = value ? 'now_text()' : 'NULL';
  await db
    .prepare(
      `INSERT INTO orientation_progress (member_id, semester_id, ${completeCol}, ${atCol})
       VALUES (?, ?, ?, ${atExpr})
       ON CONFLICT (member_id, coalesce(semester_id, -1)) DO UPDATE SET ${completeCol} = ?, ${atCol} = ${atExpr}`
    )
    .run(memberId, semesterId || null, value ? 1 : 0, value ? 1 : 0);
}

// --- Orientation Settings: an optional Training link per checkmark
// column - a real request: "Add button for orientation settings to Link
// training... with each circle check mark column so the information can
// be linked", later refined to "the links for the column check boxes
// should be dropdown menus of trainings that have been created" - each
// column's own header links straight to whichever Training module is
// linked to it (no more hand-typed URL option; a column with nothing
// linked just stays a plain label).
async function setOrientationLink(field, trainingId) {
  if (!FIELDS.includes(field)) throw new Error(`Unknown orientation field: ${field}`);
  const tId = trainingId || null;
  if (!tId) {
    await db.prepare('DELETE FROM orientation_settings WHERE field = ?').run(field);
    return;
  }
  await db
    .prepare(
      `INSERT INTO orientation_settings (field, training_id) VALUES (?, ?)
       ON CONFLICT (field) DO UPDATE SET training_id = ?`
    )
    .run(field, tId, tId);

  // A real bug report: "I linked some of the trainings in orientation
  // settings and it is not showing green check marks next to those that
  // completed the trainings." applyTrainingCompletion only ever fires at
  // the moment utils/training.js's own maybeFinalizeAttempt finalizes an
  // attempt as passed - a member who passed the training BEFORE this link
  // existed never got that call, so linking it here must retroactively
  // backfill every member who already has a passed attempt.
  const alreadyPassed = await db.prepare("SELECT DISTINCT member_id FROM training_assignments WHERE training_id = ? AND status = 'passed'").all(tId);
  for (const row of alreadyPassed) {
    await applyTrainingCompletion(tId, row.member_id);
  }
}

async function orientationTrainingLinks() {
  const rows = await db.prepare('SELECT field, training_id FROM orientation_settings WHERE training_id IS NOT NULL').all();
  const byField = {};
  rows.forEach((r) => {
    byField[r.field] = r.training_id;
  });
  return byField;
}

// A real bug report: "primary member signed up from each of the signed up
// families is not showing their green check mark for completing trainings
// that they did." orientationRows() only ever displays progress keyed to
// the family's own primary parent (utils/scheduleCardData.js's own
// primaryParentsFor, the same "whose obligation is this" lookup Schedule
// Cards use) - but a Training can be assigned to and passed by ANY member
// of the family (whoever the admin actually picked when assigning it, or
// whoever logged in and took it), not necessarily that one specific row.
// Resolves any member to the same primary-parent id orientationRows()
// would show for their family, so a passed Training always credits the
// row the admin is actually looking at - same is_primary_parent-first,
// else-first-by-last-name tie-break primaryParentsFor itself uses.
// Returns the member's own id unchanged if they have no family on file, or
// no parent/admin on file in that family (nothing else to redirect to).
async function orientationObligationMemberId(memberId) {
  const self = await db.prepare('SELECT family_id FROM members WHERE id = ?').get(memberId);
  if (!self || self.family_id == null) return memberId;
  const parents = (
    await db.prepare("SELECT * FROM members WHERE family_id = ? AND member_type IN ('parent', 'admin') AND active = 1").all(self.family_id)
  ).sort(byLastName);
  if (parents.length === 0) return memberId;
  const primary = parents.find((p) => p.is_primary_parent) || parents[0];
  return primary.id;
}

// Called from utils/training.js's own maybeFinalizeAttempt right after a
// training attempt is finalized as passed - looks up every orientation
// column linked to this training and marks it complete for that member.
// Training completions aren't semester-scoped the way class enrollment
// is, so "whichever semester Orientation itself currently defaults to"
// (the same most-recently-created-semester fallback every other
// semester-aware view already uses) is the closest sensible target.
async function applyTrainingCompletion(trainingId, memberId) {
  const rows = await db.prepare('SELECT field FROM orientation_settings WHERE training_id = ?').all(trainingId);
  if (rows.length === 0) return;
  const targetMemberId = await orientationObligationMemberId(memberId);
  const semesterId = await defaultSemesterId();
  for (const row of rows) {
    await setOrientationField(targetMemberId, semesterId, row.field, true);
  }
}

module.exports = {
  FIELDS,
  orientationRows,
  setOrientationField,
  defaultSemesterId,
  setOrientationLink,
  orientationTrainingLinks,
  applyTrainingCompletion,
  orientationObligationMemberId,
};
