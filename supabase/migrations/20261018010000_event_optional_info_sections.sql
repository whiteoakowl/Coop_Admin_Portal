-- A real request: "event editing under details add another text box that
-- says activity information, another text box below that saying meetup
-- and parking information, another text box under that saying what to
-- bring. Under that a text box that says extra notes. Next to each of
-- these title is a check box and question that says include this
-- section? If the box is checked then the information filled out and the
-- section will appear on the event for members to see." Same "text field
-- + its own include_* toggle" shape as the existing payment_instructions_
-- title/text pair - each section only shows on the public event detail
-- page (views/events-detail.ejs) when its own checkbox is on, regardless
-- of whether text has been typed in.
alter table events add column if not exists activity_info text;
alter table events add column if not exists include_activity_info integer not null default 0;
alter table events add column if not exists meetup_parking_info text;
alter table events add column if not exists include_meetup_parking_info integer not null default 0;
alter table events add column if not exists what_to_bring text;
alter table events add column if not exists include_what_to_bring integer not null default 0;
alter table events add column if not exists extra_notes text;
alter table events add column if not exists include_extra_notes integer not null default 0;
