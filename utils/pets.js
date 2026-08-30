// Student Portal > Pets - a real request: "create a personal pet activity
// for students. They can choose a pet, choose a few features and save.
// Then they can name their pet, feed it, play with it, bathe it." See
// the migration's own header comment (20260830010000_student_pets.sql)
// for why care stats are computed here rather than stored as mutable
// numbers, and views/partials/pet-sprites.ejs for how a species/color/
// eyes/mouth/accessory combination actually gets drawn.
const db = require('../db');

// Two colors each - the reference mockup's "2 cat" request generalized
// to every species rather than special-cased just for cats.
const SPECIES = [
  { key: 'cat', label: 'Cat', colors: [{ key: 'black', label: 'Black', hex: '#3a3532' }, { key: 'orange', label: 'Orange', hex: '#e0813f' }] },
  { key: 'dog', label: 'Dog', colors: [{ key: 'golden', label: 'Golden', hex: '#e3b45c' }, { key: 'brown', label: 'Brown', hex: '#8b5a2b' }] },
  { key: 'rabbit', label: 'Rabbit', colors: [{ key: 'white', label: 'White', hex: '#f5f0e6' }, { key: 'gray', label: 'Gray', hex: '#9a9690' }] },
  { key: 'dragon', label: 'Dragon', colors: [{ key: 'green', label: 'Green', hex: '#5fa85a' }, { key: 'purple', label: 'Purple', hex: '#8a63c9' }] },
  { key: 'hamster', label: 'Hamster', colors: [{ key: 'brown', label: 'Brown', hex: '#c08a52' }, { key: 'white', label: 'White', hex: '#f0e9da' }] },
  { key: 'husky', label: 'Husky', colors: [{ key: 'gray', label: 'Gray', hex: '#6b7075' }, { key: 'black', label: 'Black', hex: '#2b2b2e' }] },
  { key: 'turtle', label: 'Turtle', colors: [{ key: 'green', label: 'Green', hex: '#5a9451' }, { key: 'blue', label: 'Blue', hex: '#4a7fa8' }] },
  { key: 'chicken', label: 'Chicken', colors: [{ key: 'white', label: 'White', hex: '#f5f0e6' }, { key: 'red', label: 'Red', hex: '#b5502f' }] },
  { key: 'lizard', label: 'Lizard', colors: [{ key: 'green', label: 'Green', hex: '#5a9451' }, { key: 'orange', label: 'Orange', hex: '#d9843d' }] },
  { key: 'panda', label: 'Panda', colors: [{ key: 'black', label: 'Classic', hex: '#2d2a26' }, { key: 'red', label: 'Red Panda', hex: '#b5602f' }] },
];

const EYES = [
  { key: 'round', label: 'Round' },
  { key: 'sleepy', label: 'Sleepy' },
  { key: 'wide', label: 'Wide' },
];

const MOUTHS = [
  { key: 'smile', label: 'Smile' },
  { key: 'open', label: 'Open' },
  { key: 'neutral', label: 'Neutral' },
];

const ACCESSORIES = [
  { key: 'none', label: 'None' },
  { key: 'bow', label: 'Bow' },
  { key: 'hat', label: 'Wizard Hat' },
  { key: 'glasses', label: 'Glasses' },
  { key: 'bandana', label: 'Bandana' },
  { key: 'collar', label: 'Collar' },
];

function speciesByKey(key) {
  return SPECIES.find((s) => s.key === key) || SPECIES[0];
}

function colorForSpecies(speciesKey, colorKey) {
  const species = speciesByKey(speciesKey);
  return species.colors.find((c) => c.key === colorKey) || species.colors[0];
}

async function getPetForMember(memberId) {
  return db.prepare('SELECT * FROM student_pets WHERE member_id = ?').get(memberId);
}

// Called on first visit to /student/pets/customize - not persisted until
// the student actually hits Save, so browsing the chooser without saving
// leaves no row behind.
function defaultAppearance() {
  return { species: 'dog', color: 'golden', eyes: 'round', mouth: 'smile', accessory: 'none' };
}

