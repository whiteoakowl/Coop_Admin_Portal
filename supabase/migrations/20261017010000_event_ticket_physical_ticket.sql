-- A real request: "finance, add ticket type pop up, add a checkbox for
-- include physical ticket. Members will be able to print tickets with a
-- barcode for check in and out. Barcode is the same as their member ID
-- number barcode used for classes." Per-ticket-type, not per-event - an
-- event can offer some ticket types that print (e.g. general admission)
-- and others that don't (e.g. a free/RSVP-only tier), same as its own
-- price_per already varies per ticket type rather than per event.
alter table event_ticket_types add column if not exists includes_physical_ticket boolean not null default false;
