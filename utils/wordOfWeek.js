// Student Portal homepage > Word of the Week - a real request: "show a
// word of the week. system generates a new word every sunday. it will
// actually show 3 words. one for elementary level, one for middle
// school level and one for high school level." Pure "compute on read"
// (same philosophy as utils/reading.js/utils/pets.js) - no database row
// to maintain, no cron job to advance it. The word for a given week is
// just `weekIndex() % bank.length`, a stable, deterministic pick that
// only changes at the Sunday boundary and cycles back to the start of
// each list once every bank is exhausted.
//
// A later real request: "make it look exactly like these photos" (a
// reference screenshot) - each entry also carries a simple, non-IPA
// phonetic `pronunciation` ("KYUR-ee-us": stressed syllable in caps,
// syllables hyphenated) to match that reference's pronunciation-guide
// line under each word.
const ELEMENTARY = [
  { word: 'Curious', pronunciation: 'KYUR-ee-us', definition: 'Eager to learn or know something.' },
  { word: 'Gigantic', pronunciation: 'jy-GAN-tik', definition: 'Extremely large; huge.' },
  { word: 'Brave', pronunciation: 'BRAYV', definition: 'Ready to face danger or pain without fear.' },
  { word: 'Sparkle', pronunciation: 'SPAR-kul', definition: 'To shine with small flashes of light.' },
  { word: 'Wander', pronunciation: 'WAHN-der', definition: 'To walk around slowly without a fixed direction.' },
  { word: 'Cheerful', pronunciation: 'CHEER-ful', definition: 'Feeling or showing happiness.' },
  { word: 'Ancient', pronunciation: 'AYN-shunt', definition: 'Very old; from a long time ago.' },
  { word: 'Whisper', pronunciation: 'WISS-per', definition: 'To speak very softly.' },
  { word: 'Journey', pronunciation: 'JUR-nee', definition: 'A trip from one place to another.' },
  { word: 'Clever', pronunciation: 'KLEV-er', definition: 'Quick to understand, learn, and figure things out.' },
  { word: 'Enormous', pronunciation: 'ih-NOR-mus', definition: 'Very great in size or amount.' },
  { word: 'Grateful', pronunciation: 'GRAYT-ful', definition: 'Feeling or showing thanks.' },
  { word: 'Mystery', pronunciation: 'MISS-tuh-ree', definition: 'Something that is hard to explain or understand.' },
  { word: 'Delight', pronunciation: 'dih-LYT', definition: 'Great pleasure or joy.' },
];

const MIDDLE = [
  { word: 'Resilient', pronunciation: 'rih-ZIL-yent', definition: 'Able to recover quickly from difficulties.' },
  { word: 'Meticulous', pronunciation: 'muh-TIK-yuh-lus', definition: 'Showing great attention to detail; very careful.' },
  { word: 'Ambiguous', pronunciation: 'am-BIG-yoo-us', definition: 'Open to more than one interpretation; unclear.' },
  { word: 'Diligent', pronunciation: 'DIL-ih-junt', definition: 'Showing steady, careful effort in work or duties.' },
  { word: 'Empathy', pronunciation: 'EM-puh-thee', definition: "The ability to understand and share another person's feelings." },
  { word: 'Persevere', pronunciation: 'pur-suh-VEER', definition: 'To continue trying despite difficulty or delay in success.' },
  { word: 'Skeptical', pronunciation: 'SKEP-tih-kul', definition: 'Not easily convinced; having doubts.' },
  { word: 'Versatile', pronunciation: 'VUR-suh-tul', definition: 'Able to adapt to many different functions or activities.' },
  { word: 'Candid', pronunciation: 'KAN-did', definition: 'Truthful and straightforward; frank.' },
  { word: 'Innovate', pronunciation: 'IN-uh-vayt', definition: 'To introduce new ideas, methods, or products.' },
  { word: 'Reluctant', pronunciation: 'rih-LUK-tunt', definition: 'Unwilling and hesitant to do something.' },
  { word: 'Substantial', pronunciation: 'sub-STAN-shul', definition: 'Of considerable importance, size, or worth.' },
  { word: 'Tedious', pronunciation: 'TEE-dee-us', definition: 'Long, slow, and boring; tiresome.' },
  { word: 'Vivid', pronunciation: 'VIV-id', definition: 'Producing powerful feelings or clear, sharp images in the mind.' },
];

const HIGH = [
  { word: 'Ephemeral', pronunciation: 'ih-FEM-er-ul', definition: 'Lasting for a very short time.' },
  { word: 'Ubiquitous', pronunciation: 'yoo-BIK-wih-tus', definition: 'Present, appearing, or found everywhere.' },
  { word: 'Pragmatic', pronunciation: 'prag-MAT-ik', definition: 'Dealing with things sensibly and realistically.' },
  { word: 'Ambivalent', pronunciation: 'am-BIV-uh-lent', definition: 'Having mixed or contradictory feelings about something.' },
  { word: 'Cognizant', pronunciation: 'KOG-nih-zunt', definition: 'Having knowledge or being aware of something.' },
  { word: 'Eloquent', pronunciation: 'EL-uh-kwent', definition: 'Fluent and persuasive in speaking or writing.' },
  { word: 'Juxtapose', pronunciation: 'JUK-stuh-pohz', definition: 'To place two things side by side for contrast or comparison.' },
  { word: 'Pernicious', pronunciation: 'per-NISH-us', definition: 'Having a harmful effect, especially in a gradual way.' },
  { word: 'Quintessential', pronunciation: 'kwin-tuh-SEN-shul', definition: 'Representing the most perfect or typical example of something.' },
  { word: 'Surreptitious', pronunciation: 'sur-up-TISH-us', definition: 'Done secretly or stealthily.' },
  { word: 'Tenacious', pronunciation: 'tuh-NAY-shus', definition: 'Persistent in maintaining, adhering to, or seeking something.' },
  { word: 'Vindicate', pronunciation: 'VIN-dih-kayt', definition: 'To clear someone of blame or suspicion.' },
  { word: 'Zealous', pronunciation: 'ZEL-us', definition: 'Having or showing great energy in pursuit of a goal.' },
  { word: 'Precarious', pronunciation: 'prih-KAIR-ee-us', definition: 'Not securely held or in position; dangerously likely to fail.' },
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

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "May 20, 2024" - the Sunday this week's words started on, shown next to
// the widget's title (matches the reference screenshot's own date line).
function currentWeekDateLabel() {
  const d = startOfWeek(new Date());
  return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

module.exports = { wordsOfTheWeek, currentWeekDateLabel };
