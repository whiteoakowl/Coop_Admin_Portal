-- Communication > Email tab (item 12) - a real request: "there should be
-- a filter that filters the member list by section, role, if there
-- registered for classes or not, age group, grade level, parent,
-- student, teacher etc, select all, select none... create email button
-- takes you to a new screen where you can compose... reply to box...
-- option to send right away or schedule for later." Reuses the same
-- notification_types/notifications plumbing utils/announcements.js and
-- utils/newsletter.js already use (an email IS a notification, same as
-- announcement/newsletter_sent already are) rather than a parallel send
-- mechanism.
--
-- email_campaigns is the record of a composed send, mirroring
-- newsletter_issues' own status/scheduled_at/sent_at shape (supabase/
-- migrations/20260825100000_newsletter.sql) - "Schedule" saves a row with
-- status='scheduled' and no dispatch yet (no real cron/vendor is wired up
-- anywhere in this app - see utils/emailProvider.js's own header comment
-- - so, same as a scheduled newsletter issue, nothing sends automatically
-- until an admin manually sends it). recipient_account_ids is a JSON
-- array captured at compose time (from the filtered/checked member list)
-- so a scheduled send still reaches exactly who was selected, even if the
-- filters would produce a different list by the time it's actually sent.
insert into notification_types (key, label, description) values
  ('email_campaign', 'Email', 'A targeted email Main Admin or Co-op Admin sent to a filtered list of members.')
on conflict (key) do nothing;

create table if not exists email_campaigns (
  id integer generated always as identity primary key,
  subject text not null,
  body_html text not null,
  reply_to text,
  recipient_account_ids text not null default '[]',
  recipient_count integer not null default 0,
  status text not null default 'sent' check (status in ('scheduled', 'sent')),
  scheduled_at text,
  sent_at text,
  sent_by_portal text not null check (sent_by_portal in ('main_admin', 'coop_admin')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_email_campaigns_created on email_campaigns(created_at desc);
