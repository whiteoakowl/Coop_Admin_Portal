-- A real request: "add a check box permission for members can add
-- photos. If that box is not checked than the album will be view only
-- on parent and student portals." Member uploads used to be allowed on
-- every album unconditionally - this makes it an explicit, per-album,
-- admin-set choice, off by default (same "safer default" reasoning as
-- this table's own visibility column).
alter table photo_albums add column if not exists allow_member_uploads integer not null default 0;

-- "Add archive subpage under photos tab" - same active/archived shape
-- Business Directory/Classifieds/Shop already use.
alter table photo_albums add column if not exists status text not null default 'active' check (status in ('active', 'archived'));
