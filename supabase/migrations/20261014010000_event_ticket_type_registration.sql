-- A real request built out the popup-card -> full event page -> ticket
-- selection -> registration flow for Parent/Student portal events. Ticket
-- types (event_ticket_types) existed already but were admin-only -
-- registration always charged the event's own flat price_cents. This
-- column lets a registration remember which ticket (if any) the member
-- picked, so its own charge can be priced off that ticket instead.
alter table event_registrations add column if not exists ticket_type_id integer references event_ticket_types(id) on delete set null;
