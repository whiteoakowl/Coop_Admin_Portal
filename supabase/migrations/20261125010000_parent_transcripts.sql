-- Parent Portal - Transcript builder (Academics > Transcripts). A real
-- request: "Parent portal, add tabs called transcripts/diplomas... On
-- transcripts you can create and print a transcript for each student.
-- You can add classes from co-op classes or family management classes
-- or manually add an entirely new class. Then calculate the GPA per
-- school year and for the entire 4 years. Print full page view of
-- transcript." Diplomas already existed (routes/parent-portal.js's own
-- /academics/diplomas) - this replaces the old READ-ONLY Transcripts
-- summary (student_academic_history, utils/academics.js's own
-- transcriptForStudent, which only ever listed class names/completion
-- dates, never a grade or credit value to compute a GPA from at all)
-- with an editable, gradable builder.
--
-- Every entry snapshots its own class name at add time - same "a plain
-- text column, not a live FK" convention student_academic_history's
-- own class_name already uses - regardless of which of the three
-- sources (co-op classes, family management classes, or a manually
-- typed class) it came from, so a transcript entry never silently
-- changes just because the original co-op/family-school class was
-- later renamed or deleted. school_year is a free-text label (e.g.
-- "2024-2025" or "9th Grade") rather than a fixed enum - a homeschool
-- family's own "4 years" don't necessarily line up with a co-op's own
-- semester/grade-level structure.
create table if not exists parent_transcript_entries (
  id integer generated always as identity primary key,
  student_id integer not null references members(id) on delete cascade,
  school_year text not null,
  class_name text not null,
  credit_hours numeric not null default 1,
  grade_letter text,
  position integer not null default 0,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_parent_transcript_entries_student on parent_transcript_entries(student_id, school_year);
