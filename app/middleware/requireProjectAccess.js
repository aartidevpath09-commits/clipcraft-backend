/**
 * requireProjectAccess -- Sprint 3 integration seam matching Member 1's
 * expected authorization flow for project-scoped routes:
 *
 *   Request -> authenticateToken -> req.user.userId -> requireProjectAccess -> req.project -> handler
 *
 * Reads `:projectId` from the route params, verifies the authenticated
 * caller (req.user.userId, set by whichever auth middleware runs immediately
 * before this one) owns it via the same ownership.service used everywhere
 * else in this module, and attaches the project as `req.project` so the
 * handler never has to re-derive ownership itself.
 *
 * Field name note: standardized on `req.user.userId` (not `req.user.id`) to
 * match Member 1's real auth middleware, which decodes its JWT as
 * `{ userId, email }` and never sets `.id`. See app/middleware/devAuth.js
 * for the matching dev-auth shape.
 *
 * This is Member 2's implementation of the SHAPE Member 1's real
 * requireProjectAccess should have. It intentionally only depends on
 * req.user.userId, req.params.projectId, and ownership.service.js -- so once
 * Member 1's real `projects` table exists, cutover is just pointing
 * ownership.service.js's query at it (see that file). This middleware can
 * stay exactly as-is, OR be swapped for Member 1's own real
 * requireProjectAccess if their access model ends up richer than single-
 * owner checks (e.g. shared/collaborator projects) -- either way, nothing
 * downstream needs to change, since every handler that uses this only ever
 * reads `req.project`.
 *
 * Only used for the one route that is genuinely keyed by a :projectId path
 * param (GET /api/v1/projects/:projectId/media). Asset-id-keyed routes
 * (stream/thumbnail/proxy/waveform/delete/metadata) resolve ownership via
 * the asset's own project_id instead (see media.controller.js's
 * loadOwnedAsset) -- there is no :projectId on those URLs to check against,
 * so this middleware doesn't apply to them.
 */

const { ApiError } = require("../utils/apiError");
const { checkProjectOwnership } = require("../services/ownership.service");
const { isUuid } = require("../utils/isUuid");

async function requireProjectAccess(req, res, next) {
  try {
    const { projectId } = req.params;

    if (!isUuid(projectId)) {
      throw ApiError.badRequest("Invalid projectId");
    }
    if (!req.user || !req.user.userId) {
      // Should be unreachable in practice (the auth middleware ahead of this
      // one always sets req.user first) -- fail closed rather than assume.
      throw ApiError.unauthenticated();
    }

    const ownership = await checkProjectOwnership(projectId, req.user.userId);
    if (!ownership.exists) {
      throw ApiError.notFound("Project not found");
    }
    if (!ownership.isOwner) {
      throw ApiError.forbidden("You do not have access to this project");
    }

    req.project = { id: projectId };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireProjectAccess };
