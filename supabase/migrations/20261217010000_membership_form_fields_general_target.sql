-- A real request: "Main admin portal. Members. Settings. Extra form
-- fields. Add a general field section." The existing Membership Form
-- Fields settings tab (utils/membershipFormFields.js, see this table's
-- own creating migration) only split extra questions between the
-- Parent/Guardian block and the Student block - some admin-defined
-- questions (e.g. "How did you hear about us?") don't belong to either
-- repeatable section, they're asked once per application/member record.
-- Widens the target check constraint the same way 20260901020000_name_
-- tag_request_new_tag_type.sql already did for a different table.
alter table membership_form_fields drop constraint if exists membership_form_fields_target_check;
alter table membership_form_fields add constraint membership_form_fields_target_check
  check (target in ('parent', 'child', 'general'));
