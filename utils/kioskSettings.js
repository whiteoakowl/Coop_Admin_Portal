// The one co-op-wide "which semester is the Kiosk currently running" pick
// (Settings > Kiosk - see routes/admin-schedule.js's own kiosk sub-tab),
// stored in the same small generic key/value table utils/classCheckinPin.js
// already wraps for the Class Check-In PIN. The Floater List, Setup/Cleanup
// Teams, and Class Check-In/Check-Out all resolve this once per request and
// scope their own data (volunteer_lists.semester_id, setup_teams.semester_id,
// classes.semester_id) to it - switching the dropdown here is what makes
// "the kiosk can be changed each semester seamlessly" (a real request).
const { appSetting, setAppSetting } = require('./appSettings');

const KIOSK_SEMESTER_KEY = 'kiosk_active_semester_id';

async function getActiveKioskSemesterId() {
  const value = await appSetting(KIOSK_SEMESTER_KEY, null);
  return value ? parseInt(value, 10) : null;
}

async function setActiveKioskSemesterId(semesterId) {
  await setAppSetting(KIOSK_SEMESTER_KEY, String(semesterId));
}

module.exports = { getActiveKioskSemesterId, setActiveKioskSemesterId };
