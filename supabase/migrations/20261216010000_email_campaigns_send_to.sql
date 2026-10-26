-- A real request (Main Admin > Communication > Compose Email): "Under
-- reply to, there should be another title and text box that says send to
-- so another email can be added to send the message to." Reply-To is
-- already its own nullable column on email_campaigns (see that
-- migration's own header comment) - this is the same shape for a second,
-- separate address: an extra recipient typed in at compose time, on top
-- of whatever the filtered/checked member list already sends to. Null
-- when the admin leaves it blank, same as reply_to.
alter table email_campaigns add column if not exists send_to text;
