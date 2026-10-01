-- A real request: "volunteer lists, click on a list and add... enable
-- button when you click it members can signup on the list. Enable button
-- turns into disable button. If you click disable button nobody can
-- signup on the list but they can still view the link. Make these
-- changes for signup lists page as well." Both list types default open
-- (existing lists keep working exactly as before) - closing one only
-- blocks the member-facing claim/signup action (routes/signup-volunteer-
-- lists.js), never the GET view.
alter table volunteer_signup_lists add column if not exists is_open integer not null default 1;
alter table sign_up_lists add column if not exists is_open integer not null default 1;
