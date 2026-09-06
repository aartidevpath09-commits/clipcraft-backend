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

  test("deleteAssetDirectory refuses unsafe assetIds instead of resolving to the storage root or escaping it", async () => {
    // "." is the dangerous one: resolveAbsolutePath(".") resolves to
    // STORAGE_ROOT itself (it doesn't "escape" the root, it *is* the root),
    // so without its own UUID check, deleteAssetDirectory(".") would
    // recursively remove the entire storage root.
    for (const unsafeId of [".", "..", "", "../outside", "abc/../../etc", "not-a-uuid"]) {
      await assert.rejects(
        () => storage.deleteAssetDirectory(unsafeId),
        /invalid assetId|escapes storage root|non-empty string/,
        `expected deleteAssetDirectory(${JSON.stringify(unsafeId)}) to reject`
      );
    }

    // A real, valid asset directory must still delete normally.
    const id = crypto.randomUUID();
    const key = storage.originalKey(id, ".mp4");
    await storage.saveStream(key, Readable.from([Buffer.from("hello")]));
    await storage.deleteAssetDirectory(id);
    assert.equal(await storage.exists(key), false);
  });

  test("deleteKey removes a single file without touching the rest of the asset directory", async () => {
    const id = crypto.randomUUID();
    const originalKey = storage.originalKey(id, ".mp4");
    const proxyKey = storage.derivedKey(id, "proxy");

    await storage.saveStream(originalKey, Readable.from([Buffer.from("original")]));
    await storage.saveStream(proxyKey, Readable.from([Buffer.from("proxy")]));

    await storage.deleteKey(proxyKey);

    assert.equal(await storage.exists(proxyKey), false);
    assert.equal(await storage.exists(originalKey), true);

    await storage.deleteAssetDirectory(id);
  });
});
