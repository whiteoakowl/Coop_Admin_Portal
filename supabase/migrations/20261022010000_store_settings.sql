-- Main Admin > Shop > Settings - "add a subpage called settings. This is
-- where general store settings will happen." One singleton settings row,
-- same shape/reasoning as event_settings
-- (20260829010000_event_settings.sql) and site_settings - a Main Admin
-- can edit these without touching code.
create table if not exists store_settings (
  id integer primary key default 1 check (id = 1),
  -- "Shop open for online purchases?" - closing the storefront this way
  -- (routes/store.js) hides the whole member-facing Shop/product pages
  -- without archiving every product one at a time; In-Person Sale on the
  -- Orders tab is unaffected, same as how a closed brick-and-mortar
  -- register still works for a cashier ringing someone up directly.
  store_enabled integer not null default 1,
  -- Shown at the top of the member Shop homepage (views/store-list.ejs) -
  -- e.g. seasonal hours, a note about what's currently in stock.
  welcome_message text,
  -- Shown on a member's own order page (views/store-order-detail.ejs) -
  -- e.g. where/when to pick up an in-person order.
  pickup_instructions text,
  -- Stored for a notify-on-new-order system that doesn't exist yet in
  -- this app - same "controls X once a real feature exists" pattern
  -- event_settings' own submit_notification_email already uses.
  order_notification_email text,
  updated_at text not null default now_text()
);
insert into store_settings (id) values (1) on conflict (id) do nothing;
