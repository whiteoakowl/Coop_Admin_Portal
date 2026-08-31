-- Floater Assignments - a real request: "if class assistant says 1 and
-- there are 0 assistants signed for that class, then the positions
-- should appear on the floater list each week until someone is added as
-- an assistant to that class roster... this should work for number of
-- teachers as well." A class's teacher_slots/assistant_slots (already on
-- the classes table, previously only used to cap self-registration
-- signups) now also drive a standing "still needs to be filled" slot on
-- the Floater Assignments board, alongside the existing permanent job
-- ('job') and missing-teacher-today ('class') slot types - see
-- utils/substitutes.js's own classVacancySlotId/classVacancySlots for
-- how these get generated and assigned through the exact same
-- substitute_assignments table/UI as everything else on that board.
alter table substitute_assignments drop constraint if exists substitute_assignments_slot_type_check;
alter table substitute_assignments add constraint substitute_assignments_slot_type_check check (slot_type in ('class', 'job', 'vacancy'));
