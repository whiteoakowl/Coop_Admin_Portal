// Communication > Text tab (item 13) - "same structure as email but
// simpler, a text box with a character cap." Recipient filtering is
// identical to Communication > Email, so routes call
// utils/emailComposer.js's listRoles/listSections/listGradeLevels/
// listRecipientCandidates/AGE_GROUPS directly rather than duplicating
// them here; this module only owns the text-specific send/schedule
// behavior (no subject, no rich text, no reply-to), mirroring
// emailComposer's own createAndSend/createScheduled/sendScheduled/
// listCampaigns shape.
const db = require('../db');
const { notify } = require('./notifications');
const { easternInputToUtcText } = require('./dates');
const { MAX_SMS_LENGTH } = require('./smsProvider');

async function createAndSend({ body, recipientAccountIds, mediaUrl, sentByAccountId, sentByPortal }) {
  const recipients = [...new Set(recipientAccountIds)];
  for (const accountId of recipients) {
    await notify(accountId, 'text_message', { title: 'Text Message', body, mediaUrl: mediaUrl || null });
  }
  const info = await db
    .prepare(
      `INSERT INTO text_campaigns (body, media_url, recipient_account_ids, recipient_count, status, sent_at, sent_by_portal, created_by_account_id)
       VALUES (?, ?, ?, ?, 'sent', now_text(), ?, ?) RETURNING id`
    )
    .get(body, mediaUrl || null, JSON.stringify(recipients), recipients.length, sentByPortal, sentByAccountId);
  return { id: info.id, recipientCount: recipients.length };
}

async function createScheduled({ body, recipientAccountIds, mediaUrl, scheduledAt, sentByAccountId, sentByPortal }) {
  const recipients = [...new Set(recipientAccountIds)];
  // scheduledAt arrives as a raw <input type="datetime-local"> value
  // ("2026-10-28T14:30", no timezone) - converted to the same UTC
  // 'YYYY-MM-DD HH:MM:SS' text now_text() produces so utils/
  // scheduledCampaigns.js's own dispatcher can compare it against
  // now_text() with plain string operators (a real bug this fixed: the
  // raw, unconverted value was stored and compared as-is before).
  const info = await db
    .prepare(
      `INSERT INTO text_campaigns (body, media_url, recipient_account_ids, recipient_count, status, scheduled_at, sent_by_portal, created_by_account_id)
       VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?) RETURNING id`
    )
    .get(body, mediaUrl || null, JSON.stringify(recipients), recipients.length, easternInputToUtcText(scheduledAt), sentByPortal, sentByAccountId);
  return { id: info.id, recipientCount: recipients.length };
}

// Called both by the admin's own manual Send button (POST /text/:id/send)
// and by utils/scheduledCampaigns.js's automatic dispatcher once
// scheduled_at is actually due.
async function sendScheduled(id) {
  const campaign = await db.prepare('SELECT * FROM text_campaigns WHERE id = ?').get(id);
  if (!campaign || campaign.status === 'sent') return null;
  const recipients = JSON.parse(campaign.recipient_account_ids || '[]');
  for (const accountId of recipients) {
    await notify(accountId, 'text_message', { title: 'Text Message', body: campaign.body, mediaUrl: campaign.media_url || null });
  }
  await db.prepare("UPDATE text_campaigns SET status = 'sent', sent_at = now_text() WHERE id = ?").run(id);
  return campaign;
}

async function listCampaigns(limit = 25) {
  return db.prepare('SELECT * FROM text_campaigns ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = { MAX_SMS_LENGTH, createAndSend, createScheduled, sendScheduled, listCampaigns };
