// Communication > Text tab (item 13) - "same structure as email but
// simpler, a text box with a 50 word cap." Recipient filtering is
// identical to Communication > Email, so routes call
// utils/emailComposer.js's listRoles/listSections/listGradeLevels/
// listRecipientCandidates/AGE_GROUPS directly rather than duplicating
// them here; this module only owns the text-specific send/schedule
// behavior (no subject, no rich text, no reply-to), mirroring
// emailComposer's own createAndSend/createScheduled/sendScheduled/
// listCampaigns shape.
const db = require('../db');
const { notify } = require('./notifications');

const MAX_WORDS = 50;

function wordCount(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

async function createAndSend({ body, recipientAccountIds, sentByAccountId, sentByPortal }) {
  const recipients = [...new Set(recipientAccountIds)];
  for (const accountId of recipients) {
    await notify(accountId, 'text_message', { title: 'Text Message', body });
  }
  const info = await db
    .prepare(
      `INSERT INTO text_campaigns (body, recipient_account_ids, recipient_count, status, sent_at, sent_by_portal, created_by_account_id)
       VALUES (?, ?, ?, 'sent', now_text(), ?, ?) RETURNING id`
    )
    .get(body, JSON.stringify(recipients), recipients.length, sentByPortal, sentByAccountId);
  return { id: info.id, recipientCount: recipients.length };
}

async function createScheduled({ body, recipientAccountIds, scheduledAt, sentByAccountId, sentByPortal }) {
  const recipients = [...new Set(recipientAccountIds)];
  const info = await db
    .prepare(
      `INSERT INTO text_campaigns (body, recipient_account_ids, recipient_count, status, scheduled_at, sent_by_portal, created_by_account_id)
       VALUES (?, ?, ?, 'scheduled', ?, ?, ?) RETURNING id`
    )
    .get(body, JSON.stringify(recipients), recipients.length, scheduledAt, sentByPortal, sentByAccountId);
  return { id: info.id, recipientCount: recipients.length };
}

// Same "Schedule saves it, an admin still has to press Send" pattern as
// utils/emailComposer.js's own sendScheduled() - see that module's own
// comment for why (no real send provider is wired up anywhere in this
// app).
async function sendScheduled(id) {
  const campaign = await db.prepare('SELECT * FROM text_campaigns WHERE id = ?').get(id);
  if (!campaign || campaign.status === 'sent') return null;
  const recipients = JSON.parse(campaign.recipient_account_ids || '[]');
  for (const accountId of recipients) {
    await notify(accountId, 'text_message', { title: 'Text Message', body: campaign.body });
  }
  await db.prepare("UPDATE text_campaigns SET status = 'sent', sent_at = now_text() WHERE id = ?").run(id);
  return campaign;
}

async function listCampaigns(limit = 25) {
  return db.prepare('SELECT * FROM text_campaigns ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = { MAX_WORDS, wordCount, createAndSend, createScheduled, sendScheduled, listCampaigns };
