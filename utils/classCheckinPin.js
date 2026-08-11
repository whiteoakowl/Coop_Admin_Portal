// The one shared 4-digit PIN gating the kiosk's Class Check-In flow (see
// routes/kiosk-class-checkin.js) - stored hashed in app_settings (the
// small generic key/value table utils/classSchedule.js's appSetting/
// setAppSetting already wraps), seeded with a default on first boot
// (db/index.js) and changeable via Settings > Class Check-In PIN
// (routes/admin.js). Centralized here rather than duplicating the
// hash/compare calls in both the settings route and the kiosk route.
const bcrypt = require('bcryptjs');
const { appSetting, setAppSetting } = require('./classSchedule');

const PIN_SETTING_KEY = 'class_checkin_pin_hash';

async function setClassCheckinPin(pin) {
  await setAppSetting(PIN_SETTING_KEY, bcrypt.hashSync(pin, 10));
}

async function verifyClassCheckinPin(pin) {
  const hash = await appSetting(PIN_SETTING_KEY, null);
  if (!hash || typeof pin !== 'string') return false;
  return bcrypt.compareSync(pin, hash);
}

module.exports = { setClassCheckinPin, verifyClassCheckinPin };
