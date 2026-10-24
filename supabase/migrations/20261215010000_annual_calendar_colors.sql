-- A real request: "Add edit calendar colors buttons. This button will
-- allow you to set the color for the month row and set the color for
-- the days of the week row." Both nullable - null means "use this
-- site's own default colors" (the blue month title bar/grey weekday
-- row utils/annualCalendar.js's own module comment already documents),
-- so existing calendars with nothing set keep looking exactly the same
-- until an admin actually picks colors of their own.
alter table annual_calendars add column if not exists month_row_color text;
alter table annual_calendars add column if not exists weekday_row_color text;
