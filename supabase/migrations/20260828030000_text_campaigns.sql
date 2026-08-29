-- Communication > Text tab (item 13) - a real request: "text tab should
-- have the same structure as email but simpler, a text box with a 50
-- word cap." Same filtered-member-list/select-all-none/compose/send-or-
-- schedule structure as Communication > Email (utils/emailComposer.js's
-- own listRecipientCandidates() is reused as-is - the filter facets are
-- identical), but text_campaigns has no subject or reply_to column since
-- a text message is just a short plain-text body, not an email.
insert into notification_types (key, label, description) values
  ('text_message', 'Text Message', 'A short text Main Admin or Co-op Admin sent to a filtered list of members.')
on conflict (key) do nothing;

create table if not exists text_campaigns (
  id integer generated always as identity primary key,
  body text not null,
  recipient_account_ids text not null default '[]',
  recipient_count integer not null default 0,
  status text not null default 'sent' check (status in ('scheduled', 'sent')),
  scheduled_at text,
  sent_at text,
  sent_by_portal text not null check (sent_by_portal in ('main_admin', 'coop_admin')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_text_campaigns_created on text_campaigns(created_at desc);
