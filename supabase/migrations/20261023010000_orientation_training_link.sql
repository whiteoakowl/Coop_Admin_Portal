-- A real request: "Orientation settings should be linking a training
-- already created under training to each selection. This was when a
-- member completes a training it will automatically register as
-- complete in the correct column next to the member." The existing
-- orientation_settings table (see 20261012010000_orientation_semesters.
-- sql) already lets each column's header link out to a plain URL - this
-- is a separate, deeper mechanism: an actual trainings.id reference per
-- column, read by utils/training.js's own maybeFinalizeAttempt to
-- auto-call setOrientationField whenever a member passes that training.
-- link_url now needs to be nullable too, since a column can have a
-- linked training with no header URL at all.
alter table orientation_settings alter column link_url drop not null;
alter table orientation_settings add column if not exists training_id integer references trainings(id) on delete set null;
