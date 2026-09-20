-- A real request: "sql editor copy paste should be for event photo,
-- class photo and shop photo" - events (image_key, 20260825030000) and
-- store products (image_key, store migrations) already had a photo;
-- classes didn't. Same "one optional image per record" shape as those.
alter table classes add column if not exists image_key text;
