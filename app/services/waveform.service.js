/**
 * Waveform peak generation for audio files and video files that have an
 * audio track. Decodes the audio to raw 16-bit mono PCM via ffmpeg (piped
 * to stdout, never written to a temp file), and computes [min, max] peaks
 * per bucket *as the PCM streams in* -- the decoded audio is never held in
 * memory as a whole (see "Streaming design" below).
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
 *
 * Streaming design (code review 4.x: "high-memory/OOM risk"):
 * A previous version accumulated every decoded PCM chunk into an array and
 * only computed peaks after `Buffer.concat`-ing the whole thing -- capped
 * at MAX_PCM_BYTES per job, but with no limit on how many such jobs run
 * concurrently (see processingQueue.service.js), that per-job cap didn't
 * bound total memory under load, and a single long file was already a
 * multi-hundred-MB spike for what should be a small output file.
 *
 * This version never buffers the decoded PCM. It fixes two typed-array-
 * like fixed-size buffers (`mins`/`maxs`, one slot per bucket, capacity
 * MAX_BUCKETS) up front and folds each incoming PCM chunk's samples into
 * them immediately, discarding the chunk afterward. Bucket boundaries are
 * sized from the file's known duration (from ffprobe) so the common case
 * needs no adjustment mid-stream; if the real sample count ever runs past
 * the current bucket capacity (unknown/wrong duration, or a file longer
 * than expected), adjacent bucket pairs are merged in place -- halving
 * resolution and doubling `samplesPerBucket` -- which keeps memory fixed
 * at O(MAX_BUCKETS) regardless of how long the input actually is.
 *
 * absoluteInputPath/absoluteOutputPath (below) are intentional too, for the
 * same reason as ffmpeg.service.js: decoding audio here means spawning
 * ffmpeg as a native child process, which needs a real, seekable file on
 * disk for input -- there's no stream-based way to hand it an arbitrary
 * source. Callers get that path from storage.service.js's
 * resolveAbsolutePath() (see its doc comment), the one place a future
 * S3-backed storage implementation would stage an object to a local temp
 * file -- this function's signature is already the right shape for that
 * swap and is not expected to change when it happens.
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
const MAX_PCM_BYTES = 250 * 1024 * 1024; // sanity ceiling on total decoded bytes, not a memory buffer size

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

/**
 * Fixed-capacity (MAX_BUCKETS slots) running [min, max] accumulator. Never
 * grows -- when a sample's bucket index would exceed capacity, adjacent
 * buckets already collected are merged pairwise (halving how many are in
 * use, doubling the sample span each one covers) until it fits.
 */
function createPeakAccumulator({ initialSamplesPerBucket }) {
  const mins = new Array(MAX_BUCKETS).fill(0);
  const maxs = new Array(MAX_BUCKETS).fill(0);
  let samplesPerBucket = Math.max(1, initialSamplesPerBucket);
  let usedBuckets = 0;
  let sampleIndex = 0;

  function mergeBucketsInPlace() {
    const half = Math.ceil(MAX_BUCKETS / 2);
    for (let i = 0; i < half; i++) {
      const a = i * 2;
      const b = a + 1;
      mins[i] = b < MAX_BUCKETS ? Math.min(mins[a], mins[b]) : mins[a];
      maxs[i] = b < MAX_BUCKETS ? Math.max(maxs[a], maxs[b]) : maxs[a];
    }
    for (let i = half; i < MAX_BUCKETS; i++) {
      mins[i] = 0;
      maxs[i] = 0;
    }
    samplesPerBucket *= 2;
    usedBuckets = Math.ceil(usedBuckets / 2);
  }

  return {
    addSample(sample) {
      let bucketIdx = Math.floor(sampleIndex / samplesPerBucket);
      while (bucketIdx >= MAX_BUCKETS) {
        mergeBucketsInPlace();
        bucketIdx = Math.floor(sampleIndex / samplesPerBucket);
      }
      if (sample < mins[bucketIdx]) mins[bucketIdx] = sample;
      if (sample > maxs[bucketIdx]) maxs[bucketIdx] = sample;
      if (bucketIdx + 1 > usedBuckets) usedBuckets = bucketIdx + 1;
      sampleIndex++;
    },
    /** Folds a chunk of s16le samples, given as a Buffer with an even byte length, into the accumulator. */
    addSamplesFromBuffer(buf) {
      for (let off = 0; off < buf.length; off += 2) {
        this.addSample(buf.readInt16LE(off) / 32768);
      }
    },
    get sampleCount() {
      return sampleIndex;
    },
    finalize() {
      const peaks = new Array(usedBuckets * 2);
      for (let i = 0; i < usedBuckets; i++) {
        peaks[i * 2] = Math.round(mins[i] * 1000) / 1000;
        peaks[i * 2 + 1] = Math.round(maxs[i] * 1000) / 1000;
      }
      return { bucketCount: usedBuckets, peaks };
    },
  };
}

