const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./config/db");

// --- Media Management (Member 2) -------------------------------------------
// Added by Member 2. Only these two requires + the two app.use(...) route
// mounts below, plus the error-handling middleware at the bottom of this
// file, were added to this shared file -- nothing else here was changed.
const devRoutes = require("./routes/dev.routes");
const mediaRoutes = require("./routes/media.routes");
const projectMediaRoutes = require("./routes/projectMedia.routes"); // Sprint 2
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
// -----------------------------------------------------------------------------
const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const videoRoutes = require("./video-engine/routes");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/projects", projectRoutes);
app.use("/api/v1/video", videoRoutes);

app.get("/", (req, res) => {
  res.json({
    message: "ClipCraft Backend is running"
  });
});

app.get("/api/v1/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      status: "OK",
      database: "PostgreSQL connected",
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "ERROR",
      database: "PostgreSQL connection failed",
    });
  }
});

// --- Media Management (Member 2) -------------------------------------------
app.use("/api/v1/dev", devRoutes); // isolated dev/test-only auth -- see app/middleware/devAuth.js
app.use("/api/v1/media", mediaRoutes);
// Sprint 2: GET /:projectId/media only -- rest of /api/v1/projects is
// Member 1's project CRUD namespace, safe to mount alongside this.
app.use("/api/v1/projects", projectMediaRoutes);

app.use(notFoundHandler);
app.use(errorHandler); // must be the last app.use() -- Express error middleware
// -----------------------------------------------------------------------------

const PORT = process.env.PORT || 5000;

// --- Media Management (Member 2) -------------------------------------------
// Only start listening when this file is run directly (`node app/server.js` /
// `npm start` / `npm run dev`), not when required as a module -- this lets
// the test suite (tests/api.test.js) import `app` and attach it to its own
// ephemeral port without a second server fighting over PORT. Behavior for
// every existing way of running the app is unchanged.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`ClipCraft Backend running on port ${PORT}`);
  });
}

module.exports = app;
// -----------------------------------------------------------------------------