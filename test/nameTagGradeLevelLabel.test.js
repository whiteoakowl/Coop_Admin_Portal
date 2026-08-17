// Coverage for a real request: a student's grade_level ("1st".."12th",
// or a named early-childhood level like Kindergarten/PreK - see utils/
// classSchedule.js's own GRADE_LEVELS) reads ambiguously alone on a badge
// ("3rd" - third grade? third place?). gradeLevelLabel (utils/
// nameTagData.js) pairs it with the word "Grade", and a follow-up request
// asked for that pairing to STACK ("3rd" over "Grade") rather than run on
// one line - returned as a 2-line array for the ordinal case (name-tag-
// render-core.js's renderTextEl treats an array as one stacked line per
// entry), left as a single unstacked string for the named early-childhood
// levels (which already read fine on their own, and "Kindergarten"/"Grade"
// stacked wouldn't make sense).
const test = require('node:test');
const assert = require('node:assert/strict');
const { gradeLevelLabel } = require('../utils/nameTagData');

test('gradeLevelLabel returns ["<ordinal>", "Grade"] for an ordinal grade, ready to stack', () => {
  assert.deepEqual(gradeLevelLabel('1st'), ['1st', 'Grade']);
  assert.deepEqual(gradeLevelLabel('3rd'), ['3rd', 'Grade']);
  assert.deepEqual(gradeLevelLabel('12th'), ['12th', 'Grade']);
});

test('gradeLevelLabel leaves a named early-childhood level as a plain unstacked string', () => {
  assert.equal(gradeLevelLabel('Kindergarten'), 'Kindergarten');
  assert.equal(gradeLevelLabel('PreK'), 'PreK');
  assert.equal(gradeLevelLabel('Preschool'), 'Preschool');
  assert.equal(gradeLevelLabel('Toddler'), 'Toddler');
  assert.equal(gradeLevelLabel('Infant'), 'Infant');
});

test('gradeLevelLabel returns an empty string for a member with no grade_level set, not ["undefined", "Grade"]', () => {
  assert.equal(gradeLevelLabel(''), '');
  assert.equal(gradeLevelLabel(null), '');
  assert.equal(gradeLevelLabel(undefined), '');
});

test('gradeLevelLabel is idempotent-safe for a value that already has a trailing "Grade" (e.g. stray legacy data), left untouched rather than doubled', () => {
  assert.equal(gradeLevelLabel('3rd Grade'), '3rd Grade', 'no ordinal suffix directly before "Grade" so the regex should not match, leaving it as-is');
});
