-- A real request: "Primary color should say title color. Secondary
-- color should say background color. Secondary color should color the
-- card that shows this information on the homepage. Add another color
-- choice for font color." color_primary/color_secondary already exist
-- (styled as Title Color / Background Color now) - this adds the third,
-- new color choice for the card's own body text.
alter table family_school_settings add column if not exists color_text text;
