/**
 * Controllers backing the isolated dev-only auth/project routes.
 * See app/middleware/devAuth.js for why this exists and why it's temporary.
 */

const crypto = require("crypto");
const pool = require("../config/db");
const { issueDevToken } = require("../middleware/devAuth");
const { checkProjectOwnership } = require("../services/ownership.service");
const { deleteAllMediaForProject } = require("../services/projectMediaCleanup.service");

async function login(req, res, next) {
  try {
    const { displayName, userId } = req.body || {};

    if (userId) {
      const result = await pool.query("SELECT id FROM dev_users WHERE id = $1", [userId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "NOT_FOUND", message: "Unknown dev userId" });
      }
      return res.json({ userId, token: issueDevToken(userId) });
    }

    const newUserId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO dev_users (id, display_name) VALUES ($1, $2)",
      [newUserId, displayName || "Dev User"]
    );

    return res.status(201).json({ userId: newUserId, token: issueDevToken(newUserId) });
  } catch (err) {
    next(err);
  }
}

async function createProject(req, res, next) {
  try {
    const { name } = req.body || {};
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "name is required" });
    }

    const projectId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO dev_projects (id, owner_id, name) VALUES ($1, $2, $3)",
      [projectId, req.devUser.id, name]
    );

    return res.status(201).json({ id: projectId, ownerId: req.devUser.id, name });
  } catch (err) {
    next(err);
  }
}

async function listProjects(req, res, next) {
  try {
    const result = await pool.query(
      "SELECT id, name, created_at FROM dev_projects WHERE owner_id = $1 ORDER BY created_at DESC",
      [req.devUser.id]
    );
    return res.json({ projects: result.rows });
  } catch (err) {
    next(err);
  }
}

/**
 * DEMONSTRATES the project-deletion media-cleanup contract Member 1's real
 * project deletion should follow (see app/services/projectMediaCleanup.service.js).
 * This dev-only project deletion stands in for Member 1's not-yet-built
 * real one purely so the contract is testable today; it is not meant to be
 * Member 2's implementation of project CRUD.
 */
async function deleteProject(req, res, next) {
  try {
    const { id: projectId } = req.params;

    const ownership = await checkProjectOwnership(projectId, req.devUser.id);
    if (!ownership.exists) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Project not found" });
    }
    if (!ownership.isOwner) {
      return res.status(403).json({ error: "FORBIDDEN", message: "You do not have access to this project" });
    }

    // Contract: clean up media (files + rows) BEFORE deleting the project
    // row. See projectMediaCleanup.service.js for why the order matters.
    await deleteAllMediaForProject(projectId);
    await pool.query("DELETE FROM dev_projects WHERE id = $1", [projectId]);

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { login, createProject, listProjects, deleteProject };
