-- A real, large request extending the existing Events module (see
-- 20260825030000_events_module.sql) with registration rules, categories,
-- section restriction, guest registration, and check-in/out - the Events
-- half of the same request the class-registration migration
-- (20260826020000) covered for Classes. Draft/publish (`status`) and
-- capacity already existed; this adds the rest: a registration open/
-- close window, a family cap alongside the existing per-person capacity,
-- age/grade restriction, per-person/per-family pricing, a real managed
-- category list, section restriction (view AND register, unlike a
-- class's registration-only restriction - "select sections only that can
-- view or signup for events"), whether adult or child members may be
-- registered, member-submitted events awaiting approval, lightweight
-- guest registration, and check-in/out tracking.

-- Main-Admin-managed, same shape/reasoning as `sections` - a fixed list
-- an event picks one of, so the calendar can filter/color-code by
-- category instead of every admin typing their own free text. The
-- original `events.category` free-text column is left in place
-- (untouched, still populated on old rows) rather than migrated - new
-- events use category_id instead; nothing reads the old text column once
-- category_id is set.
create table if not exists event_categories (
  id integer generated always as identity primary key,
  name text not null unique,
  color text not null default '#EE9A4D',
  position integer not null default 0,
  created_at text not null default now_text()
);

alter table events add column if not exists category_id integer references event_categories(id) on delete set null;

alter table events add column if not exists registration_opens_at text;
alter table events add column if not exists registration_closes_at text;
-- Alongside the existing per-person `capacity` - "limit number of
-- people, number of families" are two separate caps a family-heavy
-- event (one signup covers several people) needs independently.
alter table events add column if not exists family_capacity integer;
-- Comma-joined list of utils/membership.js's own GRADE_OPTIONS strings -
-- reuses the Membership Form's grade vocabulary (what members.grade_level
-- actually stores), not classes.age_group's own different GRADE_LEVELS
-- list, since this is checked directly against a real member's
-- grade_level. Null/empty means unrestricted, same "empty means every
-- grade" convention as every other optional restriction here.
alter table events add column if not exists age_group text;
-- "be able to limit whether parents or kids can register for an event" -
-- checked against the member being registered's own member_type (parent/
-- admin count as "adult", student counts as "child"), not against which
-- portal the person submitting the registration is signed into (an event
-- registration can be submitted from any portal for any of the
-- submitter's own family).
alter table events add column if not exists allow_adult_register integer not null default 1;
alter table events add column if not exists allow_child_register integer not null default 1;
alter table events add column if not exists price_cents integer;
alter table events add column if not exists price_per text default 'person' check (price_per in ('person', 'family'));

-- Member-submitted events ("members should be able to add events for
-- approval"). Null submitted_by_account_id = admin-created, same as
-- every event before this migration. approval_status is independent of
-- `status` (draft/published/cancelled) - a submitted event starts
-- 'draft' + 'pending' and stays invisible to everyone but its submitter
-- and Main Admin's approval queue until a Main Admin either approves it
-- (still draft - a Main Admin still has to actually publish it, same as
-- any admin-created event) or rejects it.
alter table events add column if not exists submitted_by_account_id integer references member_accounts(id) on delete set null;
alter table events add column if not exists approval_status text not null default 'approved' check (approval_status in ('pending', 'approved', 'rejected'));

-- An event restricted to specific sections - no rows at all means "every
-- member can see/register", same "empty means unrestricted" convention
-- as class_sections (see the class-registration migration). Unlike a
-- class (which always lists on the schedule and only blocks
-- registration), an unlisted-section member can't see this event at all
-- - routes/events.js's own listing/detail queries filter on this.
create table if not exists event_sections (
  event_id integer not null references events(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (event_id, section_id)
);
create index if not exists idx_event_sections_section on event_sections(section_id);

-- Check-in/out (name tag barcode scan, or a manual Present/Absent toggle
-- on the registrations roster) - null check_in means "not checked in",
-- same as this app's existing attendance.check_in_time convention.
alter table event_registrations add column if not exists checked_in_at text;
alter table event_registrations add column if not exists checked_out_at text;
-- Same waitlist-position tracking as class_registrations.waitlist_position
-- (see the class-registration migration's own comment) - assigned at
-- insert, shifted down for everyone behind on a cancel or promotion.
alter table event_registrations add column if not exists waitlist_position integer;
-- The payment_charges row this registration created, if the event was
-- priced at the time of registration - same reasoning/shape as class_
-- registrations.charge_id (lets cancelling an unpaid registration clear
-- the charge instead of leaving it orphaned). 'event_registration' was
-- already a valid payment_charges.source_type before this migration (see
-- the class-registration migration's own comment on that constraint).
alter table event_registrations add column if not exists charge_id integer references payment_charges(id) on delete set null;

-- Lightweight guest registration ("guest registration for events (admin
-- permission)") - a real attendee with no `members` row at all, added by
-- a staff member holding the register_guests portal permission (db/
-- bootstrapPg.js), not self-service. No barcode/name tag exists for a
-- guest, so guest check-in/out is manual-only (see the roster page), not
-- scannable the way a real member's is.
create table if not exists event_guest_registrations (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  guest_name text not null,
  guest_email text,
  guest_phone text,
  registered_by_account_id integer references member_accounts(id) on delete set null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  checked_in_at text,
  checked_out_at text,
  created_at text not null default now_text()
);
create index if not exists idx_event_guest_registrations_event on event_guest_registrations(event_id);

-- Same "insert into notification_types, on conflict do nothing" pattern
-- as 20260826030000_class_waitlist_notification_type.sql - what an
-- event's own waitlist promotion (utils/events.js's promoteNextWaitlisted)
-- notifies the registering account through, and what a Main Admin's
-- approve/reject decision on a member-submitted event notifies the
-- submitter through.
insert into notification_types (key, label, description) values
  ('event_waitlist_promoted', 'Moved Off Waitlist', 'A waitlisted event registration was promoted to confirmed because a spot opened up.'),
  ('event_submission_decided', 'Submitted Event Reviewed', 'A Main Admin approved or rejected an event a member submitted.')
on conflict (key) do nothing;
