-- A real request: "Family school management. Settings tabs. Add to
-- settings the date picker for when did you started homeschooling."
-- Shown on the Overview page's own new school-info header (next to
-- school name/logo/colors) as "Homeschooled since <date>".
alter table family_school_settings add column if not exists homeschooled_since text;
