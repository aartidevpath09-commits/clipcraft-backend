/**
 * Central, environment-driven configuration for the Media Management module.
 *
 * Every tunable (storage location, per-category size limits, ffmpeg/ffprobe
 * binary paths) is read from process.env with a sane development default,
 * per the brief's requirement that these be environment-driven and that no
 * secrets/paths be hardcoded. This file only reads env vars already loaded
 * by app/server.js's top-level `require("dotenv").config()` -- it does not
 * call dotenv itself, so it has no side effects when required.
 */

const path = require("path");

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Root directory (on the local filesystem) under which all media -- both
// originals and derived assets (proxies/thumbnails/waveforms) -- are stored.
// Defaults to <repo-root>/storage, matching the storage/ entry already
// present in .gitignore.
const STORAGE_ROOT = path.resolve(
  process.env.MEDIA_STORAGE_ROOT || path.join(__dirname, "..", "..", "storage")
);

const MB = 1024 * 1024;

module.exports = {
  STORAGE_ROOT,

  // Per-category max upload size (bytes). MEDIA_MAX_FILE_SIZE is the
  // fallback used for any category without its own override.
  MAX_FILE_SIZE_BYTES: toInt(process.env.MEDIA_MAX_FILE_SIZE, 500 * MB),
  MAX_VIDEO_SIZE_BYTES: toInt(
    process.env.MEDIA_MAX_VIDEO_SIZE,
    toInt(process.env.MEDIA_MAX_FILE_SIZE, 500 * MB)
  ),
  MAX_AUDIO_SIZE_BYTES: toInt(
    process.env.MEDIA_MAX_AUDIO_SIZE,
    toInt(process.env.MEDIA_MAX_FILE_SIZE, 200 * MB)
  ),
  MAX_IMAGE_SIZE_BYTES: toInt(
    process.env.MEDIA_MAX_IMAGE_SIZE,
    toInt(process.env.MEDIA_MAX_FILE_SIZE, 25 * MB)
  ),

  FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg",
  FFPROBE_PATH: process.env.FFPROBE_PATH || "ffprobe",
};
