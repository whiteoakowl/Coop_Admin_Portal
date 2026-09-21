-- A real request: reorganizing the Settings tab's checkbox list into
-- "Registration Settings" and "General Settings" sections surfaced two
-- new questions among the reworded set: "Allow waiting list signups
-- (only applicable when Max Allowed is reached)" and "Allow registrants
-- to 'Sign Up For' on behalf of other families in your group."
--
-- allow_waitlist_signups defaults to 1 (true) to preserve every existing
-- event's current behavior (a full event has always waitlisted rather
-- than rejecting) - this is wired for real in utils/events.js's
-- createOrReactivateRegistration (registerForEvent's own member-facing
-- call passes the event's own value; adminAddRegistrations keeps
-- bypassing it, same as it already bypasses every other member-facing
-- registration rule).
--
-- allow_signup_for_others_in_group is stored only for now, ready to wire
-- up once a real "register another family in the co-op" member-facing
-- feature exists - same pattern allow_refund_on_cancel/
-- show_registrants_to_members/track_participants_only already use.
alter table events add column if not exists allow_waitlist_signups integer not null default 1;
alter table events add column if not exists allow_signup_for_others_in_group integer not null default 0;
