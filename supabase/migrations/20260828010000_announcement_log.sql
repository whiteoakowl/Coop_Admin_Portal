-- Real requests: "main admin and co-op admin announcements should be
-- communication... at the bottom of announcements it says past
-- announcements, where it lists the announcements that have been sent
-- and next to it it shows which portals it was sent to, date and time.
-- public homepage past announcements doesn't need its own section. They
-- all show us under the same past announcements log."
--
-- Both Co-op Admin's and Main Admin's own Announcements/Communication
-- pages (routes/admin-announcements.js, routes/main-admin-
-- announcements.js) already send through the same notify() mechanism
-- (Notification Center rows) or the same public `announcements` table -
-- neither one records which target(s) a single send actually went to,
-- so there was no reliable way to show "sent to Parent + Student" next
-- to a past send without re-deriving it from raw notification rows
-- (fragile - two different sends with the same title/body/timestamp
-- would collapse together). One row per send here instead, targets
-- stored as a JSON array of strings ('parent', 'student', 'public',
-- etc. - role keys, or the literal string 'public'/'everyone') so the
-- unified log can show it plainly regardless of which portal sent it or
-- what it went to.
create table if not exists announcement_log (
  id integer generated always as identity primary key,
  title text not null,
  body text not null,
  targets text not null,
  recipient_count integer not null default 0,
  sent_by_portal text not null check (sent_by_portal in ('main_admin', 'coop_admin')),
  created_at text not null default now_text()
);
create index if not exists idx_announcement_log_created on announcement_log(created_at desc);
