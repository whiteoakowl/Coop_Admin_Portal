-- A real request: "on the membership form, ask how long the family has
-- been homeschooling." Free-text rather than a strict number/date - "3
-- years", "since 2019", "this is our first year" are all real answers a
-- family might give, and the admin-facing form has no need to parse it.
alter table families add column if not exists homeschool_duration text;
