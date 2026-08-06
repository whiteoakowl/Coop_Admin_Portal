// Shared constants for the public Membership Form - the fixed grade list
// for each child, and the fixed volunteer-interest checkbox set. Kept
// server-side too so submitted values can be validated against a known
// list rather than trusted as free text.
const GRADE_OPTIONS = [
  'Pre-K',
  'Kindergarten',
  '1st Grade',
  '2nd Grade',
  '3rd Grade',
  '4th Grade',
  '5th Grade',
  '6th Grade',
  '7th Grade',
  '8th Grade',
  '9th Grade',
  '10th Grade',
  '11th Grade',
  '12th Grade',
];

const VOLUNTEER_INTEREST_OPTIONS = [
  'Field Trips',
  'Parties / Events',
  'Teen Hangouts',
  'Tween Hangouts',
  'Fundraisers',
  'Dances',
  'Community Service',
  'Coding / Software Development',
  'Accounting / Finances',
  'Forest Wildings',
  'Co-op Classes',
  'Yearbook',
];

module.exports = { GRADE_OPTIONS, VOLUNTEER_INTEREST_OPTIONS };
