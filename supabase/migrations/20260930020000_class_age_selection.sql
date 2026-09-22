-- A real request: "co-op admin portal, classes, grade selection and age
-- selection should be separate menus of choices." classes.age_group
-- stayed the Grade list (GRADE_LEVELS - Infant through 12th, unchanged);
-- this adds a second, independent comma-joined list of exact numeric
-- ages (0-100), same shape utils/events.js's own AGE_OPTIONS restriction
-- already uses for events - "deliberately its own list," not a grade
-- vocabulary. Both empty means unrestricted, same convention age_group
-- already used alone.
alter table classes add column if not exists numeric_ages text;
