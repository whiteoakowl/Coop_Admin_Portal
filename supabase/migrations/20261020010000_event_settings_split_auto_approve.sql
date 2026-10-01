-- A real request: "Main admin, events, settings, under allow families to
-- submit events calendar events? It should just say yes or no.
-- Automatically approve event member submit, yes or no, should be it's
-- own question." event_settings.family_submit_events used to be a 3-way
-- enum ('yes', 'auto_approve', 'no') cramming two separate yes/no
-- questions into one radio group - split into its own independent
-- boolean column instead, same integer-boolean shape every other
-- checkbox-backed column on this table already uses (show_waitlist_
-- position, credit_on_family_cancel, etc.). Any row already set to
-- 'auto_approve' keeps meaning exactly what it did before: submissions
-- allowed AND auto-approved.
alter table event_settings add column if not exists auto_approve_family_submissions integer not null default 0;
update event_settings set auto_approve_family_submissions = 1, family_submit_events = 'yes' where family_submit_events = 'auto_approve';
alter table event_settings drop constraint if exists event_settings_family_submit_events_check;
alter table event_settings add constraint event_settings_family_submit_events_check check (family_submit_events in ('yes', 'no'));
