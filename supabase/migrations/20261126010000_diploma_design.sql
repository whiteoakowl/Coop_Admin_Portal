-- Parent Portal - Diploma designer. A real request: "Diploma subpage.
-- Be able to design and create a diploma with four templates to choose
-- from, colors and edit name, dates, and signatures." The diplomas table
-- already covered title/issued_date/body_text (free-form wording); these
-- columns add the actual visual design a parent picks (utils/academics.js's
-- own issueDiploma, views/partials/diploma-certificate.ejs). display_name
-- defaults to the student's own member.name at render time when left
-- blank (see diploma-certificate.ejs), so this column only needs to
-- store an override, not a required value - "edit name" means the name
-- printed on the certificate can differ from the system record (a
-- formal/legal name, for instance), not that every diploma needs typing
-- it in by hand.
alter table diplomas add column if not exists template text not null default 'classic';
alter table diplomas add column if not exists color text not null default '#2e6da4';
alter table diplomas add column if not exists display_name text;
alter table diplomas add column if not exists signature1_name text;
alter table diplomas add column if not exists signature1_title text;
alter table diplomas add column if not exists signature2_name text;
alter table diplomas add column if not exists signature2_title text;
