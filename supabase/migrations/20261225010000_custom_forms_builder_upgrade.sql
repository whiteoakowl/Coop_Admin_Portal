-- Main Admin portal, Forms tab - a real request: "Should have full
-- editing features and view just like jotform. Exactly." Extends the
-- original custom_forms schema (supabase/migrations/20260825070000_
-- custom_forms.sql) rather than replacing it - every existing form,
-- field, and submission keeps working unchanged; this only adds the
-- columns/tables a Jotform-style builder needs on top: sections/pages a
-- respondent moves through, per-field conditional "only show when"
-- logic, placeholder/default-value text, and a per-form color/button
-- theme applied on the public fill-out page.

-- Sections/pages - a form is split into one or more pages a respondent
-- moves through (a progress indicator shows on the fill-out page once
-- there's more than one). Every pre-existing form gets exactly one
-- default page via db/bootstrapPg.js's backfillCustomFormDefaultPages
-- (same "SQL migration adds the column, a JS backfill fills in existing
-- rows" split this app already uses everywhere else - see e.g.
-- backfillNameTagLogo - rather than a one-off PL/pgSQL DO block, which
-- nothing else in supabase/migrations/ uses), so a short single-page
-- form still renders exactly as it always has.
create table if not exists custom_form_pages (
  id integer generated always as identity primary key,
  form_id integer not null references custom_forms(id) on delete cascade,
  title text,
  description text,
  position integer not null default 0,
  -- Whole-section conditional logic ("only show this page when field X
  -- is/isn't/contains answer Y") - same {fieldId, operator, value} JSON
  -- shape as custom_form_fields.conditional_logic below, evaluated by
  -- utils/customForms.js's isPageVisible/isFieldVisible for both the
  -- public fill-out page's plain-JS live hide/show and the submit
  -- route's own required-field check (a required field hidden by its
  -- page being skipped must never block submission).
  conditional_logic text,
  created_at text not null default now_text()
);
create index if not exists idx_custom_form_pages_form on custom_form_pages(form_id);

alter table custom_form_fields add column if not exists page_id integer references custom_form_pages(id) on delete cascade;
create index if not exists idx_custom_form_fields_page on custom_form_fields(page_id);

-- Real editing, not just add-and-forget: a placeholder shown in the
-- empty input, a default value pre-filled on a fresh fill-out, and
-- field-level conditional logic ({fieldId, operator, value} - operator
-- is one of equals/not_equals/contains/is_answered/is_blank, matching
-- CONDITION_OPERATORS in utils/customForms.js).
alter table custom_form_fields add column if not exists placeholder text;
alter table custom_form_fields add column if not exists default_value text;
alter table custom_form_fields add column if not exists conditional_logic text;

-- A fuller field-type palette: email/phone/url (still plain text answers,
-- just a different input type/validation/icon), rating (1-5 stars) and
-- scale (1-10 opinion scale, both stored as plain text same as a short
-- answer), and two purely decorative, non-answer layout elements
-- (heading/paragraph) for breaking a long form into readable sections -
-- utils/customForms.js's DISPLAY_ONLY_TYPES skips them entirely in
-- required-field checks and answer storage, same as Jotform's own
-- "heading"/"text" layout widgets never show up in a response.
alter table custom_form_fields drop constraint if exists custom_form_fields_field_type_check;
alter table custom_form_fields add constraint custom_form_fields_field_type_check
  check (field_type in (
    'short_text', 'long_text', 'number', 'date', 'single_choice', 'multiple_choice',
    'dropdown', 'checkbox', 'file', 'email', 'phone', 'url', 'rating', 'scale',
    'heading', 'paragraph'
  ));

-- Per-form appearance (Jotform's own "Theme" tab, scoped down to what
-- this app actually needs): a primary color and a button shape, both
-- applied as CSS custom properties on the public fill-out page
-- (views/custom-forms-fill.ejs) and mirrored in the builder's own live
-- preview panel. Defaults match this app's existing "Save"-button blue
-- (--brand-dark in public/css/styles.css) and current rounded corners,
-- so a form nobody has themed yet renders exactly as it did before this
-- migration.
alter table custom_forms add column if not exists theme_primary_color text not null default '#2e6da4';
alter table custom_forms add column if not exists theme_button_style text not null default 'rounded';
alter table custom_forms drop constraint if exists custom_forms_theme_button_style_check;
alter table custom_forms add constraint custom_forms_theme_button_style_check
  check (theme_button_style in ('rounded', 'square', 'pill'));
