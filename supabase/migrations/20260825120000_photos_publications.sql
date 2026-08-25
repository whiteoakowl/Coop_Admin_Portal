-- Community & Commerce track (Track B), item 12: Photos/Albums and
-- Publications/Articles.
--
-- Photo privacy is deliberate, not incidental: visibility defaults to
-- 'members' on both an album and (redundantly, on purpose) its own
-- uploaded files being served through an authenticated route rather
-- than a public bucket/local-disk URL - a photo with children in it
-- must never become public just because it was uploaded, per the
-- handoff's own instruction. 'public' is available but is an explicit,
-- separate choice an admin has to make on the album, not a default.
-- Publications share the same visibility column and the same reasoning
-- - an article isn't automatically public just because Publications
-- exists as a feature.
create table if not exists photo_albums (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  visibility text not null default 'members' check (visibility in ('members', 'public')),
  cover_image_key text,
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

create table if not exists photo_album_photos (
  id integer generated always as identity primary key,
  album_id integer not null references photo_albums(id) on delete cascade,
  image_key text not null,
  caption text,
  uploaded_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text()
);
create index if not exists idx_photo_album_photos_album on photo_album_photos(album_id);

create table if not exists publications (
  id integer generated always as identity primary key,
  title text not null,
  body_html text not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  visibility text not null default 'members' check (visibility in ('members', 'public')),
  published_at text,
  author_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
