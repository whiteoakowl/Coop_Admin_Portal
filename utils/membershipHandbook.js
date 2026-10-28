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
const HANDBOOK_FILE_KEY = 'membership_handbook_file';
const PAYMENT_INSTRUCTIONS_KEY = 'membership_payment_instructions';
const FEE_CENTS_KEY = 'membership_fee_cents';
const CATEGORY_ID_KEY = 'membership_fee_category_id';

async function getHandbookHtml() {
  return (await appSetting(HANDBOOK_HTML_KEY, '')) || '';
}

async function setHandbookHtml(html) {
  await setAppSetting(HANDBOOK_HTML_KEY, html || '');
}

// A real request: "add an option to upload the policy handbook as a
// document, pdf, etc." - an optional uploaded file ALONGSIDE the rich-
// text handbook above, not a replacement for it: the existing "can't
// check the box until you've scrolled through the entire handbook"
// enforcement (views/portal-register.ejs's own #handbook-scroll-box,
// routes/portal-auth.js's own handbookRead check) is tied specifically
// to that HTML content, which this doesn't touch - the uploaded file is
// just a downloadable reference shown next to it. One file at a time
// (uploading a new one replaces whatever was there, same "singleton
// setting" shape as the HTML/payment fields above), so a small JSON blob
// under the same generic key/value table is enough - no dedicated table
// needed for exactly one row.
async function getHandbookFile() {
  const raw = await appSetting(HANDBOOK_FILE_KEY, null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setHandbookFile(file) {
  await setAppSetting(HANDBOOK_FILE_KEY, file ? JSON.stringify(file) : '');
}

async function getPaymentInfo() {
  const cents = parseInt((await appSetting(FEE_CENTS_KEY, '0')) || '0', 10);
  const instructions = (await appSetting(PAYMENT_INSTRUCTIONS_KEY, '')) || '';
  const rawCategoryId = await appSetting(CATEGORY_ID_KEY, '');
  const categoryId = rawCategoryId ? parseInt(rawCategoryId, 10) : null;
  return {
    feeCents: Number.isFinite(cents) && cents > 0 ? cents : 0,
    instructions,
    categoryId: Number.isFinite(categoryId) ? categoryId : null,
  };
}

// A real request: "add a drop down menu for selecting which payment
// category to use." This fee is still informational only (see this
// file's own header comment - no online charge is created from it), so
// the category picked here isn't attached to anything automatically; it
// just records which of the existing accounting categories (utils/
// events.js's own listAccountingCategories, the same list the manual
// Add Charge form on the Accounting page uses) an admin creating that
// charge by hand should file it under.
async function setPaymentInfo(feeCents, instructions, categoryId) {
  await setAppSetting(FEE_CENTS_KEY, String(Math.max(0, Math.round(feeCents) || 0)));
  await setAppSetting(PAYMENT_INSTRUCTIONS_KEY, instructions || '');
  await setAppSetting(CATEGORY_ID_KEY, categoryId ? String(categoryId) : '');
}

module.exports = { getHandbookHtml, setHandbookHtml, getHandbookFile, setHandbookFile, getPaymentInfo, setPaymentInfo };
