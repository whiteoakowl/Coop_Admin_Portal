-- Student Portal > Pets - a real request: "create a personal pet activity
-- for students. They can choose a pet, choose a few features and save.
-- Then they can name their pet, feed it, play with it, bathe it." One
-- pet per student member (unique on member_id), same "re-derive from
-- req.portalAccount.id, never trust a client-supplied id" scoping every
-- other Student Portal route already uses.
--
-- Appearance is a small fixed set of traits (species/color/eyes/mouth/
-- accessory), each a plain text key into utils/pets.js's own catalog -
-- no JSON blob needed since there's no free-form positioning here (all
-- traits are simple prev/next cycles through a fixed list, unlike the
-- Name Tag designer's drag-and-drop canvas).
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
  species text not null default 'dog',
  color text not null default 'default',
  eyes text not null default 'round',
  mouth text not null default 'smile',
  accessory text not null default 'none',
  xp integer not null default 0,
  coins integer not null default 25,
  last_fed_at text,
  last_played_at text,
  last_bathed_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
