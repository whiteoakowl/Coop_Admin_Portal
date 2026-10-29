-- A real request: "Click send text button... It should have an option
-- to upload a photo." Same optional-MMS-image column shape
-- notification_deliveries' own mediaUrl plumbing (utils/notify.js) and
-- the per-member/floater/setup-cleanup quick-text popups already pass
-- through to smsProvider.send() - text_campaigns (a bulk Communication >
-- Text send) never had anywhere to persist one before, so a scheduled
-- send had no way to carry its image through to sendScheduled().
alter table text_campaigns add column if not exists media_url text;
