// DB-backed name tag lookups - split out from nameTagBadge.js (which holds
// the plain constants) to avoid a require cycle with db/index.js, which
// needs the constants at startup to seed default templates.
const db = require('../db');
const { DEFAULT_LAYOUTS } = require('./nameTagBadge');

function cleanupTeamsForParent(memberId) {
  return db
    .prepare(
      `SELECT st.title FROM setup_teams st
       JOIN setup_team_members stm ON stm.team_id = st.id
       WHERE stm.member_id = ? ORDER BY st.day, st.title`
    )
    .all(memberId)
    .map((r) => r.title);
}

// The field values a badge template can place on a member's tag.
function badgeDataForMember(member) {
  // member_code is the permanent 6-digit ID assigned at creation (see
  // db/schema.sql's own comment) - shown as "ID#123456" so it reads as a
  // label rather than a bare number the eye might mistake for something
  // else on the tag.
  const memberCode = member.member_code ? `ID#${member.member_code}` : '';
  if (member.member_type === 'parent') {
    return {
      name: member.name,
      cleanupTeam: cleanupTeamsForParent(member.id).join(', '),
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

function getTemplate(memberType) {
  const row = db.prepare('SELECT layout_json FROM name_tag_templates WHERE member_type = ?').get(memberType);
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

module.exports = { badgeDataForMember, getTemplate, cleanupTeamsForParent };
