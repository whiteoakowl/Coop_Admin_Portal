const db = require('../db');

function teamsForDay(day) {
  return db.prepare('SELECT * FROM setup_teams WHERE day = ? ORDER BY title COLLATE NOCASE').all(day);
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

module.exports = { teamsForDay, membersForTeam };
