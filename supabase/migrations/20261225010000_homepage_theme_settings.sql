-- A real request: "Main admin portal, settings gear, public homepage.
-- Should have the exact webpage editing features as Shopify. See
-- screenshot." Shopify's theme editor keeps a handful of site-wide
-- "theme settings" (colors, fonts, logo/favicon, announcement bar)
-- separate from the page's own content blocks (homepage_blocks, the
-- earlier homepage_builder migration) - this is that settings row. One
-- singleton row (id = 1), same "one row for the whole co-op" shape as
-- site_settings/store_settings/event_settings elsewhere in this schema,
-- not a per-family row like family_school_settings (there is exactly
-- one public homepage for the whole co-op, not one per family) - though
-- its own color/logo columns deliberately mirror family_school_settings'
-- own "name/logo/colors" shape (supabase/migrations/
-- 20261207010000_family_school_settings.sql), the closest existing prior
-- art for "a family of theme-ish settings an admin picks once."
-- logo_key/favicon_key are Supabase Storage object keys (or a local-disk
-- filename under public/uploads/homepage/), same storage-backend-
-- agnostic shape homepage_blocks.image_key already uses (see
-- utils/homepage.js's own homepageImageUrl) - the bucket is shared with
-- homepage_blocks' own images, not a new one.
create table if not exists homepage_theme_settings (
  id integer primary key default 1,
  color_primary text not null default '#E7AA7B',
  color_accent text not null default '#79BAEC',
  color_background text not null default '#FFFFFF',
  color_cards text not null default '#FFFFFF',
  color_text text not null default '#1C2530',
  font_heading text not null default 'montserrat',
  font_body text not null default 'open_sans',
  font_size_base text not null default 'medium' check (font_size_base in ('small', 'medium', 'large')),
  logo_key text,
  favicon_key text,
  announcement_enabled boolean not null default false,
  announcement_text text,
  updated_at text not null default now_text(),
  constraint homepage_theme_settings_singleton check (id = 1)
);

-- Every color/font default above is chosen to exactly match what the
-- public homepage already renders today (public/css/styles.css's own
-- --btn-bg/--brand/--surface/--ink tokens, and partials/head.ejs's own
-- already-loaded Montserrat/Open Sans Google Fonts) - seeding this row
-- changes nothing about how an existing, not-yet-customized homepage
-- looks, same "upgrading never blanks out what's already live" reasoning
-- as homepage_builder.sql's own one-time seed.
insert into homepage_theme_settings (id) values (1)
  on conflict (id) do nothing;
