-- A real request (Main Admin/Co-op Admin Communication > Email): "Email
-- also to, and a text bar" - raw extra address(es) to also reach,
-- independent of the filtered recipient list above (which only ever
-- resolves to existing member_accounts.id values - see utils/
-- emailComposer.js's own resolveRecipients()). Stored alongside reply_to
-- on the same campaign row rather than a separate table - it's a single
-- free-text field, not a structured/resolvable recipient.
alter table email_campaigns add column if not exists email_also_to text;
