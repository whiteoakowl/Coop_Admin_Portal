-- A real request: "resource links should have add category button on
-- admin side. and add resource button. add resource button should pop
-- up with a window that asks for city and state, title, description and
-- website, category and save. list shows up categorized below. members
-- can submit resource links for approval. admin side should have tab
-- under resource links for approvals." Same admin-managed
-- add/delete-only category shape as admin_positions - see utils/
-- adminPositions.js's own comment for the pattern this mirrors.
create table if not exists resource_link_categories (
  id integer generated always as identity primary key,
  title text not null unique,
  position integer not null default 0
);

alter table resource_links add column if not exists category_id integer references resource_link_categories(id) on delete set null;
alter table resource_links add column if not exists city text;
alter table resource_links add column if not exists state text;
-- 'approved' (admin-added, or a member submission an admin has approved)
-- vs 'pending' (a member submission awaiting review) - the Approvals tab
-- is just this column filtered to 'pending'. Denying a submission deletes
-- its row outright rather than adding a third status - there's nothing
-- useful left to keep once a submission is rejected, same as Main
-- Admin's own event/classified/directory request flows elsewhere in this
-- app that just delete on deny.
alter table resource_links add column if not exists status text not null default 'approved';
alter table resource_links add column if not exists submitted_by_member_id integer references members(id) on delete set null;
create index if not exists idx_resource_links_category on resource_links(category_id);
create index if not exists idx_resource_links_status on resource_links(status);
