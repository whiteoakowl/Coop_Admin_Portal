-- Student Portal > Games header stats - a real request: "include games
-- played, high score, current streak bar at the top right." Same
-- "compute on read" approach as reading_logs/student_pets (see those
-- migrations' own comments): raw event rows here, with
-- utils/gameStats.js deriving the played-count/streak/high-score from
-- them rather than maintaining mutable counters that could drift.
--
-- game_plays gets one row every time a student opens a game's play page
-- (routes/student-portal.js's GET /games/play/:key) - an honest, simple
-- proxy for "played this game" across all 15 games (most of which have
-- no natural in-game "finished" event to hook instead).
--
-- game_scores only gets rows from the handful of games that actually
-- produce a comparable numeric result (Snake, Avoid the Obstacles,
-- Trivia Quiz, Typing Race - see utils/gameStats.js's own SCORING_GAMES)
-- via their own JS posting to POST /student/games/score when a round
-- ends. The header's single "High Score" stat is just the best row here
-- across any of those games, labeled with which game it came from -
-- deliberately not attempting to make wildly different games (points vs
-- words-per-minute) comparable in any more rigorous way.
create table if not exists game_plays (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  game_key text not null,
  played_at text not null default now_text()
);
create index if not exists game_plays_member_id_idx on game_plays (member_id);

create table if not exists game_scores (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  game_key text not null,
  score integer not null,
  achieved_at text not null default now_text()
);
create index if not exists game_scores_member_id_idx on game_scores (member_id);
