-- "We don't need any archive features under classes tab either on co-op
-- admin portal. Everything is connected to semesters so we don't need
-- individual archiving anymore." The Class/Student/Parent Schedule
-- Archive features (class_schedule_archives, member_schedule_archives)
-- are removed from the UI/routes entirely - both tables are left as-is
-- (any pre-existing archived rows stay queryable directly, just not
-- through the app anymore).
--
-- archiveClasses used to be the ONLY thing that wrote a Transcript entry
-- (student_academic_history) for a student who completed a class, as a
-- side effect of manually archiving it. With that manual step gone,
-- transcripts are generated automatically once a class's own end_date
-- has passed (see utils/academics.js's generateTranscriptsForEndedClasses,
-- called from the Academics page) - this adds class_id so that backfill
-- can tell which classes it's already generated an entry for and never
-- double-insert one on a later run.
alter table student_academic_history add column if not exists class_id integer references classes(id) on delete set null;
create unique index if not exists idx_student_academic_history_student_class on student_academic_history(student_id, class_id) where class_id is not null;
