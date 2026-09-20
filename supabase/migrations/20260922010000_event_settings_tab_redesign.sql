-- A real request: "event setting check boxes or yes/no in a column on
-- the left, question to the right. questions with check boxes is this a
-- public event, allow refunds when member cancels registration, close
-- event, allow registration cancelations, allow members to register
-- guests, allow other members to see who is registered for the event,
-- only track participants. grade level multiple choice, age multiple
-- choice check boxes next to both that say lock registration to age
-- level or lock registration to grade level. checkbox lock registration
-- to section, drop down of sections. lock registration to only be
-- viewable to one section check box and dropdown." "Is this a public
-- event" and "allow members to register guests" reuse the existing
-- visibility/allow_guest_register columns (just relocated in the UI from
-- the Details/"Who Can Register" sections into this new list); the rest
-- are new. close_event/allow_registration_cancellations gain real
-- enforcement in utils/events.js's registerForEvent/cancelRegistration;
-- allow_refund_on_cancel/show_registrants_to_members/
-- track_participants_only are stored, ready to wire up once a real
-- refund or "who else is registered" feature exists in this app, same
-- "controls X once a real feature exists" pattern event_settings'
-- several fields already use (20260829010000_event_settings.sql).
alter table events add column if not exists is_closed integer not null default 0;
alter table events add column if not exists allow_registration_cancellations integer not null default 1;
alter table events add column if not exists allow_refund_on_cancel integer not null default 0;
alter table events add column if not exists show_registrants_to_members integer not null default 0;
alter table events add column if not exists track_participants_only integer not null default 0;

-- The existing age_group column already restricts by grade whenever it
-- has values ("empty means unrestricted"); this adds an explicit on/off
-- switch instead of relying on "did anyone check a grade box" alone, per
-- the "lock registration to grade level" checkbox asked for above. A new
-- parallel age-bucket restriction (age_group_restriction, using the same
-- AGE_GROUPS keys utils/emailComposer.js already buckets members into
-- for Communication filtering) gets the same kind of lock.
alter table events add column if not exists lock_registration_to_grade integer not null default 0;
alter table events add column if not exists lock_registration_to_age integer not null default 0;
alter table events add column if not exists age_group_restriction text;

-- Single-section locks, distinct from the existing many-section
-- event_sections restriction (20260826040000_events_registration_rules.sql,
-- which already restricts BOTH viewing and registering to any of several
-- sections) - these are additional, narrower single-section gates: one
-- for registering, one for who can even see the event. Both combine with
-- any existing event_sections restriction (a member must satisfy every
-- restriction that applies, not just one), rather than replacing it.
alter table events add column if not exists lock_registration_to_section integer not null default 0;
alter table events add column if not exists registration_section_id integer references sections(id) on delete set null;
alter table events add column if not exists lock_visibility_to_section integer not null default 0;
alter table events add column if not exists visibility_section_id integer references sections(id) on delete set null;
