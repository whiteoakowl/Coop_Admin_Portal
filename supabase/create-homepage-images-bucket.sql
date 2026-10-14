-- Run this once in the Supabase dashboard's SQL Editor (Project ->
-- SQL Editor -> New query -> paste -> Run) to fix "Supabase bucket not
-- found" when uploading an image block on the Public Homepage builder
-- (Main Admin > Settings > Public Homepage).
--
-- Not a regular app migration (supabase/migrations/*.sql) on purpose:
-- those run automatically against every environment, including the test
-- suite's in-memory Postgres, which has no `storage` schema at all - same
-- idea as the app's other public buckets (event-images, store-images,
-- member-photos, ...) which were likewise created by hand, never by an
-- app migration. See supabase/create-event-images-bucket.sql for the
-- identical pattern this mirrors.

-- 1. Create the bucket the app already expects (utils/homepage.js's own
--    HOMEPAGE_IMAGES_BUCKET = 'homepage-images'), public so an image
--    block's URL works directly in an <img src> with no login required -
--    the public homepage is, by definition, public.
insert into storage.buckets (id, name, public)
values ('homepage-images', 'homepage-images', true)
on conflict (id) do update set public = true;

-- 2. Explicit public-read policy - a public bucket already serves reads
--    with no RLS check at its own /storage/v1/object/public/... URL, but
--    this makes the intent explicit and keeps working if the bucket is
--    ever flipped back to private by mistake.
drop policy if exists "Public read access for homepage-images" on storage.objects;
create policy "Public read access for homepage-images"
  on storage.objects for select
  using (bucket_id = 'homepage-images');

-- 3. Uploads/deletes from this app always go through the server's own
--    service_role key (see utils/storage.js's createStorageClient),
--    which already bypasses RLS entirely - so no write policy is
--    strictly required for the app itself to work. This one is only
--    here so an authenticated Supabase user (outside this app) could
--    also manage files in this bucket if you ever need that; delete it
--    if you don't want that door open at all.
drop policy if exists "Authenticated users can manage homepage-images" on storage.objects;
create policy "Authenticated users can manage homepage-images"
  on storage.objects for all
  using (bucket_id = 'homepage-images' and auth.role() = 'authenticated')
  with check (bucket_id = 'homepage-images' and auth.role() = 'authenticated');
