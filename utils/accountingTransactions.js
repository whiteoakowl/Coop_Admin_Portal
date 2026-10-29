// Accounting > Transactions - a real request: "add a subpage called
// transactions. Here we can link our bank account securely and track
// all purchases that happen." No bank-integration provider exists
// anywhere in this app (confirmed by grep - no Plaid/Yodlee/Stripe
// wiring); the answered scoping question was manual entry for now, with
// a real bank feed deferred until a provider is chosen. Receipts reuse
// the same private-bucket + proxy-download shape utils/familySchool.js's
// own saveAttachment/attachmentBuffer already use for journal
// attachments - a private bucket since nothing here needs a public URL.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { createStorageClient, uploadFile, deleteFile, downloadFile, generateKey } = require('./storage');

const RECEIPTS_BUCKET = 'accounting-receipts';
const RECEIPTS_DIR = path.join(__dirname, '..', 'public', 'uploads', 'accounting-receipts');
if (!createStorageClient() && !fs.existsSync(RECEIPTS_DIR)) {
  try {
    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
  } catch (err) {
    console.error(`Could not create local upload directory ${RECEIPTS_DIR}:`, err.message);
  }
}

// A real request: "Filter button for date range, purchases/income."
async function listTransactions({ startDate, endDate, type, receiptOnly } = {}) {
  const conditions = [];
  const params = [];
  if (startDate) {
    conditions.push('t.transaction_date >= ?');
    params.push(startDate);
  }
  if (endDate) {
    conditions.push('t.transaction_date <= ?');
    params.push(endDate);
  }
  if (type) {
    conditions.push('t.type = ?');
    params.push(type);
  }
  if (receiptOnly) conditions.push('t.receipt_key IS NOT NULL');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT t.*, c.name AS category_name
       FROM accounting_transactions t
       LEFT JOIN event_accounting_categories c ON c.id = t.accounting_category_id
       ${where}
       ORDER BY t.transaction_date DESC, t.id DESC`
    )
    .all(...params);
}

async function getTransaction(id) {
  return db.prepare('SELECT * FROM accounting_transactions WHERE id = ?').get(id);
}

async function createTransaction({ type, name, transactionDate, amountCents, accountingCategoryId }) {
  return (
    await db
      .prepare(
        `INSERT INTO accounting_transactions (type, name, transaction_date, amount_cents, accounting_category_id)
         VALUES (?, ?, ?, ?, ?) RETURNING id`
      )
      .get(type, name, transactionDate, amountCents, accountingCategoryId || null)
  ).id;
}

async function updateTransactionCategory(id, accountingCategoryId) {
  await db
    .prepare('UPDATE accounting_transactions SET accounting_category_id = ?, updated_at = now_text() WHERE id = ?')
    .run(accountingCategoryId || null, id);
}

async function deleteTransaction(id) {
  const txn = await getTransaction(id);
  if (!txn) return;
  await db.prepare('DELETE FROM accounting_transactions WHERE id = ?').run(id);
  if (txn.receipt_key) await removeReceiptFile(txn.receipt_key);
}

async function removeReceiptFile(key) {
  const client = createStorageClient();
  if (client) return deleteFile(client, RECEIPTS_BUCKET, key);
  const filePath = path.join(RECEIPTS_DIR, key);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// The receipt-upload popup: "When you click this icon a popup occurs and
// allows you to upload an image of your receipt. And save." Replaces
// any previously-attached receipt rather than keeping both around.
async function saveReceipt(id, file) {
  const txn = await getTransaction(id);
  if (!txn) return;
  const client = createStorageClient();
  let key;
  if (client) {
    key = await uploadFile(client, RECEIPTS_BUCKET, file.buffer, file.originalname, file.mimetype);
  } else {
    key = generateKey(file.originalname);
    fs.writeFileSync(path.join(RECEIPTS_DIR, key), file.buffer);
  }
  if (txn.receipt_key) await removeReceiptFile(txn.receipt_key);
  await db
    .prepare('UPDATE accounting_transactions SET receipt_key = ?, receipt_name = ?, receipt_content_type = ?, updated_at = now_text() WHERE id = ?')
    .run(key, file.originalname, file.mimetype, id);
}

async function receiptBuffer(key) {
  if (!key) return null;
  const client = createStorageClient();
  if (client) return downloadFile(client, RECEIPTS_BUCKET, key);
  const filePath = path.join(RECEIPTS_DIR, key);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

module.exports = {
  listTransactions,
  getTransaction,
  createTransaction,
  updateTransactionCategory,
  deleteTransaction,
  saveReceipt,
  receiptBuffer,
};
