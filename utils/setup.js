const db = require('../db');
const { byLastName } = require('./members');

function teamsForDay(day) {
  return db
    .prepare(
      `SELECT st.*, m.name AS leaderName
       FROM setup_teams st
       LEFT JOIN members m ON m.id = st.leader_id AND m.active = 1
       WHERE st.day = ?
       ORDER BY st.title COLLATE NOCASE`
    )
    .all(day);
}

function membersForTeam(teamId) {
  return db
    .prepare(
      `SELECT m.* FROM members m
       JOIN setup_team_members stm ON stm.member_id = m.id
       WHERE stm.team_id = ? AND m.active = 1`
    )
    .all(teamId)
    .sort(byLastName);
}

function setTeamLeader(teamId, leaderId) {
  db.prepare('UPDATE setup_teams SET leader_id = ? WHERE id = ?').run(leaderId || null, teamId);
}

// The team card's Edit popup - title/description/leader all saved
// together in one Save action (see routes/admin-setup.js), unlike the
// old inline auto-submitting leader select this replaced.
function updateTeam(teamId, fields) {
  db.prepare('UPDATE setup_teams SET title = ?, description = ?, leader_id = ? WHERE id = ?').run(
    fields.title,
    fields.description || null,
    fields.leaderId || null,
    teamId
  );
}

module.exports = { teamsForDay, membersForTeam, setTeamLeader, updateTeam };
