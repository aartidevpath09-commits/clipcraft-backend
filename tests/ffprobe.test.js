require("./helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ensureFixtures } = require("./helpers/fixtures");
const { probeMedia, FfprobeError } = require("../app/services/ffprobe.service");

describe("ffprobe.service", () => {
  const fixtures = ensureFixtures();

  test("extracts video + audio metadata from a real mp4", async () => {
    const meta = await probeMedia(fixtures["sample.mp4"]);
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 240);
    assert.equal(meta.videoCodec, "h264");
    assert.equal(meta.hasAudio, true);
    assert.ok(meta.durationSeconds > 0);
    assert.ok(meta.fps > 0);
  });

  test("audio-only file has no width/height/videoCodec", async () => {
    const meta = await probeMedia(fixtures["sample.mp3"]);
    assert.equal(meta.width, null);
    assert.equal(meta.videoCodec, null);
    assert.equal(meta.hasAudio, true);
    assert.ok(meta.sampleRateHz > 0);
  });

  test("silent video reports hasAudio: false", async () => {
    const meta = await probeMedia(fixtures.sample_silent_mp4 || fixtures["sample_silent.mp4"]);
    assert.equal(meta.hasAudio, false);
    assert.equal(meta.audioCodec, null);
  });

  test("throws FfprobeError for a corrupt file", async () => {
    await assert.rejects(() => probeMedia(fixtures.corrupt), FfprobeError);
  });

  test("throws FfprobeError for a missing file", async () => {
    await assert.rejects(() => probeMedia("/nonexistent/path/does-not-exist.mp4"), FfprobeError);
  });
});
