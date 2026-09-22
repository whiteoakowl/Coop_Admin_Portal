-- A real request: "Main admin portal, settings gear icon, admins...
-- click on each admin position in the list and it will open an edit
-- window. Here you can add a member from the drop down list. Add email
-- address, add phone number. Then the roles and permissions are listed
-- below." Confirmed: permissions belong to the POSITION itself (not per
-- individual holder) - same shape role_permissions already uses for a
-- role (see 20260825020000_portal_platform_foundation.sql), just scoped
-- to an admin_position instead. The email/phone fields in that same edit
-- window are the member's own contact info (members.email/phone,
-- unchanged columns) shown/editable there for convenience, not separate
-- position-level fields - no schema change needed for those.
create table if not exists admin_position_permissions (
  admin_position_id integer not null references admin_positions(id) on delete cascade,
  permission_id integer not null references permissions(id) on delete cascade,
  primary key (admin_position_id, permission_id)
);
