-- Student Portal > Reading Competition - a real request: "there will be a
-- reading log on this page for students to fill out and earn points.
-- students will compete with other students." One row per reading
-- session a student logs (not one row per student, unlike student_pets)
-- since the dashboard needs a scrollable history of entries and streaks/
-- weekly totals are computed by summing rows, not a single mutable
-- counter - same "compute on read" philosophy as student_pets' care
-- stats (see that migration's own comment): points/streak/level/
-- achievements all derive from this table in utils/reading.js rather
-- than being stored redundantly, so there's nothing to drift out of
-- sync. log_date is the date the reading happened (student-entered, may
-- not be today), separate from created_at (when the row was inserted).
create table if not exists reading_logs (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  book_title text not null,
  hours numeric not null,
  notes text,
  log_date text not null,
  created_at text not null default now_text()
);

create index if not exists reading_logs_member_id_idx on reading_logs (member_id);
