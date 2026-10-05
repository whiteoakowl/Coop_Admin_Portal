-- A real request: "main admin, settings gear, faq, question answer and
-- choose category. Button with popup for add/edit category." Same shape
-- as the Shop's own store_categories/store_products.category_id (see
-- 20260918030000_store_categories_and_sizes.sql) - a plain lookup table
-- plus a nullable FK, never a required field (an FAQ with no category
-- just reads as uncategorized, same as an uncategorized product).
create table if not exists faq_categories (
  id integer generated always as identity primary key,
  name text not null unique
);

alter table faqs add column if not exists category_id integer references faq_categories(id) on delete set null;
