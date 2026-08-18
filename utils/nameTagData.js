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
// alone). The "Monday - "/"Wednesday - " label is baked directly into
// each string, so the default parent layout's field element(s) don't
// need their own separate static label text alongside them - a later
// request specifically asked for a hyphen here ("Monday - Team 1"), not
// scheduleCardData.js's own colon convention ("Parent Phone: 555-1234")
// this originally matched. "—" for a day the parent isn't on any team,
// matching this app's own established "blank schedule cell" convention
// (see public/js/name-tag-render-core.js's table renderer) rather than
// leaving the line looking broken/cut off.
//
// setupCleanupDays hands the SAME two lines back as an array - the
// current default badge layout (utils/nameTagBadge.js) binds one shared
// element to this field so both days "share a text space" instead of
// sitting in two separately-positioned elements (name-tag-render-core.js's
// renderTextEl renders an array field as one stacked line per entry).
// mondaySetupCleanup/wednesdaySetupCleanup are kept alongside it, not
// replaced, so an already-saved layout that still references either one
// directly (from before this field existed) keeps rendering correctly.
function setupCleanupJobLabels(teamRows) {
  const byDay = { monday: [], wednesday: [] };
  for (const row of teamRows) if (byDay[row.day]) byDay[row.day].push(row.title);
  const mondayLine = 'Monday - ' + (byDay.monday.length ? byDay.monday.join(', ') : '—');
  const wednesdayLine = 'Wednesday - ' + (byDay.wednesday.length ? byDay.wednesday.join(', ') : '—');
  return {
    mondaySetupCleanup: mondayLine,
    wednesdaySetupCleanup: wednesdayLine,
    setupCleanupDays: [mondayLine, wednesdayLine],
  };
}

// A student's grade_level is picked from utils/classSchedule.js's
// GRADE_LEVELS list - either an ordinal number ("1st".."12th") or a named
// early-childhood level (Infant, Toddler, Preschool, PreK, Kindergarten)
// that already reads fine on its own. A real request: the ordinal ones
// read ambiguously alone on a badge ("3rd" - third grade? third place?) -
// pair it with the word "Grade". A follow-up request then asked for that
// pairing to stack ("3rd" over "Grade") rather than sit on one line, so
// each half can run bigger - returned as a 2-line array for the ordinal
// case (name-tag-render-core.js's renderTextEl treats an array value as
// one stacked line per entry, the same convention setupCleanupDays above
// already uses), left as a single unstacked string for the named levels
// since "Kindergarten" / "Grade" stacked under it doesn't make sense.
function gradeLevelLabel(gradeLevel) {
  const trimmed = (gradeLevel || '').trim();
  if (!trimmed) return '';
  return /^\d+(st|nd|rd|th)$/i.test(trimmed) ? [trimmed, 'Grade'] : trimmed;
}

// A real request: EVERY name tag (student and parent alike) should stack
// a member's first name over their last name instead of running both on
// one line - freeing up real width lets the auto-fit font size for each
// half grow larger than a single "First Last" line could ever reach
// before hitting the box's width. Splits on the FIRST space only, so a
// multi-word last name ("Mary Jane Smith") reads as "Mary" / "Jane Smith"
// rather than splitting awkwardly mid-surname. A single-word name (no
// space at all - a mononym, or a placeholder like "Guest") returns just
// the one line rather than a blank second line.
function splitNameLines(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '';
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return trimmed;
  return [trimmed.slice(0, spaceIdx), trimmed.slice(spaceIdx + 1).trim()];
}

// member_code is the permanent 6-digit ID assigned at creation (see
// db/schema.sql's own comment) - shown as "ID#123456" so it reads as a
// label rather than a bare number the eye might mistake for something
// else on the tag.
function memberCodeLabel(member) {
  return member.member_code ? `ID#${member.member_code}` : '';
}

