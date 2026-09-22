-- Run this once in the Supabase dashboard's SQL Editor (Project -> SQL
-- Editor -> New query -> paste -> Run) to fix "Supabase bucket not
-- found" when uploading a Class photo, an Event photo, or a Shop product
-- photo. Combines the three separate create-*-images-bucket.sql files in
-- this folder into one script so all three can be fixed in a single run;
-- each one is still safe to run on its own too, if you only need one.
--
-- Not a regular app migration (supabase/migrations/*.sql) on purpose:
-- those run automatically against every environment, including the test
-- suite's in-memory Postgres, which has no `storage` schema at all - this
-- only makes sense run by hand, once, against your real Supabase project.
-- Same idea as the app's other public buckets (member-photos, membership-
-- child-photos, name-tag-images, schedule-card-images - see MIGRATION.md)
-- which were likewise created by hand, never by an app migration.
--
-- If uploads still fail after running this, the other likely cause is
-- SUPABASE_SERVICE_ROLE_KEY not being set in your deployed environment's
-- variables (only SUPABASE_URL) - without it, utils/storage.js's
-- createStorageClient() returns null and the app silently falls back to
-- writing to local disk, which doesn't persist on most hosting.

-- ===== Class photos (utils/classSchedule.js's CLASS_IMAGES_BUCKET) =====
insert into storage.buckets (id, name, public)
values ('class-images', 'class-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public read access for class-images" on storage.objects;
create policy "Public read access for class-images"
  on storage.objects for select
  using (bucket_id = 'class-images');

drop policy if exists "Authenticated users can manage class-images" on storage.objects;
create policy "Authenticated users can manage class-images"
  on storage.objects for all
  using (bucket_id = 'class-images' and auth.role() = 'authenticated')
  with check (bucket_id = 'class-images' and auth.role() = 'authenticated');

-- ===== Event photos (routes/admin-events.js's EVENT_IMAGES_BUCKET) =====
insert into storage.buckets (id, name, public)
values ('event-images', 'event-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public read access for event-images" on storage.objects;
create policy "Public read access for event-images"
  on storage.objects for select
  using (bucket_id = 'event-images');

drop policy if exists "Authenticated users can manage event-images" on storage.objects;
create policy "Authenticated users can manage event-images"
  on storage.objects for all
  using (bucket_id = 'event-images' and auth.role() = 'authenticated')
  with check (bucket_id = 'event-images' and auth.role() = 'authenticated');

-- ===== Shop product photos (routes/admin-store.js's STORE_IMAGES_BUCKET) =====
insert into storage.buckets (id, name, public)
values ('store-images', 'store-images', true)
on conflict (id) do update set public = true;

drop policy if exists "Public read access for store-images" on storage.objects;
create policy "Public read access for store-images"
  on storage.objects for select
  using (bucket_id = 'store-images');

drop policy if exists "Authenticated users can manage store-images" on storage.objects;
create policy "Authenticated users can manage store-images"
  on storage.objects for all
  using (bucket_id = 'store-images' and auth.role() = 'authenticated')
  with check (bucket_id = 'store-images' and auth.role() = 'authenticated');
