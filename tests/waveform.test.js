require("./helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const { ensureFixtures } = require("./helpers/fixtures");
const { generateWaveform, WaveformError } = require("../app/services/waveform.service");
const { probeMedia } = require("../app/services/ffprobe.service");

describe("waveform.service", () => {
  const fixtures = ensureFixtures();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-waveform-test-"));

  test("generates peaks for an audio file", async () => {
    const meta = await probeMedia(fixtures["sample.mp3"]);
    const out = path.join(outDir, "mp3.json");
    await generateWaveform(fixtures["sample.mp3"], out, meta.durationSeconds);

    const wf = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(wf.peaks.length, wf.bucketCount * 2);
    assert.ok(wf.peaks.every((p) => p >= -1 && p <= 1));
    assert.ok(wf.peaks.some((p) => p !== 0));
  });

  test("generates peaks for a video-with-audio file", async () => {
    const meta = await probeMedia(fixtures["sample.mp4"]);
    const out = path.join(outDir, "mp4.json");
    await generateWaveform(fixtures["sample.mp4"], out, meta.durationSeconds);

    const wf = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.ok(wf.peaks.some((p) => p !== 0));
  });

  test("rejects a video with no audio track", async () => {
    const out = path.join(outDir, "silent.json");
    await assert.rejects(
      () => generateWaveform(fixtures["sample_silent.mp4"], out, 2),
      WaveformError
    );
  });

  test("rejects a corrupt file", async () => {
    const out = path.join(outDir, "corrupt.json");
    await assert.rejects(() => generateWaveform(fixtures.corrupt, out, 2), WaveformError);
  });
});
