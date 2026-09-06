/**
 * Isolated dev/test-only routes. See app/middleware/devAuth.js.
 * Mounted at /api/v1/dev in app/server.js, clearly separated from the real
 * media API surface.
 */

const express = require("express");
const { devAuthRequired } = require("../middleware/devAuth");
const devController = require("../controllers/dev.controller");

const router = express.Router();

router.post("/login", devController.login);
router.post("/projects", devAuthRequired, devController.createProject);
router.get("/projects", devAuthRequired, devController.listProjects);
// Demonstrates the project-deletion media-cleanup contract for Member 1 --
// see projectMediaCleanup.service.js. Not Member 2's project CRUD.
router.delete("/projects/:id", devAuthRequired, devController.deleteProject);

module.exports = router;
