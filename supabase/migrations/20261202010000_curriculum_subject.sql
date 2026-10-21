-- A real request: "Parent portal, family management, annual planner,
-- add curriculum, add a subject bar." family_school_curriculum_items
-- (20261124010000_family_school_planner.sql) already has name/brand/
-- level/price; subject is a new, separate free-text field (e.g. "Math",
-- "Language Arts") rather than overloading name/level for it.
alter table family_school_curriculum_items add column if not exists subject text;

-- A real request: "Add a dropdown menu for selecting a school year.
-- 2026-2027, 2028-2029, 2020-2021 and so on." Stored as the plain
-- "YYYY-YYYY" label text itself (e.g. "2026-2027"), not a bare start
-- year int - an Annual Planner's curriculum naturally belongs to one
-- specific school year rather than piling every year's curriculum into
-- one undifferentiated list forever.
alter table family_school_curriculum_items add column if not exists school_year text;
