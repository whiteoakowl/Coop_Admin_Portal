-- Community & Commerce track (Track B), item 13: Audit Log.
-- who/what/when/what-record for meaningful admin actions - threaded
-- through real actions in already-built features (financial changes in
-- Accounting, deletions and moderation across Store/Custom Forms/Events/
-- Directory/Classifieds/Newsletter/Photos/Publications, admin settings
-- changes in Notifications), not bolted on generically with nothing
-- real to log. Forums already has its own dedicated moderation log
-- (forum_moderation_log, item 6) with its own per-thread/post context
-- and admin view - this table deliberately does not duplicate it.
--
-- Role/permission changes (also called out in the handoff as worth
-- auditing) live in routes/main-admin.js, which is off-limits to this
-- track - see TEAM_B_HANDOFF.md's own hard boundaries.
create table if not exists audit_log (
  id integer generated always as identity primary key,
  actor_account_id integer references member_accounts(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id integer,
  detail text,
  created_at text not null default now_text()
);
create index if not exists idx_audit_log_created on audit_log(created_at desc);
