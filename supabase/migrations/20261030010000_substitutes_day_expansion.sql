-- Last table missed by the 7-day expansion: permanent_jobs (Floater
-- Assignments' Substitutes board - routes/admin-substitutes.js, the
-- "Add/Edit Position" dialog) still had the original 2-day CHECK
-- constraint, so creating a permanent job for a newly-activated 3rd+
-- day would 500 outright, same failure mode as every other :day table
-- this expansion already widened.
alter table permanent_jobs drop constraint if exists permanent_jobs_day_check;
alter table permanent_jobs add constraint permanent_jobs_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));
