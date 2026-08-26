-- A real, large request covering class registration: who is allowed to
-- register (parent-on-behalf-of-child, teacher/assistant self-signup,
-- student self-signup), how many teacher/assistant seats a class has,
-- a minimum enrollment (alongside the existing capacity as the max),
-- whether a member can cancel their own registration and whether that
-- refunds automatically, a waitlist position number, and a link from a
-- registration to the payment_charges row it created (if the class is
-- priced) so cancelling an unpaid registration can clear that charge.

alter table classes add column if not exists allow_parent_register integer not null default 1;
alter table classes add column if not exists allow_teacher_register integer not null default 1;
-- Defaults closed - "teachers and class assistants will be able to
-- register, but not the students until allowed" - a Main/Co-op Admin has
-- to explicitly open student self-registration per class.
alter table classes add column if not exists allow_student_register integer not null default 0;
alter table classes add column if not exists teacher_slots integer;
alter table classes add column if not exists assistant_slots integer;
alter table classes add column if not exists min_capacity integer;
alter table classes add column if not exists allow_cancel integer not null default 1;
alter table classes add column if not exists auto_refund_on_cancel integer not null default 0;
alter table classes add column if not exists price_cents integer;
alter table classes add column if not exists price_per text default 'person' check (price_per in ('person', 'family'));

-- A class restricted to specific sections - no rows at all means "every
-- member can see/register", same "empty means unrestricted" convention
-- as event_sections (see the events migration in this same batch).
create table if not exists class_sections (
  class_id integer not null references classes(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (class_id, section_id)
);
create index if not exists idx_class_sections_section on class_sections(section_id);

-- Which numbered spot in the waitlist a 'waitlisted' class_registrations
-- row holds - assigned at insert time (count of already-waitlisted rows
-- for that class + 1) and shifted down for everyone behind when an
-- earlier waitlisted registration is cancelled, so "you are #3 on the
-- waitlist" stays accurate as people ahead of you drop off. Null for a
-- 'confirmed' or 'cancelled' row - the number only ever means something
-- while actually waitlisted.
alter table class_registrations add column if not exists waitlist_position integer;
-- The payment_charges row this registration created, if the class was
-- priced at the time of registration - lets cancelling an unpaid
-- registration clear that same charge (see utils/payments.js's own
-- cancelCharge) instead of leaving an orphaned pending charge behind.
alter table class_registrations add column if not exists charge_id integer references payment_charges(id) on delete set null;

-- 'class_registration' joins 'store_order'/'event_registration'/'manual'
-- as a real charge source - same reasoning as event registrations, a
-- class registration fee is money owed by a member, recorded through the
-- exact same payment_charges/payment_payments abstraction (utils/
-- payments.js), never a parallel "did they pay for this class" flag.
alter table payment_charges drop constraint if exists payment_charges_source_type_check;
alter table payment_charges add constraint payment_charges_source_type_check
  check (source_type in ('store_order', 'event_registration', 'class_registration', 'manual'));
