-- Student Portal > Spelling Bee - a real request: "this page will have a
-- spelling game with vocabulary words for every grade level. grade
-- level on students member profile determines their vocabulary level."
-- One row per completed round (not a mutable per-student counter) -
-- same "raw event rows, derive totals on read" philosophy as
-- game_scores/reading_logs - so the Leaderboard's "top 5 highest
-- spelling bee points" can just SUM these per member.
create table if not exists spelling_scores (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  correct_count integer not null,
  round_total integer not null,
  level text not null,
  achieved_at text not null default now_text()
);

create index if not exists spelling_scores_member_id_idx on spelling_scores (member_id);
