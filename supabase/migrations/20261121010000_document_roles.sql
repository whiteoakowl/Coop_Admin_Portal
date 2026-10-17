-- A real request: "Edit icon top right corner of every document on main
-- admin portal and co-op admin portal. When clicking edit icon you can
-- control which portals can view the documents" - same many-to-many,
-- empty-means-everyone convention as resource_link_roles
-- (20261108010000_resource_link_roles.sql): no rows for a document means
-- every portal can see it (today's behavior, unchanged); one or more
-- rows restricts it to just those portal roles.
create table if not exists document_roles (
  document_id integer not null references documents(id) on delete cascade,
  role_key text not null references roles(key) on delete cascade,
  primary key (document_id, role_key)
);
