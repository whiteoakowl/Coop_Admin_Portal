// Settings behind Main Admin > Members > Settings > Grade Level Settings
// sub-tab - a real request: "Here is a list of graded levels. Next to
// each grade level is a date picker and another column for age... Each
// row will say, if student is (age), by (date/calendar picker), then
// they will be in (grade level)." Stored the same small generic key/
// value way utils/membershipHandbook.js already does (one JSON blob
// under appSetting/setAppSetting), not a dedicated table.
//
// A real follow-up request: "Grade level settings under members should
// set the grade level for all members according to their birthday" -
// applyGradeLevelRulesToMembers below is what actually DOES that (an
// explicit admin action, not automatic on save - see its own comment).
// The rules themselves stay exactly what they were: an admin-maintained
// reference list, not a live trigger that silently rewrites every
// member's grade_level the moment a row is edited.
const db = require('../db');
const { appSetting, setAppSetting } = require('./appSettings');
const { GRADE_LEVELS } = require('./classSchedule');
const { ageAsOfDate } = require('./dates');

const SETTINGS_KEY = 'grade_level_age_rules';

// Always returns exactly one row per GRADE_LEVELS entry, in that same
// order, so the view can render a clean, stable row list regardless of
// what's been saved so far (an unset row just has null age/cutoffDate).
async function listGradeLevelRules() {
  const raw = await appSetting(SETTINGS_KEY, null);
  let saved = {};
  if (raw) {
    try {
      saved = JSON.parse(raw) || {};
    } catch {
      saved = {};
    }
  }
  return GRADE_LEVELS.map((gradeLevel) => {
    const row = saved[gradeLevel] || {};
    const age = parseInt(row.age, 10);
    return {
      gradeLevel,
      age: Number.isInteger(age) && age >= 0 ? age : null,
      cutoffDate: row.cutoffDate || null,
    };
  });
}

// Full reconcile from the settings form's own parallel gradeLevel[]/age[]/
// cutoffDate[] arrays (one form, one Save button, every row submitted
// together - see routes/main-admin-members.js's own POST handler).
async function saveGradeLevelRules(rows) {
  const toSave = {};
  for (const row of rows) {
    if (!GRADE_LEVELS.includes(row.gradeLevel)) continue;
    const age = parseInt(row.age, 10);
    toSave[row.gradeLevel] = {
      age: Number.isInteger(age) && age >= 0 ? age : null,
      cutoffDate: row.cutoffDate || null,
    };
  }
  await setAppSetting(SETTINGS_KEY, JSON.stringify(toSave));
}

// A real follow-up request: "Grade level settings under members should
// set the grade level for all members according to their birthday" - an
// explicit "Apply to All Members" action (routes/main-admin-members.js's
// own POST /settings/grade-levels/apply), not something that runs
// automatically whenever a rule is saved or a member's birthday changes -
// an admin reviews the result (how many actually changed) rather than
// members silently getting re-graded in the background.
//
// Scoped to student members with a birthday on file - parents/admins
// don't have a grade_level or (per an earlier real request) even a
// birthday field at all, so they're never touched. For each student,
// checks every rule in GRADE_LEVELS order (youngest to oldest) and
// assigns the FIRST one whose own age-as-of-its-own-cutoff-date matches
// that student's actual age-as-of-that-same-date - if an admin leaves
// two rules' own date windows overlapping for the same age, the
// youngest-grade rule wins rather than leaving it to chance.
//
// A real follow-up request: "the grade level settings should
// automatically put all students in a grade level" - an admin rarely
// fills in every one of GRADE_LEVELS' 17 rows, so an exact age match
// above often doesn't exist even for a perfectly ordinary student (their
// age just falls in a gap between two configured rows, or past the
// youngest/oldest one anybody bothered to set). Rather than leaving a
// student like that Ungraded, fall back to the CLOSEST configured rule
// by age difference - ties (equally close on both sides) go to the
// first/youngest one found, same bias as the exact match above. The
// only student this can still never place is one with no birthday on
// file at all (nothing to compute an age from) or when literally no
// rule is configured yet - those are left exactly as they were.
async function applyGradeLevelRulesToMembers() {
  const rules = (await listGradeLevelRules()).filter((r) => r.age != null && r.cutoffDate);
  const students = await db.prepare("SELECT id, birthday, grade_level FROM members WHERE member_type = 'student' AND birthday IS NOT NULL").all();

  let matched = 0;
  let changed = 0;
  for (const student of students) {
    let rule = rules.find((r) => ageAsOfDate(student.birthday, r.cutoffDate) === r.age);
    if (!rule) {
      let bestDiff = Infinity;
      for (const r of rules) {
        const diff = Math.abs(ageAsOfDate(student.birthday, r.cutoffDate) - r.age);
        if (diff < bestDiff) {
          bestDiff = diff;
          rule = r;
        }
      }
    }
    if (!rule) continue;
    matched++;
    if (rule.gradeLevel !== student.grade_level) {
      await db.prepare('UPDATE members SET grade_level = ? WHERE id = ?').run(rule.gradeLevel, student.id);
      changed++;
    }
  }
  return { totalStudents: students.length, matched, changed };
}

module.exports = { listGradeLevelRules, saveGradeLevelRules, applyGradeLevelRulesToMembers };
