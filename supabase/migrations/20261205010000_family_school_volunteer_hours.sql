-- A real request: "Family school management, add a subpage for
-- volunteer hours. Be able to track and add volunteer hours per student
-- and have a log." A family's own self-tracked homeschool volunteer
-- hours, scoped to family_school_* like every other Family School
-- Management table - NOT the separate co-op-wide Volunteers/Floater
-- system (utils/volunteers.js). "hours numeric not null" matches the
-- existing reading_logs table's own convention for a decimal-hours
-- column.
create table if not exists family_school_volunteer_hours (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  hour_date text not null,
  hours numeric not null,
  activity_description text,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_family_school_volunteer_hours_student on family_school_volunteer_hours(student_id);
