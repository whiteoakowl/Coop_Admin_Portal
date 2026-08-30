// Student Portal homepage > Word of the Week - a real request: "show a
// word of the week. system generates a new word every sunday. it will
// actually show 3 words. one for elementary level, one for middle
// school level and one for high school level." Pure "compute on read"
// (same philosophy as utils/reading.js/utils/pets.js) - no database row
// to maintain, no cron job to advance it. The word for a given week is
// just `weekIndex() % bank.length`, a stable, deterministic pick that
// only changes at the Sunday boundary and cycles back to the start of
// each list once every bank is exhausted.
const ELEMENTARY = [
  { word: 'Curious', definition: 'Eager to learn or know something.' },
  { word: 'Gigantic', definition: 'Extremely large; huge.' },
  { word: 'Brave', definition: 'Ready to face danger or pain without fear.' },
  { word: 'Sparkle', definition: 'To shine with small flashes of light.' },
  { word: 'Wander', definition: 'To walk around slowly without a fixed direction.' },
  { word: 'Cheerful', definition: 'Feeling or showing happiness.' },
  { word: 'Ancient', definition: 'Very old; from a long time ago.' },
  { word: 'Whisper', definition: 'To speak very softly.' },
  { word: 'Journey', definition: 'A trip from one place to another.' },
  { word: 'Clever', definition: 'Quick to understand, learn, and figure things out.' },
  { word: 'Enormous', definition: 'Very great in size or amount.' },
  { word: 'Grateful', definition: 'Feeling or showing thanks.' },
  { word: 'Mystery', definition: 'Something that is hard to explain or understand.' },
  { word: 'Delight', definition: 'Great pleasure or joy.' },
];

const MIDDLE = [
  { word: 'Resilient', definition: 'Able to recover quickly from difficulties.' },
  { word: 'Meticulous', definition: 'Showing great attention to detail; very careful.' },
  { word: 'Ambiguous', definition: 'Open to more than one interpretation; unclear.' },
  { word: 'Diligent', definition: 'Showing steady, careful effort in work or duties.' },
  { word: 'Empathy', definition: "The ability to understand and share another person's feelings." },
  { word: 'Persevere', definition: 'To continue trying despite difficulty or delay in success.' },
  { word: 'Skeptical', definition: 'Not easily convinced; having doubts.' },
  { word: 'Versatile', definition: 'Able to adapt to many different functions or activities.' },
  { word: 'Candid', definition: 'Truthful and straightforward; frank.' },
  { word: 'Innovate', definition: 'To introduce new ideas, methods, or products.' },
  { word: 'Reluctant', definition: 'Unwilling and hesitant to do something.' },
  { word: 'Substantial', definition: 'Of considerable importance, size, or worth.' },
  { word: 'Tedious', definition: 'Long, slow, and boring; tiresome.' },
  { word: 'Vivid', definition: 'Producing powerful feelings or clear, sharp images in the mind.' },
];

const HIGH = [
  { word: 'Ephemeral', definition: 'Lasting for a very short time.' },
  { word: 'Ubiquitous', definition: 'Present, appearing, or found everywhere.' },
  { word: 'Pragmatic', definition: 'Dealing with things sensibly and realistically.' },
  { word: 'Ambivalent', definition: 'Having mixed or contradictory feelings about something.' },
  { word: 'Cognizant', definition: 'Having knowledge or being aware of something.' },
  { word: 'Eloquent', definition: 'Fluent and persuasive in speaking or writing.' },
  { word: 'Juxtapose', definition: 'To place two things side by side for contrast or comparison.' },
  { word: 'Pernicious', definition: 'Having a harmful effect, especially in a gradual way.' },
  { word: 'Quintessential', definition: 'Representing the most perfect or typical example of something.' },
  { word: 'Surreptitious', definition: 'Done secretly or stealthily.' },
  { word: 'Tenacious', definition: 'Persistent in maintaining, adhering to, or seeking something.' },
  { word: 'Vindicate', definition: 'To clear someone of blame or suspicion.' },
  { word: 'Zealous', definition: 'Having or showing great energy in pursuit of a goal.' },
  { word: 'Precarious', definition: 'Not securely held or in position; dangerously likely to fail.' },
];

// Sunday-start week, exactly matching utils/reading.js's own startOfWeek
// - a new word appears the moment "This Week" rolls over there too.
function startOfWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

// A known Sunday, arbitrary - only its position in the week cycle
// matters, not the specific date.
const EPOCH_SUNDAY = Date.UTC(2024, 0, 7);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekIndex() {
  return Math.floor((startOfWeek(new Date()).getTime() - EPOCH_SUNDAY) / WEEK_MS);
}

function pick(bank) {
  const idx = weekIndex();
  return bank[((idx % bank.length) + bank.length) % bank.length];
}

function wordsOfTheWeek() {
  return {
    elementary: pick(ELEMENTARY),
    middle: pick(MIDDLE),
    high: pick(HIGH),
  };
}

module.exports = { wordsOfTheWeek };
