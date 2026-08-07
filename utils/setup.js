const db = require('../db');

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
       WHERE stm.team_id = ? AND m.active = 1
       ORDER BY m.name COLLATE NOCASE`
    )
    .all(teamId);
}

function setTeamLeader(teamId, leaderId) {
  db.prepare('UPDATE setup_teams SET leader_id = ? WHERE id = ?').run(leaderId || null, teamId);
}

module.exports = { teamsForDay, membersForTeam, setTeamLeader };
