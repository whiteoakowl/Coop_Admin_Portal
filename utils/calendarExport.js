// Add-to-calendar links for one event - a real request: "Parent portal,
// event calendar. When clicking on the event and viewing all of the
// information. Add icons at the bottom for adding event to google or
// apple calendars or other calendar services." events.starts_at/
// ends_at are already real UTC instants stored as 'YYYY-MM-DD HH:MM:SS'
// (see utils/dates.js's own header comment - every other display helper
// there just reads them back out through an Eastern-zoned formatter for
// humans) - that's exactly the one instant both Google Calendar's own
// URL scheme and a .ics file need, so nothing here does any timezone
// math, just reformats the same instant two different ways.
const ONE_HOUR_MS = 60 * 60 * 1000;

function parseSqlUtc(sqlTimestamp) {
  return new Date(sqlTimestamp.replace(' ', 'T') + 'Z');
}

// YYYYMMDDTHHMMSSZ - the one timestamp format both Google Calendar's
// `dates=` query param and a .ics file's DTSTART/DTEND/DTSTAMP lines
// share.
function toCalendarUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// A plain-text version of an event's own rich-text HTML description -
// both Google Calendar's `details=` param and a .ics DESCRIPTION line
// want plain text, never markup.
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// The handful of plain fields both exports below need, computed once so
// routes/events.js's own GET /:id (the Google Calendar link) and GET
// /:id/calendar.ics (the file download) can never drift apart from each
// other. An event with no end time at all gets a fabricated 1-hour
// duration - same fallback every other "add to calendar" button out in
// the wild uses, rather than a zero-length or missing-end calendar entry.
function calendarFieldsForEvent(event) {
  const start = parseSqlUtc(event.starts_at);
  const end = event.ends_at ? parseSqlUtc(event.ends_at) : new Date(start.getTime() + ONE_HOUR_MS);
  return {
    title: event.title || 'Event',
    description: stripHtml(event.description),
    location: event.location || '',
    start,
    end,
  };
}

// No library needed - a plain URL Google Calendar itself parses.
function googleCalendarUrl(event) {
  const { title, description, location, start, end } = calendarFieldsForEvent(event);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${toCalendarUtcStamp(start)}/${toCalendarUtcStamp(end)}`,
    details: description,
    location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Standard escaping for a .ics TEXT value (RFC 5545 section 3.3.11).
function icsEscape(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// A minimal single-VEVENT .ics - the one format every calendar app
// (Apple Calendar, Outlook, Yahoo, etc. - "other calendar services")
// can import, unlike Google Calendar's own URL scheme above which only
// Google Calendar itself understands. `host` just needs to be stable
// and unique-ish for the UID - routes/events.js passes the request's
// own Host header.
function icsForEvent(event, { host } = {}) {
  const { title, description, location, start, end } = calendarFieldsForEvent(event);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sanford Homeschoolers//Coop Admin Portal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${event.id}@${host || 'coop-admin-portal'}`,
    `DTSTAMP:${toCalendarUtcStamp(new Date())}`,
    `DTSTART:${toCalendarUtcStamp(start)}`,
    `DTEND:${toCalendarUtcStamp(end)}`,
    `SUMMARY:${icsEscape(title)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { googleCalendarUrl, icsForEvent };
