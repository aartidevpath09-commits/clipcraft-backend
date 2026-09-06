require("./helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const { ensureFixtures } = require("./helpers/fixtures");
const { generateProxy, generateThumbnail, FfmpegError } = require("../app/services/ffmpeg.service");
const { probeMedia } = require("../app/services/ffprobe.service");

describe("ffmpeg.service", () => {
  const fixtures = ensureFixtures();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipcraft-ffmpeg-test-"));

  test("generates a browser-friendly h264 proxy from mp4", async () => {
    const out = path.join(outDir, "proxy1.mp4");
    await generateProxy(fixtures["sample.mp4"], out, { hasAudio: true });
    const meta = await probeMedia(out);
    assert.equal(meta.videoCodec, "h264");
    assert.ok(meta.width <= 1280);
    assert.equal(meta.hasAudio, true);
  });

  test("transcodes a non-mp4 container (webm) into an mp4 proxy", async () => {
    const out = path.join(outDir, "proxy2.mp4");
    await generateProxy(fixtures["sample.webm"], out, { hasAudio: true });
    const meta = await probeMedia(out);
    assert.equal(meta.videoCodec, "h264");
  });

  test("generates a thumbnail from a video", async () => {
    const out = path.join(outDir, "thumb1.jpg");
    await generateThumbnail(fixtures["sample.mp4"], out, { mediaType: "video", seekSeconds: 1 });
    assert.ok(fs.statSync(out).size > 0);
  });

  test("generates a thumbnail from an image", async () => {
    const out = path.join(outDir, "thumb2.jpg");
    await generateThumbnail(fixtures["sample.png"], out, { mediaType: "image" });
    assert.ok(fs.statSync(out).size > 0);
  });

  test("throws FfmpegError and removes partial output for a corrupt input", async () => {
    const out = path.join(outDir, "should-not-exist.mp4");
    await assert.rejects(() => generateProxy(fixtures.corrupt, out, { hasAudio: true }), FfmpegError);
    assert.equal(fs.existsSync(out), false);
  });
});
