const fs = require("fs");
const path = require("path");

const {
  addToQueue,
  getQueueStatus
} = require("../services/queue.service");

const pool = require("../config/db");


// ==========================================
// 1. Create Export Job
// ==========================================
async function exportVideo(req, res) {
  const { inputFile, outputFile } = req.body;

  // Validate request body
  if (
    typeof inputFile !== "string" ||
    typeof outputFile !== "string" ||
    !inputFile.trim() ||
    !outputFile.trim()
  ) {
    return res.status(400).json({
      message: "inputFile and outputFile are required and must be strings"
    });
  }

  // Remove accidental spaces
  const cleanInputFile = inputFile.trim();
  const cleanOutputFile = outputFile.trim();

  // Check input file
  if (!fs.existsSync(cleanInputFile)) {
    return res.status(400).json({
      message: "Input file not found",
      inputFile: cleanInputFile
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO export_jobs
       (id, input_file, output_file, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [
        Date.now().toString(),
        cleanInputFile,
        cleanOutputFile,
        "queued"
      ]
    );

    const job = result.rows[0];

    // Add job to render queue
    addToQueue(job);

    res.status(202).json({
      message: "Video export added to queue",
      job
    });

  } catch (error) {
    console.error("EXPORT JOB ERROR:", error.message);

    res.status(500).json({
      message: "Failed to create export job",
      error: error.message
    });
  }
}


// ==========================================
// 2. Get Single Export Job
// ==========================================
async function getExportJob(req, res) {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT
         id,
         input_file,
         output_file,
         status,
         error_message,
         created_at,
         updated_at
       FROM export_jobs
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Export job not found"
      });
    }

    res.json({
      job: result.rows[0]
    });

  } catch (error) {
    console.error("GET EXPORT JOB ERROR:", error.message);

    res.status(500).json({
      message: "Failed to get export job",
      error: error.message
    });
  }
}


// ==========================================
// 3. Get All Export Jobs
// ==========================================
async function getAllExportJobs(req, res) {
  try {
    const result = await pool.query(
      `SELECT
         id,
         input_file,
         output_file,
         status,
         error_message,
         created_at,
         updated_at
       FROM export_jobs
       ORDER BY created_at DESC`
    );

    res.json({
      count: result.rows.length,
      jobs: result.rows
    });

  } catch (error) {
    console.error("GET ALL EXPORT JOBS ERROR:", error.message);

    res.status(500).json({
      message: "Failed to get export jobs",
      error: error.message
    });
  }
}


// ==========================================
// 4. Retry Failed Export Job
// ==========================================
async function retryExportJob(req, res) {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT *
       FROM export_jobs
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Export job not found"
      });
    }

    const job = result.rows[0];

    if (job.status !== "failed") {
      return res.status(400).json({
        message: "Only failed export jobs can be retried",
        status: job.status
      });
    }

    const updatedResult = await pool.query(
      `UPDATE export_jobs
       SET status = $1,
           error_message = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      ["queued", id]
    );

    const updatedJob = updatedResult.rows[0];

    addToQueue(updatedJob);

    res.status(202).json({
      message: "Export job added to retry queue",
      job: updatedJob
    });

  } catch (error) {
    console.error("RETRY EXPORT JOB ERROR:", error.message);

    res.status(500).json({
      message: "Failed to retry export job",
      error: error.message
    });
  }
}


// ==========================================
// 5. Download Completed Export
// ==========================================
async function downloadExport(req, res) {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, output_file, status
       FROM export_jobs
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Export job not found"
      });
    }

    const job = result.rows[0];

    if (job.status !== "completed") {
      return res.status(400).json({
        message: "Export is not completed yet",
        status: job.status
      });
    }

    const outputPath = path.resolve(job.output_file);

    if (!fs.existsSync(outputPath)) {
      return res.status(404).json({
        message: "Output file not found"
      });
    }

    res.download(
      outputPath,
      path.basename(outputPath),
      (error) => {
        if (error) {
          console.error("DOWNLOAD ERROR:", error.message);
        }
      }
    );

  } catch (error) {
    console.error("DOWNLOAD EXPORT ERROR:", error.message);

    res.status(500).json({
      message: "Failed to download export",
      error: error.message
    });
  }
}


// ==========================================
// 6. Get Queue Status
// ==========================================
function getQueueStatusController(req, res) {
  const queueStatus = getQueueStatus();

  res.json({
    message: "Render queue status",
    queue: queueStatus
  });
}


// ==========================================
// 7. Get Queue Summary
// ==========================================
async function getQueueSummary(req, res) {
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'queued') AS queued,
         COUNT(*) FILTER (WHERE status = 'processing') AS processing,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM export_jobs`
    );

    res.json({
      message: "Export queue summary",
      summary: result.rows[0]
    });

  } catch (error) {
    console.error("QUEUE SUMMARY ERROR:", error.message);

    res.status(500).json({
      message: "Failed to get queue summary",
      error: error.message
    });
  }
}


// ==========================================
// Export Controller Functions
// ==========================================
module.exports = {
  exportVideo,
  getExportJob,
  getAllExportJobs,
  retryExportJob,
  downloadExport,
  getQueueStatusController,
  getQueueSummary
};