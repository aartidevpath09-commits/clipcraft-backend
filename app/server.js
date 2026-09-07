require("dotenv").config();

const pool = require("./config/db");
const express = require("express");
const cors = require("cors");
const exportRoutes = require("./routes/export.routes");
const { processQueue } = require("./workers/renders.workers");

const app = express();

app.use(cors());
app.use(express.json());

// Export routes
app.use("/api/v1", exportRoutes);

// Root route
app.get("/", (req, res) => {
  res.json({
    message: "ClipCraft Backend is running"
  });
});

// Health check
app.get("/api/v1/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      status: "OK",
      database: "PostgreSQL connected",
      time: result.rows[0].now
    });

  } catch (error) {
    console.error("DATABASE ERROR:", error.message);

    res.status(500).json({
      status: "ERROR",
      database: "PostgreSQL connection failed",
      error: error.message
    });
  }
});

// Export route check
app.get("/api/v1/export-test", (req, res) => {
  res.json({
    message: "Export routes are working"
  });
});

const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, () => {
  console.log(`ClipCraft Backend running on port ${PORT}`);
  console.log("Export routes loaded");
});