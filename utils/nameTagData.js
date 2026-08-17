// DB-backed name tag lookups - split out from nameTagBadge.js (which holds
// the plain constants) to avoid a require cycle with db/index.js, which
// needs the constants at startup to seed default templates.
const db = require('../db');
const { DEFAULT_LAYOUTS } = require('./nameTagBadge');

async function cleanupTeamsForParent(memberId) {
  const rows = await db
    .prepare(
      `SELECT st.title FROM setup_teams st
       JOIN setup_team_members stm ON stm.team_id = st.id
       WHERE stm.member_id = ? ORDER BY st.day, st.title`
    )
    .all(memberId);
  return rows.map((r) => r.title);
}

// Batch version of cleanupTeamsForParent for an arbitrary list of parent
// ids - one query for the whole list instead of one per parent, the same
// N+1 shape a real ~800-member bulk name tag print timed out on (see
// badgeDataForMembers below). Returns { [memberId]: [title, ...] }.
async function cleanupTeamsForParents(memberIds) {
  if (memberIds.length === 0) return {};
  const placeholders = memberIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT stm.member_id AS "memberId", st.title FROM setup_teams st
       JOIN setup_team_members stm ON stm.team_id = st.id
       WHERE stm.member_id IN (${placeholders}) ORDER BY st.day, st.title`
    )
    .all(...memberIds);
  const byMember = {};
  for (const row of rows) {
    if (!byMember[row.memberId]) byMember[row.memberId] = [];
    byMember[row.memberId].push(row.title);
  }
  return byMember;
}

// member_code is the permanent 6-digit ID assigned at creation (see
// db/schema.sql's own comment) - shown as "ID#123456" so it reads as a
// label rather than a bare number the eye might mistake for something
// else on the tag.
function memberCodeLabel(member) {
  return member.member_code ? `ID#${member.member_code}` : '';
}

// The field values a badge template can place on a member's tag.
async function badgeDataForMember(member) {
  const memberCode = memberCodeLabel(member);
  if (member.member_type === 'parent') {
    return {
      name: member.name,
      cleanupTeam: (await cleanupTeamsForParent(member.id)).join(', '),
      memberCode,
      barcodeValue: member.barcode,
    };
  }
  return {
    name: member.name,
    gradeLevel: member.grade_level || '',
    allergies: member.medical_notes || '',
    memberCode,
    barcodeValue: member.barcode,
  };
}

// Batch version of badgeDataForMember for a bulk print flow (Design/
// Print's own Name Tags print, and utils/cardPairs.js's Name Tags +
// Schedule Cards / Front & Back Duplex) - computes every parent's cleanup
// team membership in ONE query instead of one per parent, the same N+1
// shape that made a real ~800-member bulk print time out. Returns
// { [memberId]: <same shape badgeDataForMember returns> }.
async function badgeDataForMembers(members) {
  const parentIds = members.filter((m) => m.member_type === 'parent').map((m) => m.id);
  const teamsByParent = await cleanupTeamsForParents(parentIds);
  const result = {};
  for (const member of members) {
    const memberCode = memberCodeLabel(member);
    result[member.id] =
      member.member_type === 'parent'
        ? { name: member.name, cleanupTeam: (teamsByParent[member.id] || []).join(', '), memberCode, barcodeValue: member.barcode }
        : { name: member.name, gradeLevel: member.grade_level || '', allergies: member.medical_notes || '', memberCode, barcodeValue: member.barcode };
  }
  return result;
}

async function getTemplate(memberType) {
  const row = await db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get(memberType);
  if (!row) return DEFAULT_LAYOUTS[memberType];
  try {
    const parsed = JSON.parse(row.layout_json);
    // Older saved templates stored a bare elements array with no badge
    // background color - wrap those so every caller can rely on the
    // { background, elements } shape.
    return Array.isArray(parsed) ? { background: '#ffffff', elements: parsed } : parsed;
  } catch (err) {
    return DEFAULT_LAYOUTS[memberType];
  }
}

module.exports = { badgeDataForMember, badgeDataForMembers, getTemplate, cleanupTeamsForParent, cleanupTeamsForParents };
