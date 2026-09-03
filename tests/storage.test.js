require("./helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const crypto = require("crypto");

const storage = require("../app/services/storage.service");

describe("storage.service", () => {
  test("generates predictable original/derived keys", () => {
    assert.equal(storage.originalKey("abc-123", ".mp4"), "abc-123/original.mp4");
    assert.equal(storage.derivedKey("abc-123", "proxy"), "abc-123/proxy.mp4");
    assert.equal(storage.derivedKey("abc-123", "thumbnail"), "abc-123/thumbnail.jpg");
    assert.equal(storage.derivedKey("abc-123", "waveform"), "abc-123/waveform.json");
  });

  test("rejects path-traversal storage keys", () => {
    assert.throws(() => storage.resolveAbsolutePath("../../etc/passwd"));
    assert.throws(() => storage.resolveAbsolutePath("../outside"));
  });

  test("saves a stream, exists()/stat() reflect it, and delete removes it", async () => {
    const id = crypto.randomUUID();
    const key = storage.originalKey(id, ".mp4");

    const { bytesWritten } = await storage.saveStream(key, Readable.from([Buffer.from("hello world")]));
    assert.equal(bytesWritten, 11);
    assert.equal(await storage.exists(key), true);

    const stat = await storage.stat(key);
    assert.equal(stat.size, 11);

    await storage.deleteAssetDirectory(id);
    assert.equal(await storage.exists(key), false);
  });

  test("saveStream enforces maxBytes and cleans up the partial file", async () => {
    const id = crypto.randomUUID();
    const key = storage.originalKey(id, ".mp4");

    await assert.rejects(
      () => storage.saveStream(key, Readable.from([Buffer.alloc(1000)]), 100),
      (err) => err.code === "MAX_BYTES_EXCEEDED"
    );
    assert.equal(await storage.exists(key), false);
  });
});
