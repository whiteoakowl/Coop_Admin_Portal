-- A real request: "adding a leader should be a drop down list of admin
-- positions. Choose an admin and the leaders name and email address
-- appears below," with a single leader per committee (not the existing
-- committee_positions/committee_signups shape, which is many-per-slot and
-- self-service). leader_member_id points straight at the chosen person
-- (resolved from whichever admin_positions they hold, at pick time) -
-- simpler than storing which position they were picked under, since all
-- the form ever needs afterward is that one member's own name/email.
-- leader_name/contact_info (the old free-text fields) stay untouched for
-- any committee created before this migration; the form just stops
-- offering them going forward.
alter table committees add column if not exists leader_member_id integer references members(id) on delete set null;

-- A real, separate request from the same conversation: "add a member
-- button" - a plain roster of people on a committee, independent of
-- committee_positions/committee_signups (that pair models a specific
-- named role with a slot count and self-service sign-up via a portal
-- account; this is just "this person is on this committee," added
-- directly by Main Admin, no slot or self-service involved).
create table if not exists committee_members (
  id integer generated always as identity primary key,
  committee_id integer not null references committees(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  created_at text not null default now_text(),
  unique (committee_id, member_id)
);
create index if not exists idx_committee_members_committee on committee_members(committee_id);
create index if not exists idx_committee_members_member on committee_members(member_id);
