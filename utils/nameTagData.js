// DB-backed name tag lookups - split out from nameTagBadge.js (which holds
// the plain constants) to avoid a require cycle with db/index.js, which
// needs the constants at startup to seed default templates.
const db = require('../db');
const { DEFAULT_LAYOUTS } = require('./nameTagBadge');

// Every setup_team a parent belongs to, in { day, title } shape - the
// single source both cleanupTeamsForParent's flat "both days" list and
// setupCleanupJobLabels' per-day labels (below) are derived from, so
// there's only ever one query to keep in sync with setup_teams' own
// schema.
async function cleanupTeamRowsForParent(memberId) {
  return db
    .prepare(
      `SELECT st.day, st.title FROM setup_teams st
       JOIN setup_team_members stm ON stm.team_id = st.id
       WHERE stm.member_id = ? ORDER BY st.day, st.title`
    )
    .all(memberId);
}

async function cleanupTeamsForParent(memberId) {
  return (await cleanupTeamRowsForParent(memberId)).map((r) => r.title);
}

// Batch version of cleanupTeamRowsForParent for an arbitrary list of
// parent ids - one query for the whole list instead of one per parent,
// the same N+1 shape a real ~800-member bulk name tag print timed out on
// (see badgeDataForMembers below). Returns { [memberId]: [{day, title}, ...] }.
async function cleanupTeamRowsForParents(memberIds) {
  if (memberIds.length === 0) return {};
  const placeholders = memberIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT stm.member_id AS "memberId", st.day, st.title FROM setup_teams st
       JOIN setup_team_members stm ON stm.team_id = st.id
       WHERE stm.member_id IN (${placeholders}) ORDER BY st.day, st.title`
    )
    .all(...memberIds);
  const byMember = {};
  for (const row of rows) {
    if (!byMember[row.memberId]) byMember[row.memberId] = [];
    byMember[row.memberId].push({ day: row.day, title: row.title });
  }
  return byMember;
}

async function cleanupTeamsForParents(memberIds) {
  const rowsByMember = await cleanupTeamRowsForParents(memberIds);
  const byMember = {};
  for (const memberId of Object.keys(rowsByMember)) byMember[memberId] = rowsByMember[memberId].map((r) => r.title);
  return byMember;
}

// A real request: a parent's own Monday/Wednesday setup/cleanup job needs
// to show on their name tag, day by day (not the old cleanupTeam field's
// "both days smashed into one comma list" - a parent on Chairs Monday and
// Snacks Wednesday couldn't tell which team was which day from that
// alone). The "Monday: "/"Wednesday: " label is baked directly into the
// returned string, the same convention scheduleCardData.js's
// primaryParentPhone already uses ("Parent Phone: 555-1234") - so the
// default parent layout's field elements don't need their own separate
// static label text element alongside them. "—" for a day the parent
// isn't on any team, matching this app's own established "blank schedule
// cell" convention (see public/js/name-tag-render-core.js's table
// renderer) rather than leaving the line looking broken/cut off.
function setupCleanupJobLabels(teamRows) {
  const byDay = { monday: [], wednesday: [] };
  for (const row of teamRows) if (byDay[row.day]) byDay[row.day].push(row.title);
  return {
    mondaySetupCleanup: 'Monday: ' + (byDay.monday.length ? byDay.monday.join(', ') : '—'),
    wednesdaySetupCleanup: 'Wednesday: ' + (byDay.wednesday.length ? byDay.wednesday.join(', ') : '—'),
  };
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
    const teamRows = await cleanupTeamRowsForParent(member.id);
    return {
      name: member.name,
      cleanupTeam: teamRows.map((r) => r.title).join(', '),
      ...setupCleanupJobLabels(teamRows),
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
  const teamRowsByParent = await cleanupTeamRowsForParents(parentIds);
  const result = {};
  for (const member of members) {
    const memberCode = memberCodeLabel(member);
    if (member.member_type === 'parent') {
      const teamRows = teamRowsByParent[member.id] || [];
      result[member.id] = {
        name: member.name,
        cleanupTeam: teamRows.map((r) => r.title).join(', '),
        ...setupCleanupJobLabels(teamRows),
        memberCode,
        barcodeValue: member.barcode,
      };
    } else {
      result[member.id] = { name: member.name, gradeLevel: member.grade_level || '', allergies: member.medical_notes || '', memberCode, barcodeValue: member.barcode };
    }
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
