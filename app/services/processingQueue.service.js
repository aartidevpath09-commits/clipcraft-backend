/**
 * In-process, fire-and-forget job seam.
 *
 * Sprint 1 has no real background worker (Redis/BullMQ, a worker process,
 * etc.) -- that is explicitly out of scope here and belongs to a later
 * phase. Express also has no built-in "after response is sent" hook, so
 * expensive ffprobe/ffmpeg work is scheduled with setImmediate() to run
 * after the current response has been flushed, rather than blocking the
 * request handler.
 *
 * Every caller goes through `enqueue()` rather than calling setImmediate
 * directly, so swapping this for a real queue later (e.g. `queue.add(...)`)
 * touches exactly one file.
 */

function enqueue(jobFn) {
  setImmediate(() => {
    Promise.resolve()
      .then(jobFn)
      .catch((err) => {
        // This is the last line of defense: every job function is expected
        // to catch and record its own failures (see processing.service.js).
        // Logging here only catches a truly unexpected bug in a job itself.
        console.error("[processingQueue] Unhandled error in background job:", err.message);
      });
  });
}

module.exports = { enqueue };
