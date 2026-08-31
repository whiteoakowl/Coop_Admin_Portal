const db = require('../db');
const { formatDateLabel } = require('./dates');
const { DAYS, DAY_LABELS, isValidDay, defaultDay } = require('./days');
const { byLastName } = require('./members');

async function getListByDay(day) {
  return db.prepare('SELECT * FROM volunteer_lists WHERE day = ?').get(day);
}

// Floater Assignments (volunteer_members) only ever gets a parent added to
// it via the Volunteers admin page, never from a member's own profile - so
// there's nothing here to sync, only to clear if they're no longer a
// parent. Shared by both portals' own member Add/Edit forms (routes/
// admin-members.js, routes/main-admin-members.js) so converting a member
// away from parent can't leave stale floater rows behind from just one of
// the two.
async function clearVolunteerMembershipIfNotParent(memberId, memberType) {
  if (memberType === 'parent') return;
  await db.prepare('DELETE FROM volunteer_members WHERE member_id = ?').run(memberId);
}

async function sectionsForList(listId) {
  return db.prepare('SELECT * FROM volunteer_sections WHERE volunteer_list_id = ? ORDER BY position').all(listId);
}

async function datesForList(listId) {
  return (
    await db
      .prepare('SELECT session_date FROM volunteer_dates WHERE volunteer_list_id = ? ORDER BY session_date ASC')
      .all(listId)
  ).map((r) => r.session_date);
}

const RANKS = ['first', 'sometimes', 'backup'];
const RANK_LABELS = { first: 'Choose First', sometimes: 'Sometimes', backup: 'Backup Only' };
// Lower sorts first - used to order candidate floaters when the automated
// sub system picks who to auto-assign.
const RANK_ORDER = { first: 0, sometimes: 1, backup: 2 };

// One row per member on the list, each carrying the full set of section
// IDs they're assigned to (a member can float across multiple hours) and
// their rank (kept identical across all of that member's section rows).
async function membersForList(listId) {
  const rows = await db
    .prepare(
      `SELECT m.*, vm.section_id AS "sectionId", vm.rank AS rank FROM members m
       JOIN volunteer_members vm ON vm.member_id = m.id
       WHERE vm.volunteer_list_id = ? AND m.active = 1
       ORDER BY LOWER(m.name)`
    )
    .all(listId);

  const byMemberId = {};
  const order = [];
  for (const row of rows) {
    if (!byMemberId[row.id]) {
      byMemberId[row.id] = { ...row, sectionIds: [] };
      order.push(row.id);
    }
    byMemberId[row.id].sectionIds.push(row.sectionId);
  }
  return order.map((id) => byMemberId[id]).sort(byLastName);
}

// Writes rank to every one of memberId's section rows on this list, so a
// member has exactly one rank regardless of which/how many hours they're
// assigned to.
async function setMemberRank(listId, memberId, rank) {
  if (!RANKS.includes(rank)) return;
  await db.prepare('UPDATE volunteer_members SET rank = ? WHERE volunteer_list_id = ? AND member_id = ?').run(rank, listId, memberId);
}

// Everyone on one specific hour section, each carrying just that section's
// own rank - unlike setMemberRank above, a member's importance can now
// differ hour to hour (Floater Teams tab), so this reads/writes exactly
// one (list, member, section) row instead of every one of a member's rows.
async function membersForSection(listId, sectionId) {
  return (
    await db
      .prepare(
        `SELECT m.*, vm.rank AS rank FROM members m
         JOIN volunteer_members vm ON vm.member_id = m.id
         WHERE vm.volunteer_list_id = ? AND vm.section_id = ? AND m.active = 1`
      )
      .all(listId, sectionId)
  ).sort(byLastName);
}

async function setSectionRank(listId, memberId, sectionId, rank) {
  if (!RANKS.includes(rank)) return;
  await db.prepare('UPDATE volunteer_members SET rank = ? WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').run(
    rank,
    listId,
    memberId,
    sectionId
  );
}

