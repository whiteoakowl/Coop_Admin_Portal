const db = require('../db');
const { formatDateLabel } = require('./dates');
const { DAYS, DAY_LABELS, isValidDay } = require('./days');

function getListByDay(day) {
  return db.prepare('SELECT * FROM volunteer_lists WHERE day = ?').get(day);
}

function getListsByRosterId(rosterId) {
  return db.prepare('SELECT * FROM volunteer_lists WHERE roster_id = ?').all(rosterId);
}

function sectionsForList(listId) {
  return db.prepare('SELECT * FROM volunteer_sections WHERE volunteer_list_id = ? ORDER BY position').all(listId);
}

function datesForList(listId) {
  return db
    .prepare('SELECT session_date FROM volunteer_dates WHERE volunteer_list_id = ? ORDER BY session_date ASC')
    .all(listId)
    .map((r) => r.session_date);
}

function membersForList(listId) {
  return db
    .prepare(
      `SELECT m.*, vm.section_id AS sectionId FROM members m
       JOIN volunteer_members vm ON vm.member_id = m.id
       WHERE vm.volunteer_list_id = ? AND m.active = 1
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(listId);
}

// Builds { sections: [{...section, members: [{member, cells:[{date,position,room}]}]}], dates, dateLabels }
// for a list, optionally narrowed to a single date.
function buildListGrid(listId, dateFilter) {
  const sections = sectionsForList(listId);
  const members = membersForList(listId);
  const dates = dateFilter ? [dateFilter] : datesForList(listId);

  let sql = 'SELECT member_id, session_date, position, room FROM volunteer_assignments WHERE volunteer_list_id = ?';
  const params = [listId];
  if (dateFilter) {
    sql += ' AND session_date = ?';
    params.push(dateFilter);
  }
  const assignmentRows = dates.length ? db.prepare(sql).all(...params) : [];
  const byKey = {};
  for (const a of assignmentRows) byKey[`${a.member_id}|${a.session_date}`] = a;

  const sectionMap = {};
  for (const s of sections) sectionMap[s.id] = { ...s, members: [] };
  for (const m of members) {
    const bucket = sectionMap[m.sectionId];
    if (!bucket) continue;
    bucket.members.push({
      member: m,
      cells: dates.map((d) => {
        const a = byKey[`${m.id}|${d}`];
        return { date: d, position: a ? a.position || '' : '', room: a ? a.room || '' : '' };
      }),
    });
  }

  return {
    sections: Object.values(sectionMap),
    dates,
    dateLabels: dates.map(formatDateLabel),
  };
}

module.exports = {
  DAYS,
  DAY_LABELS,
  isValidDay,
  getListByDay,
  getListsByRosterId,
  sectionsForList,
  datesForList,
  membersForList,
  buildListGrid,
};
