/**
 * Generates small, real media files for the test suite using the ffmpeg
 * binary the project already depends on (see README's Backend Stack) --
 * no binary media files are committed to the repo. Fixtures are written
 * once into a temp directory and reused across the whole test run.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { FFMPEG_PATH } = require("../../app/config/media");

const FIXTURES_DIR = path.join(os.tmpdir(), "clipcraft-media-test-fixtures");

const SPECS = [
  { name: "sample.mp4", args: (out) => videoArgs("libx264", "aac", out) },
  { name: "sample.mov", args: (out) => videoArgs("libx264", "aac", out) },
  { name: "sample.webm", args: (out) => videoArgs("libvpx", "libopus", out) },
  { name: "sample.mkv", args: (out) => videoArgs("libx264", "aac", out) },
  { name: "sample_silent.mp4", args: (out) => silentVideoArgs(out) },
  { name: "sample.jpg", args: (out) => imageArgs(out) },
  { name: "sample.png", args: (out) => imageArgs(out) },
  { name: "sample.webp", args: (out) => imageArgs(out) },
  { name: "sample.mp3", args: (out) => audioArgs("libmp3lame", out) },
  { name: "sample.wav", args: (out) => audioArgs(null, out) },
  { name: "sample.m4a", args: (out) => audioArgs("aac", out) },
  { name: "sample.ogg", args: (out) => audioArgs("libvorbis", out) },
];

function videoArgs(vCodec, aCodec, out) {
  return [
    "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", vCodec, "-c:a", aCodec, "-shortest", out,
  ];
}

function silentVideoArgs(out) {
  return ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:duration=2", "-an", out];
}

function imageArgs(out) {
  return ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:duration=1", "-frames:v", "1", out];
}

function audioArgs(codec, out) {
  const args = ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"];
  if (codec) args.push("-c:a", codec);
  args.push(out);
  return args;
}

let cached = null;

/** Idempotently generates (or reuses) fixture files. Returns { name: absolutePath }. */
function ensureFixtures() {
  if (cached) return cached;

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const paths = {};

  for (const spec of SPECS) {
    const outPath = path.join(FIXTURES_DIR, spec.name);
    if (!fs.existsSync(outPath)) {
      execFileSync(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", ...spec.args(outPath)]);
    }
    paths[spec.name] = outPath;
  }

  paths.corrupt = path.join(FIXTURES_DIR, "corrupt.mp4");
  fs.writeFileSync(paths.corrupt, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));

  cached = paths;
  return paths;
}

module.exports = { ensureFixtures, FIXTURES_DIR };
