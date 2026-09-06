/**
 * Project deletion integration point for Member 1.
 *
 * Member 2 does NOT own project deletion -- Member 1 does. This file exists
 * solely so that when Member 1 implements real project deletion, media
 * doesn't get orphaned: it is the one function their project-deletion flow
 * should call.
 *
 * CONTRACT: call `deleteAllMediaForProject(projectId)` BEFORE deleting the
 * project row itself, then delete the project row. Order matters:
 *   1. deleteAllMediaForProject(projectId)   <- removes files AND db rows
 *   2. DELETE FROM projects WHERE id = $1    <- Member 1's own code
 *
 * Why call this instead of just deleting the project row and letting the
 * database cascade handle it: media_assets.project_id has an
 * ON DELETE CASCADE foreign key (see migration 003), so deleting a project
 * row will always remove the matching media_assets ROWS even if this
 * function is never called -- that's a DB-level safety net against orphan
 * rows. But Postgres cannot touch the filesystem, so cascade alone leaves
 * every original/proxy/thumbnail/waveform file behind on disk with no
 * database row pointing at it anymore, and nothing will ever clean those up
 * automatically. Calling this function first removes the files too, so
 * nothing is orphaned on disk OR in the database either way.
 *
 * This function is written against the current schema regardless of which
 * table `project_id` ultimately references (today: the temporary
 * `dev_projects` placeholder; later: Member 1's real `projects` table) --
 * it only ever queries media_assets by project_id, so no change is needed
 * here when that cutover happens.
 */

const mediaAssets = require("../db/mediaAssets.repository");
const storage = require("./storage.service");

/**
 * Deletes every media asset belonging to a project: all storage files
 * (original + derived) and all media_assets rows. Safe to call on a project
 * with zero media assets (no-op). Idempotent -- safe to call twice.
 *
 * @param {string} projectId
 * @returns {Promise<{ deletedCount: number }>}
 */
async function deleteAllMediaForProject(projectId) {
  const assets = await mediaAssets.findByProjectId(projectId);

  for (const asset of assets) {
    await storage.deleteAssetDirectory(asset.id).catch((err) => {
      // Log and continue -- a filesystem cleanup failure for one asset
      // should not stop the rest of the project's media from being
      // removed, and should never block project deletion itself.
      console.error(
        `[projectMediaCleanup] failed to remove storage for asset ${asset.id} (project ${projectId}):`,
        err.message
      );
    });
  }

  await mediaAssets.deleteAllByProjectId(projectId);

  return { deletedCount: assets.length };
}

module.exports = { deleteAllMediaForProject };
