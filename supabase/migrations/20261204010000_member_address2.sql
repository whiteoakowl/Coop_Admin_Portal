-- A real request: "Under first parent/guardian it should have address 1,
-- address 2, city, state, zip code" on the public self-registration form
-- (views/portal-register.ejs). members already has address/city/state/
-- zip (an apartment/suite line, "address 2", was never a separate column
-- until now).
alter table members add column if not exists address2 text;
