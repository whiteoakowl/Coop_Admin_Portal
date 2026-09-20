-- Run this once in the Supabase dashboard's SQL Editor (Project ->
-- SQL Editor -> New query -> paste -> Run) to fix "Supabase bucket not
-- found" when uploading a Shop product photo.
--
-- Not a regular app migration (supabase/migrations/*.sql) on purpose:
-- those run automatically against every environment, including the test
-- suite's in-memory Postgres, which has no `storage` schema at all - this
-- only makes sense run by hand, once, against your real Supabase project.
-- Same idea as the app's other public buckets (member-photos, membership-
-- child-photos, name-tag-images, schedule-card-images - see MIGRATION.md)
-- which were likewise created by hand, never by an app migration.

-- 1. Create the bucket the app already expects (routes/admin-store.js /
--    routes/store.js's own STORE_IMAGES_BUCKET = 'store-images'), public
--    so a product photo's URL works directly in an <img src> with no
--    login required - same as every other product-photo-style bucket.
insert into storage.buckets (id, name, public)
values ('store-images', 'store-images', true)
on conflict (id) do update set public = true;

-- 2. Explicit public-read policy - a public bucket already serves reads
--    with no RLS check at its own /storage/v1/object/public/... URL, but
--    this makes the intent explicit and keeps working if the bucket is
--    ever flipped back to private by mistake.
drop policy if exists "Public read access for store-images" on storage.objects;
create policy "Public read access for store-images"
  on storage.objects for select
  using (bucket_id = 'store-images');

-- 3. Uploads/deletes from this app always go through the server's own
--    service_role key (see utils/storage.js's createStorageClient),
--    which already bypasses RLS entirely - so no write policy is
--    strictly required for the app itself to work. This one is only
--    here so an authenticated Supabase user (outside this app) could
--    also manage files in this bucket if you ever need that; delete it
--    if you don't want that door open at all.
drop policy if exists "Authenticated users can manage store-images" on storage.objects;
create policy "Authenticated users can manage store-images"
  on storage.objects for all
  using (bucket_id = 'store-images' and auth.role() = 'authenticated')
  with check (bucket_id = 'store-images' and auth.role() = 'authenticated');
