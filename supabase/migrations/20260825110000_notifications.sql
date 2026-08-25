-- Community & Commerce track (Track B), item 11: SMS/text notification
-- framework, sharing one underlying "notification" concept with the
-- in-app Notification Center rather than being two unrelated systems -
-- per the handoff's own suggestion. A notification has a type, a
-- recipient, and gets attempted across one or more delivery channels
-- (in_app/email/sms).
--
-- notification_types is the admin-controlled catalog of what kinds of
-- notification the app can generate (seeded below from features that
-- already exist - Newsletter sends, event registration confirmations,
-- forum replies) - not a placeholder list, every key here has a real
-- caller in utils/. auto_send_enabled is the "admin control over which
-- message types actually send automatically" the handoff calls for: a
-- Main Admin can turn a type off without touching code.
create table if not exists notification_types (
  key text primary key,
  label text not null,
  description text not null,
  auto_send_enabled integer not null default 1
);

-- A member's own per-type, per-channel opt-out. Only override rows are
-- stored (like an allowlist would over-store) - an account with no row
-- for a given (type, channel) is enabled by default, matching how a
-- brand-new member should receive notifications without first visiting
-- a settings page. in_app can't be disabled here - the Notification
-- Center itself has no separate opt-out, only email/sms do.
create table if not exists notification_preferences (
  id integer generated always as identity primary key,
  member_account_id integer not null references member_accounts(id) on delete cascade,
  type_key text not null references notification_types(key) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  enabled integer not null default 0,
  unique (member_account_id, type_key, channel)
);

-- One row per notification actually generated for a recipient - this is
-- the Notification Center's own data, read_at is what "unread" means
-- there. link_url is optional context (e.g. the event or thread this is
-- about).
create table if not exists notifications (
  id integer generated always as identity primary key,
  member_account_id integer not null references member_accounts(id) on delete cascade,
  type_key text not null references notification_types(key) on delete set null,
  title text not null,
  body text not null,
  link_url text,
  read_at text,
  created_at text not null default now_text()
);
create index if not exists idx_notifications_account on notifications(member_account_id, created_at desc);

-- One row per channel actually attempted for a notification (in_app is
-- always attempted and always succeeds by construction - it's just the
-- notifications row existing). email/sms go through utils/
-- emailProvider.js / utils/smsProvider.js - provider ABSTRACTIONS, same
-- reasoning utils/payments.js already established for not integrating a
-- real payment processor and utils/newsletter.js for not wiring a real
-- outbound email send: no SMS vendor (Twilio or otherwise) or email
-- vendor is configured anywhere in this app, so every email/sms
-- delivery here records status='skipped' with why, rather than
-- pretending to have sent something real.
create table if not exists notification_deliveries (
  id integer generated always as identity primary key,
  notification_id integer not null references notifications(id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email', 'sms')),
  status text not null check (status in ('sent', 'skipped', 'failed')),
  detail text,
  created_at text not null default now_text()
);
create index if not exists idx_notification_deliveries_notification on notification_deliveries(notification_id);

-- Seed the catalog itself - every key here has a real caller (see
-- utils/newsletter.js's markSent(), routes/events.js's registration
-- handler, routes/forums.js's reply handler), never a placeholder type
-- with nothing that actually generates it.
insert into notification_types (key, label, description) values
  ('newsletter_sent', 'Newsletter Sent', 'A weekly newsletter issue was sent.'),
  ('event_registration', 'Event Registration', 'Confirmation that a family member is registered for an event.'),
  ('forum_reply', 'Forum Reply', 'Someone replied to a thread you started.')
on conflict (key) do nothing;
