-- A real request: "Co-op admin, classes, grade and age should have a
-- checkbox that says lock class by grade or lock class by age." Grade
-- and Age selections on a class were always BOTH enforced together at
-- registration time (utils/classRegistration.js's own "both gates must
-- pass" comment) - these two independent toggles let an admin choose
-- which of the two actually gates registration for a given class,
-- defaulting to true (both locked) to preserve that existing behavior
-- for every class that already has one.
alter table classes add column if not exists lock_by_grade integer not null default 1;
alter table classes add column if not exists lock_by_age integer not null default 1;

-- A real request: "Add close registration check box on detail page" -
-- registration_open already existed (previously toggled from the old
-- Class Settings tab's per-class table, now removed - see task #188's
-- own Co-op Class Settings rebuild), this just documents it moving to
-- live on the class's own Details tab instead. No column change needed.