// An admin member's admin_position_id is just a foreign key - the badge
// needs the position's own title text (utils/adminPositions.js manages the
// Settings-side list it points at). Optional (a real request: "Add an
// optional dropdown menu"), so no position selected is simply a blank
// field, same as every other optional badge field in this file.
async function adminPositionTitle(adminPositionId) {
  if (!adminPositionId) return '';
  const row = await db.prepare('SELECT title FROM admin_positions WHERE id = ?').get(adminPositionId);
  return row ? row.title : '';
}

// Batch version for badgeDataForMembers below - one query for every admin
// member's position instead of one per member, the same N+1 shape
// cleanupTeamRowsForParents already avoids for parents.
async function adminPositionTitlesByIds(ids) {
  const uniqueIds = [...new Set(ids.filter((id) => id != null))];
  if (uniqueIds.length === 0) return {};
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT id, title FROM admin_positions WHERE id IN (${placeholders})`).all(...uniqueIds);
  const byId = {};
  for (const r of rows) byId[r.id] = r.title;
  return byId;
}

// The field values a badge template can place on a member's tag.
async function badgeDataForMember(member) {
  const memberCode = memberCodeLabel(member);
  if (member.member_type === 'parent') {
    const teamRows = await cleanupTeamRowsForParent(member.id);
    return {
      name: splitNameLines(member.name),
      cleanupTeam: teamRows.map((r) => r.title).join(', '),
      ...setupCleanupJobLabels(teamRows),
      memberCode,
      barcodeValue: member.barcode,
    };
  }
  // A real request: "an admin name tag... logo, name, barcode, id number
  // and the admin position" - co-op staff/leaders (member_type === 'admin'),
  // no grade/allergies (those are student-only concepts).
  if (member.member_type === 'admin') {
    return {
      name: splitNameLines(member.name),
      adminPosition: await adminPositionTitle(member.admin_position_id),
      memberCode,
      barcodeValue: member.barcode,
    };
  }
  return {
    name: splitNameLines(member.name),
    gradeLevel: gradeLevelLabel(member.grade_level),
    allergies: member.medical_notes || '',
    memberCode,
    barcodeValue: member.barcode,
  };
}

// Batch version of badgeDataForMember for a bulk print flow (Design/
// Print's own Name Tags print, and utils/cardPairs.js's Name Tags +
// Schedule Cards / Front & Back Duplex) - computes every parent's cleanup
// team membership (and every admin's position title) in ONE query each
// instead of one per member, the same N+1 shape that made a real
// ~800-member bulk print time out. Returns
// { [memberId]: <same shape badgeDataForMember returns> }.
async function badgeDataForMembers(members) {
  const parentIds = members.filter((m) => m.member_type === 'parent').map((m) => m.id);
  const teamRowsByParent = await cleanupTeamRowsForParents(parentIds);
  const adminIds = members.filter((m) => m.member_type === 'admin').map((m) => m.admin_position_id);
  const positionTitleById = await adminPositionTitlesByIds(adminIds);
  const result = {};
  for (const member of members) {
    const memberCode = memberCodeLabel(member);
    if (member.member_type === 'parent') {
      const teamRows = teamRowsByParent[member.id] || [];
      result[member.id] = {
        name: splitNameLines(member.name),
        cleanupTeam: teamRows.map((r) => r.title).join(', '),
        ...setupCleanupJobLabels(teamRows),
        memberCode,
        barcodeValue: member.barcode,
      };
    } else if (member.member_type === 'admin') {
      result[member.id] = {
        name: splitNameLines(member.name),
        adminPosition: positionTitleById[member.admin_position_id] || '',
        memberCode,
        barcodeValue: member.barcode,
      };
    } else {
      result[member.id] = { name: splitNameLines(member.name), gradeLevel: gradeLevelLabel(member.grade_level), allergies: member.medical_notes || '', memberCode, barcodeValue: member.barcode };
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

module.exports = { badgeDataForMember, badgeDataForMembers, getTemplate, cleanupTeamsForParent, cleanupTeamsForParents, gradeLevelLabel, splitNameLines };
