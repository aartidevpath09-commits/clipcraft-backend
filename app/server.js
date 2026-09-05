const express = require("express");
const cors = require("cors");
require("dotenv").config();

const pool = require("./config/db");
const authRoutes = require("./routes/auth");
const projectRoutes = require("./routes/projects");
const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/projects", projectRoutes);
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

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`ClipCraft Backend running on port ${PORT}`);
});