/**
 * Decodes `absoluteInputPath` to mono 16-bit PCM via ffmpeg and computes
 * peak buckets as the decode streams in, never buffering the whole file.
 *
 * @param {string} absoluteInputPath
 * @param {number} durationSeconds - from ffprobe metadata; used only to
 *   size the initial bucket resolution (0/unknown is handled safely -- see
 *   the module doc comment -- it just starts at the finest resolution and
 *   lets the accumulator merge down as needed).
 */
function decodeAndComputePeaks(absoluteInputPath, durationSeconds) {
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

    const safeDuration = durationSeconds > 0 ? durationSeconds : 0;
    const targetBucketCount = Math.min(
      MAX_BUCKETS,
      Math.max(MIN_BUCKETS, Math.round(safeDuration * BUCKETS_PER_SECOND))
    );
    const estimatedSamples = Math.max(1, Math.round(safeDuration * PCM_SAMPLE_RATE));
    const initialSamplesPerBucket = safeDuration > 0
      ? Math.max(1, Math.round(estimatedSamples / targetBucketCount))
      : 1; // unknown duration: start at the finest resolution, merge down as real data arrives

    const accumulator = createPeakAccumulator({ initialSamplesPerBucket });

    let leftoverByte = null; // a lone byte held over when a chunk boundary splits a 16-bit sample
    let totalBytes = 0;
    let settled = false;
    let stderrTail = "";

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, DECODE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (settled) return;

      totalBytes += chunk.length;
      if (totalBytes > MAX_PCM_BYTES) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new WaveformError("Audio too long for waveform analysis"));
        return;
      }

      let buf = chunk;
      if (leftoverByte !== null) {
        buf = Buffer.concat([leftoverByte, chunk]);
        leftoverByte = null;
      }
      const usableLength = buf.length - (buf.length % 2);
      if (usableLength < buf.length) {
        leftoverByte = buf.subarray(usableLength);
      }
      if (usableLength > 0) {
        accumulator.addSamplesFromBuffer(buf.subarray(0, usableLength));
      }
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
      if (accumulator.sampleCount === 0) {
        return reject(new WaveformError("No audio data decoded"));
      }

      const { bucketCount, peaks } = accumulator.finalize();
      const actualDurationSeconds = accumulator.sampleCount / PCM_SAMPLE_RATE;
      resolve({
        bucketCount,
        peaks,
        durationSeconds: durationSeconds > 0 ? durationSeconds : actualDurationSeconds,
      });
    });
  });
}

/**
 * @param {string} absoluteInputPath
 * @param {string} absoluteOutputPath - where the waveform JSON is written
 * @param {number} durationSeconds - from ffprobe metadata, used to size buckets
 */
async function generateWaveform(absoluteInputPath, absoluteOutputPath, durationSeconds) {
  const { bucketCount, peaks, durationSeconds: outputDuration } =
    await decodeAndComputePeaks(absoluteInputPath, durationSeconds);

  const output = {
    version: 1,
    sampleRate: PCM_SAMPLE_RATE,
    channels: 1,
    durationSeconds: outputDuration,
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
