require("./helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { ensureFixtures } = require("./helpers/fixtures");
const {
  validateUpload,
  MAGIC_BYTES_SNIFF_LENGTH,
  maxSizeForCategory,
} = require("../app/services/validation.service");

function headerBytesOf(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(MAGIC_BYTES_SNIFF_LENGTH);
  fs.readSync(fd, buf, 0, MAGIC_BYTES_SNIFF_LENGTH, 0);
  fs.closeSync(fd);
  return buf;
}

describe("validation.service", () => {
  const fixtures = ensureFixtures();

  const cases = [
    ["sample.mp4", "video/mp4", "video"],
    ["sample.mov", "video/quicktime", "video"],
    ["sample.webm", "video/webm", "video"],
    ["sample.mkv", "video/x-matroska", "video"],
    ["sample.jpg", "image/jpeg", "image"],
    ["sample.png", "image/png", "image"],
    ["sample.webp", "image/webp", "image"],
    ["sample.mp3", "audio/mpeg", "audio"],
    ["sample.wav", "audio/wav", "audio"],
    ["sample.m4a", "audio/mp4", "audio"],
    ["sample.ogg", "audio/ogg", "audio"],
  ];

  for (const [file, mime, expectedCategory] of cases) {
    test(`accepts a real ${file}`, () => {
      const result = validateUpload({
        originalFilename: file,
        declaredMimeType: mime,
        headerBytes: headerBytesOf(fixtures[file]),
        sizeBytes: fs.statSync(fixtures[file]).size,
      });
      assert.equal(result.ok, true);
      assert.equal(result.mediaType, expectedCategory);
    });
  }

  test("rejects spoofed magic bytes (png renamed to .mp4)", () => {
    const result = validateUpload({
      originalFilename: "evil.mp4",
      declaredMimeType: "video/mp4",
      headerBytes: headerBytesOf(fixtures["sample.png"]),
      sizeBytes: 1000,
    });
    assert.equal(result.ok, false);
  });

  test("rejects extension/MIME mismatch", () => {
    const result = validateUpload({
      originalFilename: "sample.mp4",
      declaredMimeType: "image/png",
      headerBytes: Buffer.alloc(64),
      sizeBytes: 10,
    });
    assert.equal(result.ok, false);
  });

  test("rejects files with no extension", () => {
    const result = validateUpload({
      originalFilename: "noextension",
      declaredMimeType: "video/mp4",
      headerBytes: Buffer.alloc(64),
      sizeBytes: 10,
    });
    assert.equal(result.ok, false);
  });

  test("rejects a file larger than its category's configured max size", () => {
    const result = validateUpload({
      originalFilename: "sample.jpg",
      declaredMimeType: "image/jpeg",
      headerBytes: headerBytesOf(fixtures["sample.jpg"]),
      sizeBytes: maxSizeForCategory("image") + 1,
    });
    assert.equal(result.ok, false);
  });

  test("accepts a file exactly at its category's configured max size", () => {
    const result = validateUpload({
      originalFilename: "sample.jpg",
      declaredMimeType: "image/jpeg",
      headerBytes: headerBytesOf(fixtures["sample.jpg"]),
      sizeBytes: maxSizeForCategory("image"),
    });
    assert.equal(result.ok, true);
  });

  test("rejects unsupported extensions", () => {
    const result = validateUpload({
      originalFilename: "malware.exe",
      declaredMimeType: "application/octet-stream",
      headerBytes: Buffer.alloc(64),
      sizeBytes: 10,
    });
    assert.equal(result.ok, false);
  });
});
