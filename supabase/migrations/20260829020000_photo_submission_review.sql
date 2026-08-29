-- Main Admin homepage (item 6) - "a 2nd count display for pending
-- requests such as... photo submissions... each name should be able to
-- click and go straight to that request page to view and approve
-- submissions." routes/photos.js already lets any signed-in portal
-- account upload photos straight into a shared album with zero review
-- step - a real gap once the homepage is claiming there's something to
-- approve. status defaults to 'approved' so every existing row and every
-- admin-added photo (routes/admin-photos.js) is unaffected; only the
-- member self-serve upload route sets 'pending' going forward.
alter table photo_album_photos add column if not exists status text not null default 'approved' check (status in ('pending', 'approved', 'rejected'));
