-- A real request: "On volunteer, donations and food signup pages there
-- should also be a question that says Require for each attendees or each
-- family. Radio buttons that say attendees, and family." Each of the 3
-- sections' own "how many items should be selected" setting (volunteer_
-- selection_count etc., see 20260901060000_event_guest_food_sections.sql)
-- already only ever applied loosely per the hint text ("each family/
-- individual registration") - this makes that choice explicit and
-- actually enforced (utils/events.js's registerForEvent). Defaults to
-- 'family' - the wording every section's existing hint text already used
-- before this setting existed.
alter table events add column if not exists volunteer_requirement_scope text not null default 'family' check (volunteer_requirement_scope in ('attendee', 'family'));
alter table events add column if not exists donation_requirement_scope text not null default 'family' check (donation_requirement_scope in ('attendee', 'family'));
alter table events add column if not exists food_requirement_scope text not null default 'family' check (food_requirement_scope in ('attendee', 'family'));