// Removes a member from just one hour (Floater Teams card's trash can) -
// unlike remove-member elsewhere, which drops them from the whole list. A
// real bug report: this removal wasn't sticking - the DELETE below always
// worked, but the very next syncDayMemberRosters (routes/admin-volunteers.
// js's remove route calls it right after, to keep the day's rosters in
// sync) re-runs utils/classSchedule.js's autoAssignFloatersForDay first,
// which re-derives eligibility from scratch and put the same primary
// parent right back in, all within that same request. The explicit
// exclusion row below is what makes the removal actually stick - see its
// own table comment (supabase/migrations/*_volunteer_floater_exclusions.
// sql) and autoAssignFloatersForDay's own skip check.
async function removeMemberFromSection(listId, memberId, sectionId) {
  await db.prepare('DELETE FROM volunteer_members WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').run(
    listId,
    memberId,
    sectionId
  );
  await db
    .prepare('INSERT INTO volunteer_floater_exclusions (volunteer_list_id, member_id, section_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .run(listId, memberId, sectionId);
}

// Adds a member to one hour section (Floater Teams "+ Add Member" popup,
// and the CSV import) - default rank 'sometimes', same as the day list's
// own quick-add. A deliberate add always wins over a past removal, so this
// also clears any exclusion row removeMemberFromSection left behind for
// this exact (member, section) pair - otherwise re-adding someone by hand
// right after removing them would look like it worked (the row's back)
// but silently vanish again the next time anything re-syncs the day.
async function addMemberToSection(listId, memberId, sectionId) {
  await db
    .prepare(
      `INSERT INTO volunteer_members (volunteer_list_id, member_id, section_id, rank) VALUES (?, ?, ?, 'sometimes')
       ON CONFLICT (volunteer_list_id, member_id, section_id) DO NOTHING`
    )
    .run(listId, memberId, sectionId);
  await db.prepare('DELETE FROM volunteer_floater_exclusions WHERE volunteer_list_id = ? AND member_id = ? AND section_id = ?').run(
    listId,
    memberId,
    sectionId
  );
}

// Every (member, section) pair explicitly removed from this list and not
// since re-added - autoAssignFloatersForDay's own "don't put them back"
// check. A Set of "memberId-sectionId" strings, cheap to build once per
// sync call and check in a loop rather than a query per candidate.
async function excludedFloaterPairsForList(listId) {
  const rows = await db.prepare('SELECT member_id AS "memberId", section_id AS "sectionId" FROM volunteer_floater_exclusions WHERE volunteer_list_id = ?').all(listId);
  return new Set(rows.map((r) => `${r.memberId}-${r.sectionId}`));
}

// Builds { sections: [{...section, members: [{member, cells:[{date,position,room}]}]}], dates, dateLabels }
// for a list, optionally narrowed to a single date. A member appears once
// under every section they're assigned to, sharing the same per-date
// position/room across all of their hours.
async function buildListGrid(listId, dateFilter) {
  const sections = await sectionsForList(listId);
  const members = await membersForList(listId);
  const dates = dateFilter ? [dateFilter] : await datesForList(listId);

  let sql = 'SELECT member_id, session_date, position, room FROM volunteer_assignments WHERE volunteer_list_id = ?';
  const params = [listId];
  if (dateFilter) {
    sql += ' AND session_date = ?';
    params.push(dateFilter);
  }
  const assignmentRows = dates.length ? await db.prepare(sql).all(...params) : [];
  const byKey = {};
  for (const a of assignmentRows) byKey[`${a.member_id}|${a.session_date}`] = a;

  const sectionMap = {};
  for (const s of sections) sectionMap[s.id] = { ...s, members: [] };
  for (const m of members) {
    const entry = {
      member: m,
      cells: dates.map((d) => {
        const a = byKey[`${m.id}|${d}`];
        return { date: d, position: a ? a.position || '' : '', room: a ? a.room || '' : '' };
      }),
    };
    for (const sectionId of m.sectionIds) {
      const bucket = sectionMap[sectionId];
      if (bucket) bucket.members.push(entry);
    }
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
  defaultDay,
  clearVolunteerMembershipIfNotParent,
  RANKS,
  RANK_LABELS,
  RANK_ORDER,
  getListByDay,
  sectionsForList,
  datesForList,
  membersForList,
  setMemberRank,
  membersForSection,
  setSectionRank,
  removeMemberFromSection,
  addMemberToSection,
  excludedFloaterPairsForList,
  buildListGrid,
};
