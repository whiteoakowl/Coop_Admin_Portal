-- A real bug report: "On each invoice on the table, it should only say
-- the name of the event on the invoice, it should not say event
-- registration to help save space on the table." utils/events.js's own
-- chargeForConfirmedRegistration already stores just the event's title
-- (plus an optional ticket-type suffix) for every NEW event-registration
-- charge - this is a one-time cleanup for existing payment_charges rows
-- created before that, whose description still carries the old verbose
-- "Event Registration" prefix. Scoped tightly (source_type +
-- a literal leading "Event Registration" match) so it can't touch a
-- charge whose description only happens to contain that phrase
-- elsewhere, or an already-clean row.
update payment_charges
set description = trim(regexp_replace(description, '^Event Registration\s*[-:–—]*\s*', '', 'i'))
where source_type = 'event_registration'
  and description ~* '^Event Registration'
  and trim(regexp_replace(description, '^Event Registration\s*[-:–—]*\s*', '', 'i')) <> '';
