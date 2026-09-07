const express = require("express");

const {
  exportVideo,
  getExportJob,
  getAllExportJobs,
  retryExportJob,
  downloadExport,
  getQueueStatusController,
  getQueueSummary
} = require("../controllers/export.controller");

const router = express.Router();

// Create export job
router.post("/export", exportVideo);

// Get all export jobs
router.get("/export", getAllExportJobs);

// Get render queue status
router.get("/export/queue/status", getQueueStatusController);

// Get export queue summary
router.get("/export/queue/summary", getQueueSummary);

// Retry failed export job
router.post("/export/:id/retry", retryExportJob);

// Download completed export
router.get("/export/:id/download", downloadExport);

// Get export job status
router.get("/export/:id", getExportJob);

module.exports = router;