// Settings behind the public membership application's (views/portal-
// register.ejs) Policy Handbook and Payment sections - a real request:
// "there should be a place at the bottom of the membership application
// to check a box after reading the policy handbook... place at the
// bottom of the application for payment." Both are admin-editable from
// Main Admin Portal > Members > Settings (routes/main-admin-members.js)
// and stored the same small generic key/value way utils/classCheckinPin.js
// already does (utils/classSchedule.js's appSetting/setAppSetting)
// rather than adding dedicated columns/tables for two free-text blobs.
//
// Per this app's existing payment convention (see supabase/migrations/
// 20260825080000_payments_foundation.sql's own header comment: "there is
// no online 'pay now' button anywhere in this app"), the payment section
// is informational only - a fee amount and instructions for how a family
// actually pays (cash, check, Venmo, whatever the co-op uses), not a
// real checkout.
const { appSetting, setAppSetting } = require('./classSchedule');

const HANDBOOK_HTML_KEY = 'membership_handbook_html';
const PAYMENT_INSTRUCTIONS_KEY = 'membership_payment_instructions';
const FEE_CENTS_KEY = 'membership_fee_cents';

async function getHandbookHtml() {
  return (await appSetting(HANDBOOK_HTML_KEY, '')) || '';
}

async function setHandbookHtml(html) {
  await setAppSetting(HANDBOOK_HTML_KEY, html || '');
}

async function getPaymentInfo() {
  const cents = parseInt((await appSetting(FEE_CENTS_KEY, '0')) || '0', 10);
  const instructions = (await appSetting(PAYMENT_INSTRUCTIONS_KEY, '')) || '';
  return { feeCents: Number.isFinite(cents) && cents > 0 ? cents : 0, instructions };
}

async function setPaymentInfo(feeCents, instructions) {
  await setAppSetting(FEE_CENTS_KEY, String(Math.max(0, Math.round(feeCents) || 0)));
  await setAppSetting(PAYMENT_INSTRUCTIONS_KEY, instructions || '');
}

module.exports = { getHandbookHtml, setHandbookHtml, getPaymentInfo, setPaymentInfo };
