-- Babysitter Directory - a real request: "Add a Babysitter directory. It
-- should appear on parent portal to view directory. Parents can view or
-- create a profile for their child as well to be a babysitter. Requests
-- are sent for approval to main admin. Students can also create their
-- own baby sitter profile on the student portal, submit for approval for
-- any changes or submissions." One profile per member (a family's own
-- teen, or the student themselves) - never a new "babysitter" identity
-- separate from the existing members table, the same "don't invent a
-- parallel person record" rule every other feature in this app follows.
--
-- EVERY submission and edit needs Main Admin approval (confirmed with
-- the requester) - status resets to 'pending' on any edit, the same
-- "an edit is really just a new submission" rule as most moderation
-- queues, rather than letting an edit silently bypass review.
create table if not exists babysitter_profiles (
  id integer generated always as identity primary key,
  member_id integer not null unique references members(id) on delete cascade,
  age_grade text,
  availability text,
  experience text,
  certifications text,
  hourly_rate text,
  contact_method text,
  -- Local-disk or Supabase Storage key (utils/storage.js's own
  -- convention), proxied through routes/babysitters.js's own
  -- authenticated /babysitters/:id/photo route - never a public bucket
  -- URL, same reasoning as routes/photos.js.
  photo_key text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  decided_at text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_babysitter_profiles_status on babysitter_profiles(status);

insert into notification_types (key, label, description) values
  ('babysitter_submission_decided', 'Babysitter Profile Reviewed', 'A Main Admin approved or rejected a babysitter profile submission or edit.')
on conflict (key) do nothing;
