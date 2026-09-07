/**
 * ffprobe wrapper: extracts technical metadata from a media file on disk.
 *
 * Uses child_process.execFile (never a shell, so no shell-interpolation
 * risk from filenames) with a timeout and bounded output buffer, and turns
 * every failure mode (binary missing, non-zero exit, timeout, malformed
 * JSON, corrupt file) into a single FfprobeError with a safe, generic
 * message -- callers must never forward raw stderr to API clients.
 */

const { execFile } = require("child_process");
const { FFPROBE_PATH } = require("../config/media");

const FFPROBE_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

class FfprobeError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "FfprobeError";
    this.cause = cause;
  }
}

function runFfprobe(absoluteFilePath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE_PATH,
      [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        absoluteFilePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (err, stdout) => {
        if (err) {
          if (err.killed || err.signal) {
            return reject(new FfprobeError("ffprobe timed out", err));
          }
          if (err.code === "ENOENT") {
            return reject(new FfprobeError("ffprobe binary not found", err));
          }
          return reject(new FfprobeError("ffprobe exited with an error (file may be corrupt or unreadable)", err));
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(new FfprobeError("Failed to parse ffprobe output", parseErr));
        }
      }
    );
  });
}

/** Parses ffprobe's "num/den" rational frame-rate strings (e.g. "30000/1001"). */
function parseRationalFps(rateStr) {
  if (!rateStr || typeof rateStr !== "string") return null;
  const [numStr, denStr] = rateStr.split("/");
  const num = Number(numStr);
  const den = Number(denStr);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : null;
}

function toIntOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toFloatOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} absoluteFilePath - absolute path to a file already saved by storage.service
 * @returns {Promise<object>} normalized metadata; throws FfprobeError on failure
 */
async function probeMedia(absoluteFilePath) {
  const raw = await runFfprobe(absoluteFilePath);

  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");
  const format = raw.format || {};

  return {
    durationSeconds: toFloatOrNull(format.duration),
    containerFormat: format.format_name || null,
    bitrateBps: toIntOrNull(format.bit_rate),

    width: videoStream ? toIntOrNull(videoStream.width) : null,
    height: videoStream ? toIntOrNull(videoStream.height) : null,
    fps: videoStream ? parseRationalFps(videoStream.r_frame_rate) : null,
    videoCodec: videoStream ? videoStream.codec_name || null : null,

    audioCodec: audioStream ? audioStream.codec_name || null : null,
    sampleRateHz: audioStream ? toIntOrNull(audioStream.sample_rate) : null,
    channels: audioStream ? toIntOrNull(audioStream.channels) : null,
    hasAudio: Boolean(audioStream),
  };
}

module.exports = { probeMedia, FfprobeError, parseRationalFps };
