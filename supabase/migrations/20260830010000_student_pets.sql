-- Student Portal > Pets - a real request: "create a personal pet activity
-- for students. They can choose a pet, choose a few features and save.
-- Then they can name their pet, feed it, play with it, bathe it." One
-- pet per student member (unique on member_id), same "re-derive from
-- req.portalAccount.id, never trust a client-supplied id" scoping every
-- other Student Portal route already uses.
--
-- `look` is a plain text key into utils/pets.js's own PET_LOOKS catalog -
-- a real request ("higher level graphics and glossy like my original
-- screenshots... we need to go that route and do better") replaced the
-- original 5-trait mix-and-match system (species/ears/eyes/mouth/
-- accessory columns) with real photorealistic pet images (cropped
-- directly from the reference the user provided - see
-- public/images/pets/'s own README), so there's one "look" choice
-- instead of five independent trait cycles - a photoreal render can't be
-- decomposed into swappable parts the way flat SVG could.
--
-- Care stats (hunger/happiness/cleanliness) are intentionally NOT stored
-- as mutable numbers - they're computed on read from how long it's been
-- since last_fed_at/last_played_at/last_bathed_at (utils/pets.js's own
-- careStats()), so there's nothing to drift out of sync and no cron job
-- needed to "decay" anything. xp/coins stay simple running totals -
-- decorative progress (no shop to spend coins in yet), incremented a
-- fixed amount per care action.
create table if not exists student_pets (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  name text not null default 'My Pet',
  look text not null default 'cat_black',
  xp integer not null default 0,
  coins integer not null default 25,
  last_fed_at text,
  last_played_at text,
  last_bathed_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
