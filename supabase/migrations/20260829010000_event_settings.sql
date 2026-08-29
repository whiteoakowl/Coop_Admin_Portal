-- Main Admin > Events > Settings (item 9) - "add the settings exactly as
-- shown in the screenshots." One singleton settings row, same shape as
-- site_settings (20260825020000_portal_platform_foundation.sql): a Main
-- Admin can edit these without touching code. Several of these fields
-- (waitlist position visibility, credit adjustments, sub-admin role
-- scoping) don't have a system behind them yet in this app - they're
-- stored so the setting exists and is ready to wire up once that system
-- does, the same "controls X once a real feature exists" pattern the
-- newsletter's own weekly-send-schedule setting already uses. The ones
-- that do have something to control today (default calendar view, family
-- event submission gate + auto-approve, notification email, public-by-
-- default) are wired live in routes/admin-events.js and routes/events.js.
create table if not exists event_settings (
  id integer primary key default 1 check (id = 1),
  default_calendar_view text not null default 'list' check (default_calendar_view in ('calendar', 'list')),
  show_waitlist_position integer not null default 1,
  reminder_days_before integer not null default 10,
  credit_on_family_cancel integer not null default 0,
  credit_on_admin_cancel integer not null default 1,
  subadmin_edit_locations integer not null default 1,
  subadmin_edit_categories integer not null default 0,
  family_submit_events text not null default 'yes' check (family_submit_events in ('yes', 'auto_approve', 'no')),
  submit_notification_email text,
  family_manage_price_options integer not null default 0,
  family_manage_own_events integer not null default 1,
  family_events_public_default integer not null default 0,
  updated_at text not null default now_text()
);
insert into event_settings (id) values (1) on conflict (id) do nothing;

-- Categories screenshot table has an "Allow Sync" column per row.
alter table event_categories add column if not exists allow_sync integer not null default 1;

-- Item 11 - "attendance button on each line should go to a view exactly
-- like class check in/out... a roster grid view for manually changing
-- p, a, l." Event registrations only ever tracked binary checked_in_at/
-- checked_out_at (present or not) - same 3-state present/late/absent
-- shape utils/attendance.js's own class attendance already uses, added
-- here as its own column since check-in/out and a P/A/L call aren't the
-- same thing (a member can be checked in but still marked Late).
alter table event_registrations add column if not exists attendance_status text check (attendance_status in ('present', 'late', 'absent'));
alter table event_guest_registrations add column if not exists attendance_status text check (attendance_status in ('present', 'late', 'absent'));
