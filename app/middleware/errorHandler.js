/**
 * Central Express error-handling middleware.
 *
 * Every route in this module passes errors to `next(err)` rather than
 * building its own error response. This is the single place that decides
 * what a client is allowed to see: ApiError instances expose their safe
 * message, anything else (a raw Error, e.g. an unexpected bug) is logged
 * server-side in full but reported to the client as a generic message --
 * never a stack trace, never a filesystem path, never raw ffmpeg/ffprobe
 * stderr.
 */

const { ApiError } = require("../utils/apiError");

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }

  console.error("[unhandled error]", err && err.stack ? err.stack : err);

  return res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "Something went wrong processing your request",
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: "NOT_FOUND", message: "Route not found" });
}

module.exports = { errorHandler, notFoundHandler };
