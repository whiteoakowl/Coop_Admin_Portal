// Coverage for a real request: a student's grade_level ("1st".."12th",
// or a named early-childhood level like Kindergarten/PreK - see utils/
// classSchedule.js's own GRADE_LEVELS) reads ambiguously alone on a badge
// ("3rd" - third grade? third place?). gradeLevelLabel (utils/
// nameTagData.js) appends "Grade" to just the ordinal-numbered ones,
// leaving the named levels (which already read fine on their own) alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { gradeLevelLabel } = require('../utils/nameTagData');

test('gradeLevelLabel appends "Grade" to an ordinal grade', () => {
  assert.equal(gradeLevelLabel('1st'), '1st Grade');
  assert.equal(gradeLevelLabel('3rd'), '3rd Grade');
  assert.equal(gradeLevelLabel('12th'), '12th Grade');
});

test('gradeLevelLabel leaves a named early-childhood level unchanged', () => {
  assert.equal(gradeLevelLabel('Kindergarten'), 'Kindergarten');
  assert.equal(gradeLevelLabel('PreK'), 'PreK');
  assert.equal(gradeLevelLabel('Preschool'), 'Preschool');
  assert.equal(gradeLevelLabel('Toddler'), 'Toddler');
  assert.equal(gradeLevelLabel('Infant'), 'Infant');
});

test('gradeLevelLabel returns an empty string for a member with no grade_level set, not "undefined Grade"', () => {
  assert.equal(gradeLevelLabel(''), '');
  assert.equal(gradeLevelLabel(null), '');
  assert.equal(gradeLevelLabel(undefined), '');
});

test('gradeLevelLabel is idempotent-safe for a value that already has a trailing "Grade" (e.g. stray legacy data), left untouched rather than doubled', () => {
  assert.equal(gradeLevelLabel('3rd Grade'), '3rd Grade', 'no ordinal suffix directly before "Grade" so the regex should not match, leaving it as-is');
});
