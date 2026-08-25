-- Community & Commerce track (Track B), item 10: Weekly Newsletter.
-- Content is auto-assembled from real, existing tables (events,
-- announcements, business directory) - see utils/newsletter.js's own
-- assembleContent() - and stored here only once generated, so it can be
-- hand-edited before sending without the source data drifting under it.
-- "Sending" itself is a status change, not a real email dispatch - this
-- app has no email provider configured anywhere, the same reasoning
-- item 9 (Accounting/Payments) already established for not integrating a
-- real payment processor: build the real workflow (assemble, edit,
-- preview, schedule, mark sent, keep a recipient count), stop short of
-- wiring an actual outbound send.

create table if not exists newsletter_issues (
  id integer generated always as identity primary key,
  subject text not null,
  body_html text not null,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sent')),
  scheduled_at text,
  sent_at text,
  -- A snapshot, not a live query result - "how many accounts would this
  -- have gone to" is meaningful history even after member counts change.
  recipient_count integer,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
