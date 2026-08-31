-- Real request: "co-op admin portal name tag request form. options are
-- schedule change and lost name tag. add new name tag as option." Widens
-- name_tag_requests.request_type to also accept 'new_tag' - a member who
-- never had a tag printed yet (not lost, not a schedule change) - for the
-- public Name Tag Request form (routes/name-tag.js) and every admin-facing
-- surface that reads request_type (routes/admin-name-tag.js,
-- routes/admin-design.js, routes/admin-logs.js, routes/main-admin-name-tags.js).
alter table name_tag_requests drop constraint if exists name_tag_requests_request_type_check;
alter table name_tag_requests add constraint name_tag_requests_request_type_check
  check (request_type in ('lost_tag', 'schedule_change', 'new_tag'));
