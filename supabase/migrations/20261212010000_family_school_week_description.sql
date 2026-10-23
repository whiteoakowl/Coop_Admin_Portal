-- A real request: "a label that says the week title with an edit icon
-- on it. When you click the edit icon it allows you to edit the week
-- such as the dates, title, description or delete the week completely."
-- Title and dates (family_school_week_dates) already existed; this adds
-- the one missing field, description.
alter table family_school_weeks add column if not exists description text;
