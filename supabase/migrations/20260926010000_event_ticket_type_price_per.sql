-- A real request: "event settings finance, add ticket types, price,
-- title and permissions person or family" - each ticket type now carries
-- its own person/family charge basis instead of relying on the event's
-- own (now hidden from the Finance tab) flat price_per.

alter table event_ticket_types add column if not exists price_per text not null default 'person' check (price_per in ('person', 'family'));
