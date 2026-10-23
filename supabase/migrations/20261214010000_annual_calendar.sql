-- A real request: "Main admin portal, add a tab called annual calendar.
-- This calendar will work similar to the family school management
-- attendance calendar where you can click on the dates to change the
-- color... Dropdown menu for each fiscal year created in the system. Can
-- create a calendar for each fiscal year. Create key button. Be able to
-- add a label and color for each key item... Be able to click each key
-- then click on the calendar dates to color/key each one that particular
-- key." One calendar per fiscal year (fiscal_years - see utils/events.js),
-- each calendar owns its own set of keys (a label+color pair, same shape
-- as event_categories) and its own colored dates, one key per date.
create table if not exists annual_calendars (
  id integer generated always as identity primary key,
  fiscal_year_id integer not null references fiscal_years(id) on delete cascade,
  created_at text not null default now_text(),
  unique (fiscal_year_id)
);

create table if not exists annual_calendar_keys (
  id integer generated always as identity primary key,
  calendar_id integer not null references annual_calendars(id) on delete cascade,
  label text not null,
  color text not null default '#EE9A4D',
  position integer not null default 0,
  created_at text not null default now_text()
);

create table if not exists annual_calendar_days (
  id integer generated always as identity primary key,
  calendar_id integer not null references annual_calendars(id) on delete cascade,
  day_date text not null,
  key_id integer references annual_calendar_keys(id) on delete set null,
  updated_at text not null default now_text(),
  unique (calendar_id, day_date)
);
