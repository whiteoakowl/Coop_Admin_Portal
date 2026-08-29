-- Create New Event wizard (Main Admin) - a real request: match a
-- reference mockup's 5-step event-creation flow (Details / Date & Time /
-- Location / Tickets / Additional). Most of that mockup's fields already
-- exist on `events` from earlier migrations (title, description,
-- category, location, dates, capacity, pricing, age_group, sections); the
-- ones that don't are added here. No uniqueness constraint on slug - this
-- app has no public "/events/:slug" route yet, so it's a plain editable
-- field, not a routing key.
alter table events add column if not exists slug text;
alter table events add column if not exists event_type text;
alter table events add column if not exists short_description text;
alter table events add column if not exists language text;
alter table events add column if not exists organized_by text;
alter table events add column if not exists tags text;
