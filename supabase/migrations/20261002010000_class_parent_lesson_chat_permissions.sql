-- A real request: "Add to class settings, check boxes, allow parents to
-- complete lessons for student and allow parent to interact in the class
-- chat. This way it can be turned on or off for different classes." Both
-- default OFF, same as this app's other opt-in-per-class toggles
-- (allow_student_register, auto_refund_on_cancel) - a class only grants
-- either permission once an admin deliberately flips it on, on the
-- existing Schedules > Settings tab (utils/classSchedule.js's own
-- CLASS_SETTINGS_FIELDS/updateClassSettings).
alter table classes add column if not exists allow_parent_complete_lessons integer not null default 0;
alter table classes add column if not exists allow_parent_chat integer not null default 0;

-- class_chat_messages (the Class Dashboard's own "Chat" tab) was admin-
-- only when it was built, hence admin_username - now that allow_parent_chat
-- above can let a parent post here too, that column name would be actively
-- misleading (it'd hold a parent's own name, not an admin's). Renaming
-- rather than adding a second column: every existing row is still exactly
-- "whoever posted this message's display name", just not exclusively an
-- admin's anymore.
--
-- Guarded by an information_schema check, unlike a plain "rename column"
-- (a real bug report: running this SQL a second time - this whole
-- consolidated file is meant to be safe to replay in full - failed with
-- "column admin_username does not exist", since the first run had already
-- renamed it and Postgres has no "rename column if exists").
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'class_chat_messages' and column_name = 'admin_username'
  ) then
    alter table class_chat_messages rename column admin_username to author_name;
  end if;
end $$;
