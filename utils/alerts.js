// Single source of truth for "today's alerts": unfilled substitute slots,
// auto-picked substitute assignments still awaiting admin approval, and
// classes at risk of low attendance. The Home dashboard's Alert Log and
// the sitewide alert popup (public/js/alerts.js) both read from this same
// list, so what shows up in one always matches the other (see CONTEXT.md
// item "All alert pop ups are triggered by what appears on the alert
// log").
const { DAYS, DAY_LABELS } = require('./days');
const { todayISO, weekdayOf } = require('./dates');
const { substituteBoard } = require('./substitutes');
const { classesAtRiskForDay } = require('./classSchedule');

const DAY_WEEKDAY = { monday: 1, wednesday: 3 };

// Only check a day whose weekday actually matches today - "today" isn't a
// real session for the other day, so there's nothing to alert on yet.
function todaysSessionDays(date) {
  return DAYS.filter((day) => weekdayOf(date) === DAY_WEEKDAY[day]);
}

function todaysAlerts() {
  const date = todayISO();
  const alerts = [];

  todaysSessionDays(date).forEach((day) => {
    const dayLabel = DAY_LABELS[day];
    const board = substituteBoard(day, date);
    board.forEach((hour) => {
      hour.slots.forEach((slot) => {
        if (!slot.assigned) {
          alerts.push({
            type: 'sub_needed',
            severity: 'danger',
            day,
            dayLabel,
            date,
            message: `${hour.label}: ${slot.label} needs a substitute — no floaters available.`,
            link: `/admin/volunteers/${day}/manage?date=${encodeURIComponent(date)}`,
          });
        } else if (slot.assigned.status === 'pending') {
          alerts.push({
            type: 'sub_pending',
            severity: 'warning',
            day,
            dayLabel,
            date,
            message: `${hour.label}: ${slot.label} → ${slot.assigned.name} needs approval.`,
            link: `/admin/volunteers/${day}/manage?date=${encodeURIComponent(date)}`,
          });
        }
      });
    });

    classesAtRiskForDay(day, date).forEach((c) => {
      alerts.push({
        type: 'class_risk',
        severity: 'warning',
        day,
        dayLabel,
        date,
        message: `${c.hourLabel}: ${c.className} at risk of cancellation — only ${c.expectedCount} expected.`,
        link: `/admin/logs?tab=classrisk&day=${day}`,
      });
    });
  });

  return alerts;
}

module.exports = { todaysAlerts };
