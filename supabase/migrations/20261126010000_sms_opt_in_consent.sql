-- SMS opt-in consent (10DLC compliance) - a real Telnyx campaign review
-- rejection: "add a link/screenshot of the opt-in form... showing the
-- phone number field and full SMS opt-in language" - the public /register
-- form had no phone field and no SMS consent checkbox at all. Recorded
-- once, at the point of registration (the actual "opt-in form" carriers
-- want to see), separate from notification_preferences' per-notification-
-- type sms/email toggles, which only exist for an already-active account.
alter table members add column if not exists sms_consent boolean not null default false;
alter table members add column if not exists sms_consent_at text;
