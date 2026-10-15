alter table member_admin_positions add column if not exists contact_email text;

-- Contact Admins is being reopened to the parent/student/teacher portals
-- (previously Co-op Admin only, sourced from the orphaned leadership_contacts
-- table). These columns let the page record who actually sent a message and
-- which resolved admin-position recipient email(s) it went to, so a future
-- admin-facing inbox view can show real sender/recipient info instead of
-- just the free-typed sender_email string.
alter table contact_admin_messages add column if not exists sender_name text;
alter table contact_admin_messages add column if not exists sender_member_id integer references members(id) on delete set null;
alter table contact_admin_messages add column if not exists recipient_email text;
