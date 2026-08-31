-- A real bug report: "If someone submits an absence/late form, it will
-- be over ridden and show a green P for present if they then come in
-- later and check in, it will also show their check in and out time and
-- cleaning team if they did that as well. The log will still record
-- their absence/late form."
--
-- The first half already worked: routes/kiosk.js's own /checkin/scan
-- unconditionally UPSERTs status='present', check_in_time=..., source=
-- 'kiosk' onto the SAME attendance row an earlier absence/late
-- submission wrote (member_id, roster_id, session_date is that row's
-- whole identity), so a real check-in already turns yesterday's "L" or
-- "A" into a real "P" with real times - routes/absence.js's own
-- attendance UPDATE/INSERT is what created that row in the first place.
--
-- The second half didn't: routes/admin-logs.js's Absence/Late tab reads
-- straight off that same live attendance row (WHERE source =
-- 'absence_form'), so the instant the row above gets overwritten to
-- source='kiosk', the original absence/late submission silently
-- disappears from the log too - there was never a separate record of
-- "this form was submitted," only the live, mutable, single-row status.
--
-- This table is that separate, append-only record: one row per
-- Absence/Late form submission, written once by routes/absence.js and
-- never updated or deleted by anything else (in particular, never
-- touched by kiosk check-in), so the Log tab can keep showing it no
-- matter what the live attendance row goes on to become.
create table if not exists absence_submissions (
  id integer generated always as identity primary key,
  member_id integer not null references members(id) on delete cascade,
  roster_id integer not null references rosters(id) on delete cascade,
  session_date text not null,
  status text not null check (status in ('absent', 'late')),
  reason_category text,
  reason_text text,
  submitted_at text not null default now_text()
);
create index if not exists idx_absence_submissions_date on absence_submissions(session_date desc);
create index if not exists idx_absence_submissions_member on absence_submissions(member_id);
