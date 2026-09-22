-- A real request: "Main admin portal, class lessons... Link to video
-- should include a description area. Link to file should include a
-- description area. There should be an option in the dropdown menu for
-- assignment upload, text box with word count and full editing
-- features, also be able to upload a file such as doc, pdf, jpg etc."
-- description is shared by every content type that wants one (video/
-- file today); assignment_upload reuses the existing `body` column (the
-- same rich-text field 'text' content already has) for its own text box,
-- plus a new attachment file of its own.
alter table lesson_content_items add column if not exists description text;
alter table lesson_content_items add column if not exists attachment_url text;
alter table lesson_content_items add column if not exists attachment_name text;

alter table lesson_content_items drop constraint if exists lesson_content_items_type_check;
alter table lesson_content_items add constraint lesson_content_items_type_check
  check (type in ('video', 'text', 'file', 'quiz', 'assignment_upload'));
