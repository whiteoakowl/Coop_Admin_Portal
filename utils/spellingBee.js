// Student Portal > Spelling Bee - a real request: "vocabulary words for
// every grade level. grade level on students member profile determines
// their vocabulary level for the spelling game." members.grade_level is
// free text written by two different flows with two different
// vocabularies (Main Admin/Membership Form use "5th", "PreK", etc. -
// utils/classSchedule.js's own GRADE_LEVELS; parent self-registration
// uses "5th Grade", "Pre-K", etc. - utils/membership.js's own
// GRADE_OPTIONS), so normalizeGradeLevel() below has to tolerate both
// rather than matching one exact string list.
const db = require('../db');

const ELEMENTARY_WORDS = [
  { word: 'because', clue: 'For the reason that.' },
  { word: 'friend', clue: 'A person you like and trust.' },
  { word: 'believe', clue: 'To feel sure that something is true.' },
  { word: 'though', clue: 'Despite the fact that.' },
  { word: 'could', clue: 'Past tense of "can."' },
  { word: 'again', clue: 'One more time.' },
  { word: 'people', clue: 'Human beings, in general.' },
  { word: 'little', clue: 'Small in size or amount.' },
  { word: 'right', clue: 'Correct, or the opposite of left.' },
  { word: 'thought', clue: 'An idea or opinion; past tense of "think."' },
  { word: 'every', clue: 'Used to refer to all members of a group.' },
  { word: 'first', clue: 'Coming before all others in order.' },
  { word: 'beautiful', clue: 'Very pleasing to look at.' },
  { word: 'through', clue: 'Moving in one side and out the other.' },
  { word: 'answer', clue: 'A reply to a question.' },
];

const MIDDLE_WORDS = [
  { word: 'definitely', clue: 'Without doubt; certainly.' },
  { word: 'separate', clue: 'Set apart from something else.' },
  { word: 'necessary', clue: 'Required to be done; essential.' },
  { word: 'occurred', clue: 'Happened; took place.' },
  { word: 'embarrass', clue: 'To cause someone to feel awkward or ashamed.' },
  { word: 'rhythm', clue: 'A strong, regular repeated pattern of sound.' },
  { word: 'calendar', clue: 'A chart showing the days, weeks, and months of a year.' },
  { word: 'government', clue: 'The group of people who run a country or state.' },
  { word: 'immediately', clue: 'Happening right away, with no delay.' },
  { word: 'particular', clue: 'Specific, or relating to one thing in particular.' },
  { word: 'environment', clue: 'The natural world around us.' },
  { word: 'receive', clue: 'To be given or get something.' },
  { word: 'familiar', clue: 'Well known to you; easily recognized.' },
  { word: 'tomorrow', clue: 'The day after today.' },
  { word: 'acquire', clue: 'To get or obtain something.' },
];

const HIGH_WORDS = [
  { word: 'conscientious', clue: 'Wishing to do what is right; careful and thorough.' },
  { word: 'questionnaire', clue: 'A set of printed questions used to gather information.' },
  { word: 'entrepreneur', clue: 'A person who starts and runs a business.' },
  { word: 'bureaucracy', clue: 'A system of government with many departments and officials.' },
  { word: 'millennium', clue: 'A period of one thousand years.' },
  { word: 'maintenance', clue: 'The process of keeping something in good condition.' },
  { word: 'unnecessary', clue: 'Not needed; not required.' },
  { word: 'liaison', clue: 'A person who helps different groups communicate with each other.' },
  { word: 'connoisseur', clue: 'An expert judge in matters of taste.' },
  { word: 'pharaoh', clue: 'A ruler of ancient Egypt.' },
  { word: 'silhouette', clue: 'The dark outline of someone or something against a lighter background.' },
  { word: 'camaraderie', clue: 'Mutual trust and friendship among people in a group.' },
  { word: 'hierarchy', clue: 'A system in which people are ranked one above another.' },
  { word: 'threshold', clue: 'A point of entry, or the level at which something begins.' },
  { word: 'vacuum', clue: 'A space completely empty of matter.' },
];

const LEVEL_WORDS = { elementary: ELEMENTARY_WORDS, middle: MIDDLE_WORDS, high: HIGH_WORDS };
const LEVEL_LABELS = { elementary: 'Elementary', middle: 'Middle School', high: 'High School' };

// Handles both vocabularies members.grade_level can hold - see this
// file's own header comment. Returns a number 0-12 (0 = any
// pre-elementary stage: Infant/Toddler/Preschool/PreK/Kindergarten), or
// null if unrecognized/unset.
function normalizeGradeLevel(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/\s*grade$/i, '').trim();
  const lower = s.toLowerCase().replace(/^pre-k$/i, 'prek');
  const numMatch = lower.match(/^(\d{1,2})(st|nd|rd|th)?$/);
  if (numMatch) return Math.min(12, parseInt(numMatch[1], 10));
  if (['infant', 'toddler', 'preschool', 'prek', 'kindergarten'].includes(lower)) return 0;
  return null;
}

function levelForGrade(grade) {
  if (grade === null || grade <= 5) return 'elementary';
  if (grade <= 8) return 'middle';
  return 'high';
}

// No grade on file defaults to 'elementary' - the most broadly
// accessible word list, safer than guessing older.
function levelForMember(member) {
  return levelForGrade(normalizeGradeLevel(member && member.grade_level));
}

function wordsForLevel(level) {
  return LEVEL_WORDS[level] || LEVEL_WORDS.elementary;
}

async function logRound(memberId, correctCount, roundTotal, level) {
  await db
    .prepare('INSERT INTO spelling_scores (member_id, correct_count, round_total, level) VALUES (?, ?, ?, ?)')
    .run(memberId, correctCount, roundTotal, level);
}

// "top 5 highest spelling bee points" - lifetime total correct words
// across every round, same cumulative-total shape as Games Played.
async function topPlayers(limit = 5) {
  const rows = await db
    .prepare(
      `SELECT m.id AS member_id, m.name, SUM(s.correct_count) AS points
       FROM members m JOIN spelling_scores s ON s.member_id = m.id
       WHERE m.member_type = 'student' AND m.active = 1
       GROUP BY m.id, m.name
       ORDER BY points DESC
       LIMIT ?`
    )
    .all(limit);
  return rows.map((row, index) => ({ rank: index + 1, memberId: row.member_id, name: row.name, points: Number(row.points) }));
}

module.exports = {
  LEVEL_LABELS,
  normalizeGradeLevel,
  levelForGrade,
  levelForMember,
  wordsForLevel,
  logRound,
  topPlayers,
};
