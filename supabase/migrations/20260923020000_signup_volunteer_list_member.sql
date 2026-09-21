-- A real request: "main admin signup lists and volunteer lists, edit...
-- below attach to event, there should be a drop down for attach to
-- member with a choice of members listed abc by last name." Same
-- optional "attach to one of these, or none" shape event_id already has
-- on both tables - nullable, null means unattached.
alter table sign_up_lists add column if not exists member_id integer references members(id) on delete set null;
alter table volunteer_signup_lists add column if not exists member_id integer references members(id) on delete set null;
