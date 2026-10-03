-- Continuing the 7-day expansion's Phase 3 (Name Tags/Badges), plus a real
-- gap found while auditing for it: class_schedule_archives (Classes' own
-- Bulk Edit > Archive feature) was missed by Phase 1 (20261025010000) and
-- still had a 2-day-only CHECK constraint, so archiving a class scheduled
-- on a newly-activated day (e.g. Tuesday) would 500. name_tag_requests
-- (the public Name Tag Form's own "Schedule Change" day picker, and the
-- admin-added-from-Member-List 'both' default) has the same gap - widened
-- the same way the three prior day-expansion migrations did.
alter table name_tag_requests drop constraint if exists name_tag_requests_day_check;
alter table name_tag_requests add constraint name_tag_requests_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday','both'));

alter table class_schedule_archives drop constraint if exists class_schedule_archives_day_check;
alter table class_schedule_archives add constraint class_schedule_archives_day_check check (day in ('sunday','monday','tuesday','wednesday','thursday','friday','saturday'));
