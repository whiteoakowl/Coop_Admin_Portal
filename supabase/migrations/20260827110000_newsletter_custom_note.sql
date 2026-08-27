-- Weekly Newsletter - a real request: "Add a 'Customize Newsletter'
-- action where admin writes their own note/letter that appears before
-- the automatic content." Kept as its own column, separate from
-- body_html (the auto-assembled section) - utils/newsletter.js's own
-- regenerate() only overwrites body_html, so re-assembling from live
-- data never silently wipes an admin's hand-written note the way it
-- would if the note lived inside body_html itself.
alter table newsletter_issues add column if not exists custom_note text;
