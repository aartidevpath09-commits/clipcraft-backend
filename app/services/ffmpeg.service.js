/**
 * FFmpeg-based derived-asset generation: browser-friendly video proxies and
 * thumbnails. Waveform generation lives in waveform.service.js (it also
 * shells out to ffmpeg, but produces a JSON peaks file, not media).
 *
 * Every invocation uses child_process.execFile with an argument array (never
 * a shell), and failures are normalized into FfmpegError with a safe,
 * generic message -- raw stderr is never forwarded to API clients.
 *
 * Every function here takes absolute filesystem paths, not storage keys --
 * this is intentional, not local-filesystem coupling that needs fixing.
 * ffmpeg is a native process with no stream-based way to accept an
 * arbitrary input/output; it needs a real, seekable file on disk. Callers
 * get that path from storage.service.js's resolveAbsolutePath() (see its
 * doc comment), which is the one place a future S3-backed storage
 * implementation would stage an object to a local temp file -- these
 * functions' signatures are already the right shape for that swap and are
 * not expected to change when it happens.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { execFile } = require("child_process");
const { FFMPEG_PATH } = require("../config/media");

const PROXY_TIMEOUT_MS = 5 * 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

class FfmpegError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "FfmpegError";
    this.cause = cause;
  }
}

async function ensureParentDir(absolutePath) {
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
}

function runFfmpeg(args, timeoutMs, failureMessage) {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG_PATH,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES },
      (err) => {
        if (err) {
          if (err.killed || err.signal) {
            return reject(new FfmpegError(`${failureMessage} (timed out)`, err));
          }
          if (err.code === "ENOENT") {
            return reject(new FfmpegError("ffmpeg binary not found", err));
          }
          return reject(new FfmpegError(failureMessage, err));
        }
        resolve();
      }
    );
  });
}

/**
 * Transcode a video to a browser-friendly H.264/AAC MP4 proxy, capped at
 * 1280px on the long edge, suitable for scrubbing/preview in the editor.
 *
 * @param {string} absoluteInputPath
 * @param {string} absoluteOutputPath
 * @param {{ hasAudio: boolean }} options
 */
async function generateProxy(absoluteInputPath, absoluteOutputPath, { hasAudio }) {
  await ensureParentDir(absoluteOutputPath);

  const args = [
    "-y",
    "-i", absoluteInputPath,
    "-vf", "scale=w=min(1280\\,iw):h=-2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
  ];

  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }

  args.push("-movflags", "+faststart", absoluteOutputPath);

  try {
    await runFfmpeg(args, PROXY_TIMEOUT_MS, "Proxy generation failed");
  } catch (err) {
    await fsp.unlink(absoluteOutputPath).catch(() => {});
    throw err;
  }
}

/**
 * Extract a single frame (video) or re-encode (image) into a JPEG thumbnail,
 * capped at 320px on the long edge.
 *
 * @param {string} absoluteInputPath
 * @param {string} absoluteOutputPath
 * @param {{ mediaType: 'video' | 'image', seekSeconds?: number }} options
 */
async function generateThumbnail(absoluteInputPath, absoluteOutputPath, { mediaType, seekSeconds = 0 }) {
  await ensureParentDir(absoluteOutputPath);

  const args = ["-y"];
  if (mediaType === "video" && seekSeconds > 0) {
    args.push("-ss", String(seekSeconds));
  }
  args.push(
    "-i", absoluteInputPath,
    "-frames:v", "1",
    "-vf", "scale=w=min(320\\,iw):h=-2",
    absoluteOutputPath
  );

  try {
    await runFfmpeg(args, THUMBNAIL_TIMEOUT_MS, "Thumbnail generation failed");
  } catch (err) {
    await fsp.unlink(absoluteOutputPath).catch(() => {});
    throw err;
  }
}

module.exports = { generateProxy, generateThumbnail, FfmpegError };
