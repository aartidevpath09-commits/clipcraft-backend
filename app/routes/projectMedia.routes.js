/**
 * Member 2's project-scoped media listing, mounted at /api/v1/projects in
 * app/server.js.
 *
 * This router defines ONLY GET /:projectId/media. It deliberately does not
 * touch any other path under /api/v1/projects (no GET /:projectId, no
 * POST /, no PATCH/DELETE /:projectId, etc.) -- that whole namespace
 * otherwise belongs to Member 1's project CRUD, which can be mounted at the
 * same /api/v1/projects prefix later without colliding, since Express
 * matches on the full path pattern and /:projectId/media never matches a
 * bare /:projectId request.
 *
 * Sprint 3: authorization now follows the expected
 * authenticateToken -> req.user.userId -> requireProjectAccess -> req.project
 * flow (see app/middleware/requireProjectAccess.js) instead of the
 * controller re-deriving ownership itself.
 */

const express = require("express");
const { devAuthRequired } = require("../middleware/devAuth");
const { requireProjectAccess } = require("../middleware/requireProjectAccess");
const mediaController = require("../controllers/media.controller");

const router = express.Router();

router.use(devAuthRequired);

router.get("/:projectId/media", requireProjectAccess, mediaController.listByProject);

module.exports = router;