async function savePet(memberId, { name, species, color, eyes, mouth, accessory }) {
  const validSpecies = SPECIES.some((s) => s.key === species) ? species : 'dog';
  const validColor = colorForSpecies(validSpecies, color).key;
  const validEyes = EYES.some((e) => e.key === eyes) ? eyes : 'round';
  const validMouth = MOUTHS.some((m) => m.key === mouth) ? mouth : 'smile';
  const validAccessory = ACCESSORIES.some((a) => a.key === accessory) ? accessory : 'none';
  const cleanName = (name || '').trim().slice(0, 40) || 'My Pet';

  const existing = await getPetForMember(memberId);
  if (existing) {
    await db
      .prepare(
        `UPDATE student_pets SET name = ?, species = ?, color = ?, eyes = ?, mouth = ?, accessory = ?, updated_at = now_text() WHERE member_id = ?`
      )
      .run(cleanName, validSpecies, validColor, validEyes, validMouth, validAccessory, memberId);
  } else {
    await db
      .prepare(
        `INSERT INTO student_pets (member_id, name, species, color, eyes, mouth, accessory) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(memberId, cleanName, validSpecies, validColor, validEyes, validMouth, validAccessory);
  }
  return getPetForMember(memberId);
}

async function renamePet(memberId, name) {
  const cleanName = (name || '').trim().slice(0, 40);
  if (!cleanName) return;
  await db.prepare('UPDATE student_pets SET name = ?, updated_at = now_text() WHERE member_id = ?').run(cleanName, memberId);
}

// Care stats are computed from elapsed time since each action, not
// stored as a mutable number - see the migration's own comment for why.
// A full day (24h) since the last action drains that stat to 0; capped
// at 0/100 either way. A brand-new pet (no last_*_at yet) starts full,
// not empty - nothing to take care of on the very first visit.
const HOURS_TO_EMPTY = 24;

function statFromTimestamp(timestamp) {
  if (!timestamp) return 100;
  const hoursSince = (Date.now() - new Date(timestamp.replace(' ', 'T') + 'Z').getTime()) / 3600000;
  return Math.max(0, Math.min(100, Math.round(100 - (hoursSince / HOURS_TO_EMPTY) * 100)));
}

function careStats(pet) {
  return {
    hunger: statFromTimestamp(pet.last_fed_at),
    happiness: statFromTimestamp(pet.last_played_at),
    cleanliness: statFromTimestamp(pet.last_bathed_at),
  };
}

// XP/coins are simple decorative running totals (no shop to spend coins
// in yet) - see the migration's own comment.
const XP_PER_ACTION = 15;
const COINS_PER_ACTION = 5;
const XP_PER_LEVEL = 100;

function levelInfo(xp) {
  const level = Math.floor(xp / XP_PER_LEVEL) + 1;
  const xpIntoLevel = xp % XP_PER_LEVEL;
  return { level, xpIntoLevel, xpForLevel: XP_PER_LEVEL };
}

// A short cooldown per action (not per pet) - long enough that mashing
// the same button doesn't farm XP, short enough a student checking in a
// few times a day never hits it for real use.
const COOLDOWN_MINUTES = 20;

function minutesSince(timestamp) {
  if (!timestamp) return Infinity;
  return (Date.now() - new Date(timestamp.replace(' ', 'T') + 'Z').getTime()) / 60000;
}

async function performCareAction(memberId, kind) {
  const pet = await getPetForMember(memberId);
  if (!pet) return { ok: false, error: 'No pet found.' };
  const column = { feed: 'last_fed_at', play: 'last_played_at', bathe: 'last_bathed_at' }[kind];
  if (!column) return { ok: false, error: 'Unknown action.' };

  if (minutesSince(pet[column]) < COOLDOWN_MINUTES) {
    return { ok: false, error: `${pet.name} isn't ready for that again yet - try again in a few minutes.` };
  }

  await db
    .prepare(`UPDATE student_pets SET ${column} = now_text(), xp = xp + ?, coins = coins + ?, updated_at = now_text() WHERE member_id = ?`)
    .run(XP_PER_ACTION, COINS_PER_ACTION, memberId);
  return { ok: true };
}

module.exports = {
  SPECIES,
  EYES,
  MOUTHS,
  ACCESSORIES,
  speciesByKey,
  colorForSpecies,
  defaultAppearance,
  getPetForMember,
  savePet,
  renamePet,
  careStats,
  levelInfo,
  performCareAction,
};
