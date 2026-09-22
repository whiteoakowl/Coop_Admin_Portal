-- A real request: "main admin, classes, settings. Add registration
-- schedule. Be able to control who can signup on each schedule grid
-- monday/wednesday. Date, time and section and open for teacher or
-- assistant registration." A follow-up question confirmed this should
-- gate everyone who registers for a class (parents/students/teachers),
-- not just teacher/assistant - role_key already covers that. Day and
-- section narrow an existing registration_windows row to one schedule
-- grid / one Sections group, same "column present but null means
-- unrestricted" convention role_key already uses - a co-op with no
-- windows, or a window that leaves these blank, sees no behavior change.
alter table registration_windows add column if not exists day text check (day in ('monday', 'wednesday'));
alter table registration_windows add column if not exists section_id integer references sections(id) on delete set null;
create index if not exists idx_registration_windows_section on registration_windows(section_id);
