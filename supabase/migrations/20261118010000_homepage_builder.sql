-- A real request: "Main admin portal. Settings gear, website. Should say
-- public homepage. Here you can edit the entire homepage like you would
-- on Spotify or wix. Drag and drop images and text of different size
-- choices. Add buttons and links." Replaces the old fixed Hero/About/Why
-- Families Join Us sections (each a single hardcoded textarea on
-- site_settings) with an ordered list of content blocks the admin can
-- add, edit, delete, and drag-reorder freely - same "replace a few fixed
-- fields with a flexible ordered list" shape as event_sections/
-- lesson_content_items elsewhere in this schema, just for the public
-- homepage's own body content.
create table if not exists homepage_blocks (
  id integer generated always as identity primary key,
  position integer not null default 0,
  block_type text not null check (block_type in ('text', 'image', 'button')),
  -- 'text' block fields.
  text_body text,
  text_size text check (text_size in ('small', 'medium', 'large')),
  -- 'image' block fields. image_key is a Supabase Storage object key (see
  -- utils/storage.js) or a local-disk filename under public/uploads/
  -- homepage/ - same storage-backend-agnostic shape every other image
  -- column in this app already uses (events.image_key, etc.).
  image_key text,
  image_size text check (image_size in ('small', 'medium', 'large', 'full')),
  image_alt text,
  -- 'button' block fields.
  button_label text,
  button_url text,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);
create index if not exists idx_homepage_blocks_position on homepage_blocks(position);

-- One-time seed from whatever the old fixed Hero/About/Benefits fields
-- already held, so upgrading to the block builder doesn't blank out an
-- existing live homepage - same reasoning as any other "replace a fixed
-- field with a flexible list" migration in this app. Gated on the whole
-- table being empty (checked once, not per-insert) so this only ever
-- seeds once, on the very first boot after this migration lands, and
-- never reseeds or duplicates on every later boot.
do $$
begin
  if not exists (select 1 from homepage_blocks) then
    insert into homepage_blocks (position, block_type, text_body, text_size)
      select 0, 'text', s.hero_heading, 'large' from site_settings s where s.id = 1;
    insert into homepage_blocks (position, block_type, text_body, text_size)
      select 1, 'text', s.hero_body, 'medium' from site_settings s where s.id = 1;
    insert into homepage_blocks (position, block_type, button_label, button_url)
      values (2, 'button', 'Become a Member', '/register');
    insert into homepage_blocks (position, block_type, text_body, text_size)
      select 3, 'text', s.meeting_schedule_text, 'small' from site_settings s where s.id = 1;
    insert into homepage_blocks (position, block_type, text_body, text_size)
      values (4, 'text', 'About Us', 'large');
    insert into homepage_blocks (position, block_type, text_body, text_size)
      select 5, 'text', s.about_body, 'medium' from site_settings s where s.id = 1;
    insert into homepage_blocks (position, block_type, text_body, text_size)
      values (6, 'text', 'Why Families Join Us', 'large');
    insert into homepage_blocks (position, block_type, text_body, text_size)
      select 7, 'text', s.benefits_body, 'medium' from site_settings s where s.id = 1;
  end if;
end $$;
