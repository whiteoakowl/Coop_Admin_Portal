-- A real request: "if a member is archived on main admin portal it
-- should show the date they were archived." Members were already being
-- archived (active = 0) with no record of WHEN - this adds that
-- timestamp, set on archive and cleared on reactivate (routes/main-
-- admin-members.js's own /:id/archive, /:id/unarchive, /bulk-archive).
alter table members add column if not exists archived_at text;
