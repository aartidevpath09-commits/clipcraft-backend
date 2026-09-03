/**
 * Waveform peak generation for audio files and video files that have an
 * audio track. Decodes the audio to raw 16-bit mono PCM via ffmpeg (piped
 * to stdout, never written to a temp file), then downsamples it in Node
 * into a small JSON peaks file the frontend can render directly.
 *
 * Output format written to storage (see storage.derivedKey(assetId, 'waveform')):
 *   {
 *     "version": 1,
 *     "sampleRate": 8000,        // PCM sample rate used for analysis (not the source file's)
 *     "channels": 1,
 *     "durationSeconds": 12.34,
 *     "bucketCount": 246,
 *     "peaks": [min0, max0, min1, max1, ...]  // each in [-1, 1], length = bucketCount * 2
 *   }
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const { FFMPEG_PATH } = require("../config/media");

const DECODE_TIMEOUT_MS = 2 * 60 * 1000;
const PCM_SAMPLE_RATE = 8000; // low rate is plenty for a visual waveform and keeps memory bounded
const BUCKETS_PER_SECOND = 10;
const MIN_BUCKETS = 50;
const MAX_BUCKETS = 4000;
const MAX_PCM_BYTES = 250 * 1024 * 1024; // guard against pathological/huge inputs

class WaveformError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "WaveformError";
    this.cause = cause;
  }
}

async function ensureParentDir(absolutePath) {
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
}

function decodeToPcm(absoluteInputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i", absoluteInputPath,
      "-vn",
      "-ac", "1",
      "-ar", String(PCM_SAMPLE_RATE),
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "pipe:1",
    ];

    const child = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });

    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let stderrTail = "";

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, DECODE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PCM_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new WaveformError("Audio too long for waveform analysis"));
        }
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new WaveformError("ffmpeg binary not found", err));
      } else {
        reject(new WaveformError("Waveform decoding failed", err));
      }
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (signal) {
        return reject(new WaveformError("Waveform decoding timed out"));
      }
      if (code !== 0) {
        return reject(new WaveformError("Waveform decoding failed (file may have no audio track)", new Error(stderrTail)));
      }

      const pcmBuffer = Buffer.concat(chunks, totalBytes);
      if (pcmBuffer.length === 0) {
        return reject(new WaveformError("No audio data decoded"));
      }
      resolve(pcmBuffer);
    });
  });
}

/** Downsamples raw s16le mono PCM into [min, max] peak pairs per bucket. */
function computePeaks(pcmBuffer, durationSeconds) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  const bucketCount = Math.min(
    MAX_BUCKETS,
    Math.max(MIN_BUCKETS, Math.round(durationSeconds * BUCKETS_PER_SECOND))
  );
  const samplesPerBucket = Math.max(1, Math.floor(sampleCount / bucketCount));

  const peaks = new Array(bucketCount * 2);

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucket * samplesPerBucket;
    const end = bucket === bucketCount - 1 ? sampleCount : start + samplesPerBucket;

    let min = 0;
    let max = 0;
    for (let i = start; i < end && i < sampleCount; i++) {
      const sample = pcmBuffer.readInt16LE(i * 2) / 32768;
      if (sample < min) min = sample;
      if (sample > max) max = sample;
    }

    peaks[bucket * 2] = Math.round(min * 1000) / 1000;
    peaks[bucket * 2 + 1] = Math.round(max * 1000) / 1000;
  }

  return { bucketCount, peaks };
}

/**
 * @param {string} absoluteInputPath
 * @param {string} absoluteOutputPath - where the waveform JSON is written
 * @param {number} durationSeconds - from ffprobe metadata, used to size buckets
 */
async function generateWaveform(absoluteInputPath, absoluteOutputPath, durationSeconds) {
  const pcmBuffer = await decodeToPcm(absoluteInputPath);
  const safeDuration = durationSeconds > 0 ? durationSeconds : pcmBuffer.length / 2 / PCM_SAMPLE_RATE;
  const { bucketCount, peaks } = computePeaks(pcmBuffer, safeDuration);

  const output = {
    version: 1,
    sampleRate: PCM_SAMPLE_RATE,
    channels: 1,
    durationSeconds: safeDuration,
    bucketCount,
    peaks,
  };

  await ensureParentDir(absoluteOutputPath);
  try {
    await fsp.writeFile(absoluteOutputPath, JSON.stringify(output));
  } catch (err) {
    throw new WaveformError("Failed to write waveform file", err);
  }
}

module.exports = { generateWaveform, WaveformError };
