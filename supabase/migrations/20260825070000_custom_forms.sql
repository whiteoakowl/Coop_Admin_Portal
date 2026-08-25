-- Community & Commerce track (Track B), item 7: Custom Forms - one
-- generic, reusable form-builder system (per the handoff's own explicit
-- instruction: "do not create more one-off form tables after this").
-- Options for a choice-type field are their own child table
-- (custom_form_field_options), same pattern the existing Training
-- module already uses for quiz options (training_quiz_options) rather
-- than a JSON blob column - keeps this consistent with how the rest of
-- this app already models "a question/field with a list of options."

create table if not exists custom_forms (
  id integer generated always as identity primary key,
  title text not null,
  description text,
  status text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  created_by_account_id integer references member_accounts(id) on delete set null,
  created_at text not null default now_text(),
  updated_at text not null default now_text()
);

create table if not exists custom_form_fields (
  id integer generated always as identity primary key,
  form_id integer not null references custom_forms(id) on delete cascade,
  field_type text not null check (field_type in ('short_text', 'long_text', 'number', 'date', 'single_choice', 'multiple_choice', 'dropdown', 'checkbox', 'file')),
  label text not null,
  help_text text,
  is_required integer not null default 0,
  position integer not null default 0,
  created_at text not null default now_text()
);
create index if not exists idx_custom_form_fields_form on custom_form_fields(form_id);

create table if not exists custom_form_field_options (
  id integer generated always as identity primary key,
  field_id integer not null references custom_form_fields(id) on delete cascade,
  label text not null,
  position integer not null default 0
);
create index if not exists idx_custom_form_field_options_field on custom_form_field_options(field_id);

-- "assign a form to specific people or groups" - a group is one of the
-- existing portal roles (parent/student/teacher/coop_admin/main_admin),
-- reusing the RBAC model rather than inventing a second grouping
-- concept. A form with ZERO assignment rows is open to any signed-in
-- portal account once published - a real, common case (a general
-- survey), not an error state.
create table if not exists custom_form_assignments (
  id integer generated always as identity primary key,
  form_id integer not null references custom_forms(id) on delete cascade,
  member_id integer references members(id) on delete cascade,
  role_id integer references roles(id) on delete cascade,
  created_at text not null default now_text(),
  check (member_id is not null or role_id is not null)
);
create index if not exists idx_custom_form_assignments_form on custom_form_assignments(form_id);

-- One submission per (form, member) - a permission slip or intake form
-- filled out on behalf of a specific member of the submitting account's
-- own family (self included), same "acting account, real member subject,
-- accountable actor" shape Events/Directory/Classifieds already use.
create table if not exists custom_form_submissions (
  id integer generated always as identity primary key,
  form_id integer not null references custom_forms(id) on delete cascade,
  member_id integer not null references members(id) on delete cascade,
  submitted_by_account_id integer references member_accounts(id) on delete set null,
  submitted_at text not null default now_text(),
  unique (form_id, member_id)
);
create index if not exists idx_custom_form_submissions_form on custom_form_submissions(form_id);

-- value_text holds every field type's answer except multiple_choice
-- (checked boxes go in custom_form_answer_choices below, since a field
-- can have more than one selected option) - short_text/long_text/number/
-- date store their raw text, checkbox stores '1'/'0', single_choice/
-- dropdown store the selected option's label, file stores the uploaded
-- key (utils/storage.js's own convention).
create table if not exists custom_form_answers (
  id integer generated always as identity primary key,
  submission_id integer not null references custom_form_submissions(id) on delete cascade,
  field_id integer not null references custom_form_fields(id) on delete cascade,
  value_text text
);
create index if not exists idx_custom_form_answers_submission on custom_form_answers(submission_id);

create table if not exists custom_form_answer_choices (
  answer_id integer not null references custom_form_answers(id) on delete cascade,
  option_id integer not null references custom_form_field_options(id) on delete cascade,
  primary key (answer_id, option_id)
);
