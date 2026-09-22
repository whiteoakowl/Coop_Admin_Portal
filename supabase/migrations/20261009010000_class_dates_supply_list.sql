-- A real request: "Parent and student portal. On classroom dashboard
-- when you click on a Class card it take you to that class. Details
-- should have teachers, assistants, room number, start and end dates,
-- start and end time, day of the week, class description, supply
-- list." start_time/end_time (a class's own daily time slot) and
-- description already existed; this adds the class's own overall
-- start/end DATE range (the term/session it runs for) and a supply
-- list, both editable from Co-op Admin's own Class Details form
-- (views/admin-class-schedule-manage.ejs).
alter table classes add column if not exists start_date text;
alter table classes add column if not exists end_date text;
alter table classes add column if not exists supply_list text;
