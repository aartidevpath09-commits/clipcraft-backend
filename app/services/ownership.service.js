/**
 * Project-ownership check used to gate media upload/access/delete.
 *
 * This talks to the temporary `dev_projects` placeholder table (see
 * app/db/migrations/001_dev_placeholder_auth.sql). When Member 1 ships real
 * projects, only this file's queries need to change (to point at the real
 * `projects` table) -- callers (upload parser, media controller) only ever
 * see the {exists, isOwner} shape below, never the underlying table name.
 */

const pool = require("../config/db");

/**
 * @param {string} projectId
 * @param {string} userId
 * @returns {Promise<{ exists: boolean, isOwner: boolean }>}
 */
async function checkProjectOwnership(projectId, userId) {
  const result = await pool.query(
    "SELECT owner_id FROM dev_projects WHERE id = $1",
    [projectId]
  );

  if (result.rows.length === 0) {
    return { exists: false, isOwner: false };
  }

  return { exists: true, isOwner: result.rows[0].owner_id === userId };
}

module.exports = { checkProjectOwnership };
