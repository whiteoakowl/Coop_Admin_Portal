-- Run this once in the Supabase dashboard's SQL Editor (Project -> SQL
-- Editor -> New query -> paste -> Run) to fix "something went wrong"
-- uploading a photo album's cover photo or gallery photos. Same root
-- cause as supabase/create-class-event-store-images-buckets.sql's own
-- header comment documents for Class/Event/Shop photos: routes/admin-
-- photos.js calls utils/storage.js's uploadFile() against a bucket
-- ('private-photos') that was never actually created in Supabase, so the
-- upload throws and the app's generic error handler shows "something
-- went wrong" instead of the real "Bucket not found" reason.
--
-- Private, unlike those three - routes/photos.js never hands out a public
-- Storage URL for an album photo (even a 'public' visibility album is
-- still proxied through this app's own /photos/:albumId/image/:photoId
-- route, which enforces that album's own visibility rule before
-- streaming the bytes - see routes/admin-photos.js's own header comment
-- on why). Only the service role (this app's own server-side
-- SUPABASE_SERVICE_ROLE_KEY client) can read or write it; there is no
-- anon/authenticated policy here on purpose.
--
-- Not a regular app migration (supabase/migrations/*.sql) on purpose -
-- see that same header comment for why: those run automatically against
-- every environment including the test suite's in-memory Postgres, which
-- has no `storage` schema at all.
insert into storage.buckets (id, name, public)
values ('private-photos', 'private-photos', false)
on conflict (id) do update set public = false;
