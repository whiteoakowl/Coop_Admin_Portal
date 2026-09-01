-- A real request: "main admin portal chat, Moderate tab should have a
-- list of the chat categories. when you click each category it show a
-- pop up of the category's name, description, check box - allow
-- comments, checkboxes - select which section can view or all, dropdown
-- menu to select member to moderate." Three new pieces of per-category
-- settings, alongside the name/description/scope forum_categories
-- already had:
--
-- allow_comments - a category with this off is announcement-only (see
-- routes/forums.js's own reply-form gate); defaults to true so every
-- existing category keeps working exactly as it already does.
--
-- forum_category_sections - same (thing_id, section_id) join-table shape
-- as event_sections/class_sections (see utils/sections.js's own header
-- comment) - "select which section can view or all" - empty means
-- unrestricted, same "empty means unrestricted" convention those two
-- already use, layered ON TOP of the existing scope='class' restriction
-- rather than replacing it.
--
-- moderator_member_id - one member who can moderate THIS category (edit/
-- remove any post, pin/lock/archive threads) without needing the
-- sitewide manage_forum permission a Main Admin/coop_admin role grants -
-- e.g. a parent volunteer moderating a single interest-group chat.
alter table forum_categories add column if not exists allow_comments integer not null default 1;
alter table forum_categories add column if not exists moderator_member_id integer references members(id) on delete set null;

create table if not exists forum_category_sections (
  category_id integer not null references forum_categories(id) on delete cascade,
  section_id integer not null references sections(id) on delete cascade,
  primary key (category_id, section_id)
);
