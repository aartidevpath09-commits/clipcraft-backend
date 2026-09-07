const express = require("express");
const pool = require("../config/db");
const authMiddleware = require("../middleware/authMiddleware");
const {
  deleteAllMediaForProject,
} = require("../services/projectMediaCleanup.service");

const router = express.Router();

// Create project
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { title, aspect_ratio, fps } = req.body;

    if (!title) {
      return res.status(400).json({
        message: "Project title is required",
      });
    }

    const result = await pool.query(
      `INSERT INTO projects (user_id, title, aspect_ratio, fps)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, title, aspect_ratio, fps,
                 timeline_json, revision, created_at, updated_at`,
      [req.user.userId, title, aspect_ratio || "16:9", fps || 30]
    );

    return res.status(201).json({
      message: "Project created successfully",
      project: result.rows[0],
    });
  } catch (error) {
    console.error("Create project error:", error);

    return res.status(500).json({
      message: "Something went wrong while creating project",
    });
  }
});

// Get all projects of logged-in user
router.get("/", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, title, aspect_ratio, fps,
              timeline_json, revision, created_at, updated_at
       FROM projects
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.userId]
    );

    return res.status(200).json({
      projects: result.rows,
    });
  } catch (error) {
    console.error("Get projects error:", error);

    return res.status(500).json({
      message: "Something went wrong while fetching projects",
    });
  }
});

// Get single project
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, title, aspect_ratio, fps,
              timeline_json, revision, created_at, updated_at
       FROM projects
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    return res.status(200).json({
      project: result.rows[0],
    });
  } catch (error) {
    console.error("Get project error:", error);

    return res.status(500).json({
      message: "Something went wrong while fetching project",
    });
  }
});

// Save / update project timeline
router.put("/:id/timeline", authMiddleware, async (req, res) => {
  try {
    const { timeline_json, revision } = req.body;

    if (timeline_json === undefined) {
      return res.status(400).json({
        message: "timeline_json is required",
      });
    }

    if (revision === undefined) {
      return res.status(400).json({
        message: "revision is required",
      });
    }

    // First check project ownership
    const projectResult = await pool.query(
      `SELECT id, user_id, revision
       FROM projects
       WHERE id = $1`,
      [req.params.id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    if (projectResult.rows[0].user_id !== req.user.userId) {
      return res.status(403).json({
        message: "You do not have permission to modify this project",
      });
    }

    // Then check revision and update
    const result = await pool.query(
      `UPDATE projects
       SET timeline_json = $1,
           revision = revision + 1,
           updated_at = NOW()
       WHERE id = $2
         AND user_id = $3
         AND revision = $4
       RETURNING id, user_id, title, aspect_ratio, fps,
                 timeline_json, revision, created_at, updated_at`,
      [timeline_json, req.params.id, req.user.userId, revision]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        message: "Revision conflict. Project was modified by another request.",
      });
    }

    return res.status(200).json({
      message: "Timeline saved successfully",
      project: result.rows[0],
    });
  } catch (error) {
    console.error("Save timeline error:", error);

    return res.status(500).json({
      message: "Something went wrong while saving timeline",
    });
  }
});

// Update project
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { title, aspect_ratio, fps } = req.body;

    const result = await pool.query(
      `UPDATE projects
       SET title = COALESCE($1, title),
           aspect_ratio = COALESCE($2, aspect_ratio),
           fps = COALESCE($3, fps),
           updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING id, user_id, title, aspect_ratio, fps,
                 timeline_json, revision, created_at, updated_at`,
      [title, aspect_ratio, fps, req.params.id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    return res.status(200).json({
      message: "Project updated successfully",
      project: result.rows[0],
    });
  } catch (error) {
    console.error("Update project error:", error);

    return res.status(500).json({
      message: "Something went wrong while updating project",
    });
  }
});

// Delete project
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    // First verify that the project exists and belongs to the logged-in user
    const projectResult = await pool.query(
      `SELECT id
       FROM projects
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({
        message: "Project not found",
      });
    }

    // Delete all media associated with the project first
    await deleteAllMediaForProject(req.params.id);

    // Then delete the project itself
    await pool.query(
      `DELETE FROM projects
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    );

    return res.status(200).json({
      message: "Project deleted successfully",
    });
  } catch (error) {
    console.error("Delete project error:", error);

    return res.status(500).json({
      message: "Something went wrong while deleting project",
    });
  }
});

module.exports = router;