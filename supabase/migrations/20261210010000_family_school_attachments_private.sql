-- A real decision: the family-school-attachments Supabase Storage
-- bucket should be private, not public (logos/lesson attachments/
-- journal attachments/weekly planner files are family-owned, personal
-- content - no reason for a direct public URL to exist for any of
-- them). A private bucket needs the app to proxy-download the bytes
-- itself (same pattern routes/admin-documents.js already uses for its
-- own private `documents` bucket), which needs each file's real
-- mimetype on hand to set Content-Type correctly when serving it -
-- these columns capture that at upload time (family_school_journal_
-- attachments already had its own content_type column from day one,
-- so it needs nothing here).
alter table family_school_content_items add column if not exists attachment_mime text;
alter table family_school_assignment_submissions add column if not exists file_mime text;
alter table family_school_week_assignments add column if not exists file_mime text;
alter table family_school_settings add column if not exists logo_mime text;
