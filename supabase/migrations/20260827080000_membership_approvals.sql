-- A real request: "under members in main admin portal there should be a
-- tab that says approvals. this is where new membership requests
-- appear... each member line should have approve button, deny button
-- and trash can symbol to delete the request. there should be another
-- tab under main admin members that says settings. this will have an
-- approval and deny letter that can be edited by admin. these letters
-- are sent automatically went approve or deny buttons are clicked."
--
-- 'denied' is a new status alongside member_accounts' existing pending/
-- active/suspended - distinct from actually deleting the row (the trash
-- can button, routes/main-admin-members.js's own deleteApprovalRequest):
-- a denied request stays visible/auditable, just never grants portal
-- access (middleware/portalAuth.js's loadPortalSession only ever loads
-- an 'active' account, same as it already does for 'pending').
alter table member_accounts drop constraint if exists member_accounts_status_check;
alter table member_accounts add constraint member_accounts_status_check check (status in ('pending', 'active', 'suspended', 'denied'));

-- The admin-editable Approval/Denial letter text - a real request: "this
-- will have an approval and deny letter that can be edited by admin."
-- Two fixed rows (kind is the primary key, not an auto-id list like
-- admin_positions) since there are exactly two letters, ever - no
-- add/delete UI needed, just edit-in-place. {{name}} in the body is
-- substituted with the applicant's own name at send time (utils/
-- membershipApprovals.js's own renderTemplate).
create table if not exists membership_letter_templates (
  kind text primary key check (kind in ('approval', 'denial')),
  subject text not null,
  body text not null
);
insert into membership_letter_templates (kind, subject, body) values
  (
    'approval',
    'Welcome to Sanford Homeschoolers!',
    'Hi {{name}},

Great news - your membership request has been approved! You can now log in to the member portal with the email and password you registered with.

We''re so glad to have your family join us.

Welcome aboard!'
  ),
  (
    'denial',
    'About Your Membership Request',
    'Hi {{name}},

Thank you for your interest in Sanford Homeschoolers. After review, we''re unable to approve your membership request at this time.

If you have any questions, please reach out to an admin directly.'
  )
on conflict (kind) do nothing;

-- Same "insert into notification_types, on conflict do nothing" pattern
-- every other feature's own migration already uses (see utils/
-- notifications.js's own header comment) - the actual send happens
-- through the existing notify() entry point, no new delivery mechanism.
insert into notification_types (key, label, description) values
  ('membership_approved', 'Membership Approved', 'Your membership request was approved.'),
  ('membership_denied', 'Membership Request Denied', 'Your membership request was denied.')
on conflict (key) do nothing;
