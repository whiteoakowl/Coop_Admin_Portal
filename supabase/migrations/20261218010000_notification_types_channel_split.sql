-- A real request: "Main admin portal, settings gear, notifications.
-- Each popup will have check boxes in a single column for email or text
-- settings." notification_types.auto_send_enabled was a single combined
-- on/off flag with no way to turn email off while keeping text on (or
-- vice versa) - splitting it into two independent columns is what the
-- new per-type popup actually needs to save. Both default to 1 (on),
-- backfilled from the old single flag so existing behavior is unchanged
-- for every type until an admin explicitly narrows one down.
alter table notification_types add column if not exists auto_send_email_enabled integer not null default 1;
alter table notification_types add column if not exists auto_send_sms_enabled integer not null default 1;

update notification_types set auto_send_email_enabled = auto_send_enabled, auto_send_sms_enabled = auto_send_enabled;

alter table notification_types drop column if exists auto_send_enabled;
