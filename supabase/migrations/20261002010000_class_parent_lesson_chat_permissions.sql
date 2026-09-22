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
alter table class_chat_messages rename column admin_username to author_name;
