-- Several real requests bundled into one class-edit reorganization:
--
-- "there shouldn't be a public and internal class description. just one
-- class description" - classes.notes (admin-only) and classes.description
-- (shown to parents) merge into a single classes.description, kept
-- parent-visible (the user's own call - see this migration's PR/session
-- notes). Existing notes content is intentionally NOT copied into
-- description - concatenating admin-only notes onto a field that's shown
-- to parents would leak whatever was written there for internal eyes only.
alter table classes drop column if exists notes;

-- "charged per dropdown, should list, students, students and teachers/
-- Assistants" - clarified: the existing Person/Family billing choice was
-- actually an EVENTS concept (siblings sharing one charge) that had
-- leaked onto the class form too; classes never actually support that
-- family-shared-charge behavior going forward (events keep their own,
-- separate person/family option, untouched by this migration). A class's
-- price_per now instead controls WHO gets charged at all: only the
-- enrolled students, or students AND any teacher/assistant who signs up
-- for it too (e.g. to help cover the cost of supplies) - see
-- utils/classRegistration.js's chargeForConfirmedRegistration and
-- routes/teacher-portal.js's own self-signup route.
-- Drop the OLD constraint (the pre-existing Person/Family check) before
-- the update below, not after - real production data still holding
-- legacy 'person'/'family' values would otherwise have the update itself
-- rejected by that old constraint before it ever got the chance to fix
-- the row up to a value the new constraint accepts.
alter table classes drop constraint if exists classes_price_per_check;
update classes set price_per = 'students' where price_per is null or price_per not in ('students', 'students_and_staff');
alter table classes alter column price_per set default 'students';
alter table classes add constraint classes_price_per_check check (price_per in ('students', 'students_and_staff'));

-- Mirrors class_registrations.charge_id (students) - lets a teacher/
-- assistant who paid to join a 'students_and_staff'-priced class have
-- that charge found and cancelled if they're later removed from the
-- roster, the same "don't leave an orphaned pending charge behind"
-- guarantee removeStaff already needs.
alter table class_staff add column if not exists charge_id integer references payment_charges(id) on delete set null;
