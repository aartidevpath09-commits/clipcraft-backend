const { getNextJob, addToQueue } = require("../services/queue.service");
const { renderVideo } = require("../services/render.service");
const pool = require("../config/db");

let isProcessing = false;


// ==========================================
// Load queued jobs from PostgreSQL
// ==========================================
async function loadQueuedJobs() {
  try {
    const result = await pool.query(
      `SELECT *
       FROM export_jobs
       WHERE status = $1
       ORDER BY created_at ASC`,
      ["queued"]
    );

    result.rows.forEach((job) => {
      addToQueue(job);
    });

    console.log(`Loaded ${result.rows.length} queued job(s)`);
  } catch (error) {
    console.error("QUEUE LOAD ERROR:", error.message);
  }
}


// ==========================================
// Process one render job
// ==========================================
async function processQueue() {
  // Prevent multiple jobs from running simultaneously
  if (isProcessing) {
    return;
  }

  const job = getNextJob();

  if (!job) {
    return;
  }

  isProcessing = true;

  try {
    console.log(`Starting render job: ${job.id}`);

    // Mark job as processing
    await pool.query(
      `UPDATE export_jobs
       SET status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      ["processing", job.id]
    );

    // Render video
    await renderVideo(
      job.input_file,
      job.output_file
    );

    // Mark job as completed
    await pool.query(
      `UPDATE export_jobs
       SET status = $1,
           error_message = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      ["completed", job.id]
    );

    console.log(`Render completed: ${job.id}`);

  } catch (error) {
    console.error(`Render failed: ${job.id}`);
    console.error("ERROR MESSAGE:", error.message);

    // Mark job as failed
    try {
      await pool.query(
        `UPDATE export_jobs
         SET status = $1,
             error_message = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        ["failed", error.message, job.id]
      );
    } catch (dbError) {
      console.error(
        "FAILED TO UPDATE JOB STATUS:",
        dbError.message
      );
    }

  } finally {
    isProcessing = false;
  }
}


// ==========================================
// Initialize queued jobs
// ==========================================
loadQueuedJobs();


// ==========================================
// Start queue worker
// ==========================================
setInterval(processQueue, 1000);


module.exports = {
  processQueue,
  loadQueuedJobs
};