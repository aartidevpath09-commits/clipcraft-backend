/**
 * In-process, fire-and-forget job seam with a bounded concurrency limit.
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
 *
 * Concurrency cap (code review: "waveform generation ... high-memory/OOM
 * risk"): waveform generation itself no longer buffers a large amount of
 * memory per job (see waveform.service.js), but nothing here previously
 * limited how many jobs -- each spawning its own ffprobe/ffmpeg child
 * processes -- could run at once. A burst of uploads could still spawn an
 * unbounded number of concurrent ffmpeg processes. MAX_CONCURRENT_JOBS
 * bounds that; jobs beyond the limit simply wait in `pending` until a slot
 * frees up, rather than all starting at once.
 */

const MAX_CONCURRENT_JOBS = Number(process.env.MEDIA_PROCESSING_CONCURRENCY) || 4;

let activeCount = 0;
const pending = [];

function runNext() {
  if (activeCount >= MAX_CONCURRENT_JOBS) return;
  const jobFn = pending.shift();
  if (!jobFn) return;

  activeCount++;
  Promise.resolve()
    .then(jobFn)
    .catch((err) => {
      // This is the last line of defense: every job function is expected
      // to catch and record its own failures (see processing.service.js).
      // Logging here only catches a truly unexpected bug in a job itself.
      console.error("[processingQueue] Unhandled error in background job:", err.message);
    })
    .finally(() => {
      activeCount--;
      runNext();
    });
}

function enqueue(jobFn) {
  pending.push(jobFn);
  setImmediate(runNext);
}

module.exports = { enqueue };
