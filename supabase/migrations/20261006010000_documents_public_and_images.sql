-- A real request: "co-op admin, document upload... should move to the
-- documents page... each document line should have a copy link button
-- for easy public sharing. When uploading the document file there should
-- be an option to add an image as well." Confirmed: the copy-link should
-- make the document genuinely viewable without an admin login (e.g. to
-- hand a parent handbook to a prospective family), not just a
-- convenience link for already-logged-in admins - see routes/
-- documents.js (new, mounted at the site root, no auth) versus routes/
-- admin-documents.js's existing requireFullAdmin-gated management routes.
--
-- public_token is a random, unguessable string (not documents.id) so a
-- public link can't be used to enumerate every other document by
-- incrementing a small integer - the same reasoning
-- utils/portalAuth.js's own session tokens already use.
alter table documents add column if not exists image_path text;
alter table documents add column if not exists image_mime_type text;
alter table documents add column if not exists public_token text;

update documents set public_token = md5(random()::text || clock_timestamp()::text || id::text) where public_token is null;

alter table documents alter column public_token set not null;
create unique index if not exists idx_documents_public_token on documents(public_token);
