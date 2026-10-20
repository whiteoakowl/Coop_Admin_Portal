-- Daily Learning Log (family_school_journal_entries) - a real request:
-- "Be able to upload images or documents to daily learning log under
-- the family school management tab." A one-to-many child table, not a
-- column on the entry itself, since "images OR documents" (plural-
-- capable) means an entry can carry more than one attachment.
-- file_key is whatever utils/familySchool.js's own saveAttachment
-- returns (a Storage key or a local-disk filename, same convention its
-- existing ATTACHMENTS_BUCKET/'family-school-attachments' already uses
-- for lesson content attachments - reused here rather than a second
-- bucket). content_type is the uploaded file's own mimetype, read back
-- to decide an image thumbnail vs. a plain document link without
-- having to guess from the file name's extension.
create table if not exists family_school_journal_attachments (
  id integer generated always as identity primary key,
  journal_entry_id integer not null references family_school_journal_entries(id) on delete cascade,
  file_key text not null,
  file_name text not null,
  content_type text,
  created_at text not null default now_text()
);
create index if not exists idx_family_school_journal_attachments_entry on family_school_journal_attachments(journal_entry_id);
