// Student Portal > Pets - a real request: "create a personal pet activity
// for students. They can choose a pet, choose a few features and save.
// Then they can name their pet, feed it, play with it, bathe it."
//
// Originally a 5-trait mix-and-match system (Body/Ears/Eyes/Mouth/
// Accessories, each independently cyclable) rendered as flat SVG. A
// follow-up request ("higher level graphics and glossy like my original
// screenshots... we need to go that route and do better") replaced that
// with real photorealistic pet images cropped directly from the
// reference screenshots the user provided - see public/images/pets/'s
// own README for the crop convention. Photoreal renders can't be
// decomposed into independently swappable parts the way flat SVG can
// (you can't cleanly swap just the eyes on a baked photo), so
// customization is now a single "pick one whole look" choice (PET_LOOKS
// below) instead of five separate cyclers - this also matches what the
// user's own reference "Choose Your Pet" mockup actually shows: complete
// pre-rendered looks, not independently recombinable parts.
//
// Every PET_LOOKS entry still carries an `svg` preset (the old
// species/ears/eyes/mouth/accessory/hex/eyeColor combination, rendered
// via views/partials/pet-sprites.ejs) as a graceful fallback for any
// look that doesn't have a real photo yet (`image: null` below) - so
// adding real art later for cat_orange/turtle/chicken/lizard/panda is a
// one-line edit (drop the file in public/images/pets/, set `image`)
// rather than a code change. See the migration's own header comment
// (20260830010000_student_pets.sql) for why care stats are computed
// here rather than stored as mutable numbers.
const db = require('../db');

const PET_LOOKS = [
  {
    key: 'cat_black',
    label: 'Black Cat',
    image: '/images/pets/cat_black.webp',
    svg: { species: 'cat_black', ears: 'pointy', eyes: 'round', mouth: 'smile', accessory: 'hat', hex: '#3a3532', eyeColor: '#7cc142', roomTheme: 'pet-room-cozy' },
  },
  {
    key: 'cat_orange',
    label: 'Orange Cat',
    image: '/images/pets/cat_orange.webp',
    svg: { species: 'cat_orange', ears: 'pointy', eyes: 'round', mouth: 'smile', accessory: 'collar', hex: '#e0813f', eyeColor: '#e0a83f', roomTheme: 'pet-room-cozy' },
  },
  {
    key: 'dog',
    label: 'Golden Retriever',
    image: '/images/pets/dog.webp',
    svg: { species: 'dog', ears: 'floppy', eyes: 'wide', mouth: 'open', accessory: 'bandana', hex: '#e3b45c', eyeColor: '#6b4423', roomTheme: 'pet-room-playroom' },
  },
  {
    key: 'rabbit',
    label: 'Rabbit',
    image: '/images/pets/rabbit.webp',
    svg: { species: 'rabbit', ears: 'tufted', eyes: 'round', mouth: 'smile', accessory: 'bow', hex: '#f5f0e6', eyeColor: '#4a90d9', roomTheme: 'pet-room-lavender' },
  },
  {
    key: 'dragon',
    label: 'Dragon',
    image: '/images/pets/dragon.webp',
    svg: { species: 'dragon', ears: 'none', eyes: 'wide', mouth: 'smile', accessory: 'none', hex: '#5fa85a', eyeColor: '#e8934a', roomTheme: 'pet-room-dungeon' },
  },
  {
    key: 'hamster',
    label: 'Hamster',
    image: '/images/pets/hamster.webp',
    svg: { species: 'hamster', ears: 'round', eyes: 'round', mouth: 'open', accessory: 'none', hex: '#c08a52', eyeColor: '#4a2f1f', roomTheme: 'pet-room-cage' },
  },
  {
    key: 'husky',
    label: 'Husky',
    image: '/images/pets/husky.webp',
    svg: { species: 'husky', ears: 'pointy', eyes: 'round', mouth: 'smile', accessory: 'collar', hex: '#6b7075', eyeColor: '#4a90d9', roomTheme: 'pet-room-snow' },
  },
  {
    key: 'turtle',
    label: 'Turtle',
    image: '/images/pets/turtle.webp',
    svg: { species: 'turtle', ears: 'none', eyes: 'round', mouth: 'smile', accessory: 'none', hex: '#5a9451', eyeColor: '#2d2a26', roomTheme: 'pet-room-pond' },
  },
  {
    key: 'chicken',
    label: 'Chicken',
    image: '/images/pets/chicken.webp',
    svg: { species: 'chicken', ears: 'none', eyes: 'round', mouth: 'smile', accessory: 'none', hex: '#f5f0e6', eyeColor: '#2d2a26', roomTheme: 'pet-room-farm' },
  },
  {
    key: 'lizard',
    label: 'Lizard',
    image: '/images/pets/lizard.webp',
    svg: { species: 'lizard', ears: 'none', eyes: 'round', mouth: 'smile', accessory: 'none', hex: '#5a9451', eyeColor: '#8a9a3a', roomTheme: 'pet-room-terrarium' },
  },
  {
    key: 'panda',
    label: 'Panda',
    image: '/images/pets/panda.webp',
    svg: { species: 'panda', ears: 'round', eyes: 'round', mouth: 'smile', accessory: 'none', hex: '#2d2a26', eyeColor: '#2d2a26', roomTheme: 'pet-room-bamboo' },
  },
];

function lookByKey(key) {
  return PET_LOOKS.find((l) => l.key === key) || PET_LOOKS[0];
}

async function getPetForMember(memberId) {
  return db.prepare('SELECT * FROM student_pets WHERE member_id = ?').get(memberId);
}

// Called on first visit to /student/pets/customize - not persisted until
// the student actually hits Save, so browsing the chooser without saving
// leaves no row behind.
function defaultLook() {
  return PET_LOOKS[0].key;
}

async function savePet(memberId, { name, look }) {
  const validLook = PET_LOOKS.some((l) => l.key === look) ? look : defaultLook();
  const cleanName = (name || '').trim().slice(0, 40) || 'My Pet';

  const existing = await getPetForMember(memberId);
  if (existing) {
    await db
      .prepare('UPDATE student_pets SET name = ?, look = ?, updated_at = now_text() WHERE member_id = ?')
      .run(cleanName, validLook, memberId);
  } else {
    await db.prepare('INSERT INTO student_pets (member_id, name, look) VALUES (?, ?, ?)').run(memberId, cleanName, validLook);
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
  PET_LOOKS,
  lookByKey,
  defaultLook,
  getPetForMember,
  savePet,
  renamePet,
  careStats,
  levelInfo,
  performCareAction,
};
