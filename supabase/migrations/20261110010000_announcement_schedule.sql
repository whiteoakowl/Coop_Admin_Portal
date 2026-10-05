-- A real request: "send announcement should say send announcements
-- now. Button next to it should say schedule for later. That button
-- allows you to pick a date and time to send." Same "schedule saves it,
-- an admin still has to press Send" shape utils/emailComposer.js's own
-- email_campaigns/utils/textComposer.js's own text_campaigns already
-- use - nothing in this app wakes up and sends on a timer.
alter table announcement_log add column if not exists status text not null default 'sent' check (status in ('scheduled', 'sent'));
alter table announcement_log add column if not exists scheduled_at text;
alter table announcement_log add column if not exists sent_at text;

-- Every existing row was already a real, immediate send.
update announcement_log set sent_at = created_at where sent_at is null and status = 'sent';
