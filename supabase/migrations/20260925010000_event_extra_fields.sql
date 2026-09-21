-- A real request: "volunteers, food, donations and extra fields tabs
-- should be under one tab called, Volunteers... Extra fields is where
-- you can add extra form type questions for people signing up for an
-- event." A per-event custom question (text/textarea/select/checkbox),
-- answered once per registration - see utils/events.js's own comment on
-- why this is separate from the existing standalone Custom Forms feature.

create table if not exists event_extra_fields (
  id integer generated always as identity primary key,
  event_id integer not null references events(id) on delete cascade,
  label text not null,
  field_type text not null default 'text' check (field_type in ('text', 'textarea', 'select', 'checkbox')),
  options text,
  required integer not null default 0,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_event_extra_fields_event on event_extra_fields(event_id);

create table if not exists event_registration_answers (
  id integer generated always as identity primary key,
  registration_id integer not null references event_registrations(id) on delete cascade,
  extra_field_id integer not null references event_extra_fields(id) on delete cascade,
  value text,
  created_at text not null default now_text(),
  unique (registration_id, extra_field_id)
);
create index if not exists idx_event_registration_answers_registration on event_registration_answers(registration_id);
