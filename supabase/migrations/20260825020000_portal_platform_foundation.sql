-- Foundation for the new multi-portal platform (Public site, Parent,
-- Student, Teacher, Co-op Admin, and Main Admin portals) built on top of
-- the existing operational co-op app.
--
-- members already has a set of "Vestigial" portal-login columns
-- (username, password_hash, portal_parent, portal_student,
-- portal_coop_admin - see db/schema.sql's own comment) from an earlier
-- member-login feature that was removed sitewide. Those are left exactly
-- as documented (untouched, dead) rather than reused here: they only
-- support three fixed boolean flags with no real role/permission model
-- and no account-status/approval workflow, which the new platform
-- explicitly needs (a person can hold several roles, Main Admin controls
-- granular capabilities, self-registration needs an approval queue).
--
-- member_accounts is the new login layer, one-to-one with an existing
-- members row - a member's profile, family, photo, and medical data stay
-- exactly where they already live; this table only ever holds
-- credentials and account status. roles/permissions/role_permissions/
-- member_account_roles form a standard RBAC model: a role (e.g. "parent",
-- "teacher") grants both direct PORTAL access and, via role_permissions,
-- a set of finer-grained capability strings a route can check without
-- ever hard-coding "if role = X" - see middleware/portalAuth.js.

create table if not exists member_accounts (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  email text not null unique,
  password_hash text not null,
  -- 'pending': self-registered, awaiting a Main Admin's review before any
  -- role/portal access is usable. 'active': can log in and use whatever
  -- roles they hold. 'suspended': login blocked without losing role
  -- history, for an admin temporarily revoking access.
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  created_at text not null default now_text(),
  approved_at text,
  approved_by_account_id integer references member_accounts(id) on delete set null,
  last_login_at text
);
create index if not exists idx_member_accounts_status on member_accounts(status);

-- A role both grants access to a named portal (its own key doubles as the
-- portal identifier the new portal switcher/middleware checks) and,
-- through role_permissions, a bundle of finer-grained capabilities. Kept
-- as real rows (not a fixed enum) so a Main Admin can define additional
-- roles later without a schema change - is_system just protects the five
-- starter roles from being renamed/deleted out from under the portal
-- switcher's own routing.
create table if not exists roles (
  id integer generated always as identity primary key,
  key text not null unique,
  label text not null,
  description text,
  is_system integer not null default 0,
  created_at text not null default now_text()
);

-- A fixed catalog of capability strings a Main Admin can grant to any
-- role (see role_permissions) - deliberately a flat list rather than
-- hard-coding "if role === 'main_admin'" throughout the app, so a future
-- portal/feature only ever needs to add a new row here plus real
-- requirePortalPermission(key) checks at its own routes, never a change
-- to every existing route that already checks permissions.
create table if not exists permissions (
  id integer generated always as identity primary key,
  key text not null unique,
  label text not null,
  description text
);

create table if not exists role_permissions (
  role_id integer not null references roles(id) on delete cascade,
  permission_id integer not null references permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

-- A member account can hold more than one role at once (e.g. Parent +
-- Teacher) - the portal switcher lists exactly the portals their current
-- roles grant, and every portal route re-checks this server-side
-- (middleware/portalAuth.js), never trusting a client-supplied portal
-- name.
create table if not exists member_account_roles (
  member_account_id integer not null references member_accounts(id) on delete cascade,
  role_id integer not null references roles(id) on delete cascade,
  granted_at text not null default now_text(),
  granted_by_account_id integer references member_accounts(id) on delete set null,
  primary key (member_account_id, role_id)
);

-- Site-wide public homepage text, one singleton row - the parts of the
-- new public website a Main Admin can edit without touching code
-- (org name/tagline, hero copy, meeting schedule, contact info). A full
-- drag-and-drop page builder is real future scope, not this pass; this
-- covers the actual copy that matters on day one.
create table if not exists site_settings (
  id integer primary key default 1 check (id = 1),
  org_name text not null default 'Sanford Homeschoolers',
  tagline text not null default 'A welcoming homeschool co-op for families who want more.',
  hero_heading text not null default 'A homeschool community built on connection',
  hero_body text not null default 'We meet weekly for classes, friendship, and support - come see what co-op life is all about.',
  meeting_schedule_text text not null default 'Mondays & Wednesdays, during the school year',
  about_body text not null default 'Sanford Homeschoolers is a parent-led homeschool co-op offering classes, activities, and community for homeschooling families of all backgrounds.',
  benefits_body text not null default 'Small classes taught by parents and volunteers, a supportive community, and a reliable weekly rhythm for your homeschool.',
  contact_email text,
  contact_phone text,
  updated_at text not null default now_text()
);
insert into site_settings (id) values (1) on conflict (id) do nothing;

-- Admin-authored announcements, shared across the public homepage (only
-- rows with is_public = 1) and every authenticated portal's own
-- dashboard (every active, non-expired announcement, public or not) -
-- one system instead of a separate "public news" and "member news"
-- table that would inevitably drift apart.
create table if not exists announcements (
  id integer generated always as identity primary key,
  title text not null,
  body text not null,
  is_public integer not null default 0,
  published_at text not null default now_text(),
  expires_at text,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_announcements_published on announcements(published_at);

create table if not exists faqs (
  id integer generated always as identity primary key,
  question text not null,
  answer text not null,
  position integer not null default 0,
  is_public integer not null default 1,
  created_at text not null default now_text()
);

-- Registration-facing extensions to the EXISTING classes table, not a
-- parallel "course" model - a class is still exactly one row in
-- `classes`, this just adds what the Parent Portal's own registration
-- flow needs on top of the scheduling fields already there.
-- registration_open is a simple global per-class toggle for this pass -
-- staged, group-targeted registration windows (teachers first, then
-- certain families, then everyone) are real future scope, intentionally
-- not built here.
alter table classes add column if not exists capacity integer;
alter table classes add column if not exists registration_open integer not null default 0;
alter table classes add column if not exists description text;

-- One row per parent-initiated registration action, kept as its own
-- audit trail distinct from class_enrollments itself (which only ever
-- reflects CURRENT enrollment - a cancelled/waitlisted registration
-- still needs to be visible in "my registration history").
create table if not exists class_registrations (
  id integer generated always as identity primary key,
  class_id integer not null references classes(id) on delete cascade,
  student_id integer not null references members(id) on delete cascade,
  registered_by_account_id integer not null references member_accounts(id) on delete cascade,
  status text not null default 'confirmed' check (status in ('confirmed', 'waitlisted', 'cancelled')),
  created_at text not null default now_text(),
  cancelled_at text
);
create index if not exists idx_class_registrations_class on class_registrations(class_id);
create index if not exists idx_class_registrations_student on class_registrations(student_id);
