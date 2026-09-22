-- A real request: "Overall class settings. Add a place to create and add
-- new semester titles. On individual class settings add dropdown for
-- choosing semester." A brand new, generic concept (like Sections) that
-- classes get tagged with, purely for grouping/labeling (e.g. "Fall
-- 2026", "Spring 2027") - task #181's orientation rebuild depends on this
-- existing first, so a semester can also be the scope orientation
-- members are grouped by.
create table if not exists semesters (
  id integer generated always as identity primary key,
  title text not null unique,
  created_at text not null default now_text()
);

alter table classes add column if not exists semester_id integer references semesters(id) on delete set null;
