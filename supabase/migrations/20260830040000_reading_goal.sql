-- Student Portal > Reading Challenge - a real request: "is there a button
-- for setting your reading goal?" The weekly goal used to be a single
-- hardcoded constant (utils/reading.js's own WEEKLY_GOAL_HOURS) shared by
-- every student; this lets each student set their own. One row per
-- student (unique on member_id, same pattern as student_pets), missing
-- row = the default goal - utils/reading.js's getWeeklyGoal() falls back
-- to WEEKLY_GOAL_HOURS rather than requiring a row to exist up front.
create table if not exists reading_goals (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  weekly_goal_hours numeric not null default 7,
  updated_at text not null default now_text()
);
