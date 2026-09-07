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
 * Storage cleanup is completed successfully for every asset before database
 * rows are deleted. If any filesystem cleanup fails, the error is propagated
 * and media_assets rows are kept so that the failed cleanup can be retried.
 */

const mediaAssets = require("../db/mediaAssets.repository");
const storage = require("./storage.service");

/**
 * Deletes every media asset belonging to a project: all storage files
 * (original + derived) and all media_assets rows. Safe to call on a project
 * with zero media assets (no-op).
 *
 * If storage cleanup fails for any asset, the error is propagated and the
 * database rows are NOT deleted.
 *
 * @param {string} projectId
 * @returns {Promise<{ deletedCount: number }>}
 */
async function deleteAllMediaForProject(projectId) {
  const assets = await mediaAssets.findByProjectId(projectId);

  for (const asset of assets) {
    try {
      await storage.deleteAssetDirectory(asset.id);
    } catch (err) {
      console.error(
        `[projectMediaCleanup] failed to remove storage for asset ${asset.id} (project ${projectId}):`,
        err.message
      );

      throw new Error(
        `Media storage cleanup failed for asset ${asset.id}`
      );
    }
  }

  await mediaAssets.deleteAllByProjectId(projectId);

  return { deletedCount: assets.length };
}

module.exports = { deleteAllMediaForProject };