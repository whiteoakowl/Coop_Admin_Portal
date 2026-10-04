-- A real request: "the links for the column check boxes should be
-- dropdown menus of trainings that have been created" - the plain,
-- hand-typed link_url field on orientation_settings is removed entirely;
-- each column's header link now comes only from its own linked Training
-- (training_id), picked from a dropdown on Orientation Settings.
alter table orientation_settings drop column if exists link_url;
