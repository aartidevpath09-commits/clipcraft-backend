require("./helpers/testEnv");
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { runMigrations } = require("../app/db/migrate");
const pool = require("../app/config/db");
const mediaAssets = require("../app/db/mediaAssets.repository");
const storage = require("../app/services/storage.service");
const resolver = require("../app/services/mediaResolver.service");
const { RESOLUTION_STATUS } = resolver;

/**
 * Sprint 3: direct, HTTP-free tests of the final Member 3A contract --
 * resolveProjectAsset(projectId, assetId, { userId, purpose }) and
 * getProjectAssetsMap(projectId, userId, { purpose }) -- against the real
 * database and the real filesystem (no mocks of the resolver itself).
 *
 * Asset rows here are seeded directly via the mediaAssets repository, and
 * "physical files" are small real files written straight to the resolved
 * storage path (via storage.service, the same module the resolver reads
 * through) rather than run through the full ffprobe/ffmpeg pipeline -- that
 * full real pipeline is exercised end to end in tests/projectMedia.test.js.
 * This keeps these tests fast and deterministic for the specific thing they
 * verify: the resolver's own contract, status branches, purpose selection,
 * and physical-file verification -- not media processing itself.
 */

describe("mediaResolver.service (Sprint 3 contract)", () => {
  // Tracked and deleted by exact id in after() -- see the matching comment
  // in tests/api.test.js for why this is scoped per-id rather than a
  // TRUNCATE (node --test runs this file concurrently with the other test
  // files against the same shared development database).
  const createdUserIds = [];

  before(async () => {
    await runMigrations();
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await pool.query("DELETE FROM dev_users WHERE id = ANY($1::uuid[])", [createdUserIds]);
    }
    await pool.end();
  });

  async function createUser() {
    const id = crypto.randomUUID();
    await pool.query("INSERT INTO dev_users (id, display_name) VALUES ($1, $2)", [id, "Resolver Test User"]);
    createdUserIds.push(id);
    return id;
  }

  async function createProject(ownerId) {
    const id = crypto.randomUUID();
    await pool.query("INSERT INTO dev_projects (id, owner_id, name) VALUES ($1, $2, $3)", [
      id,
      ownerId,
      "Resolver Test Project",
    ]);
    return id;
  }

  function writeFakeFile(storageKey, content = "fake-media-bytes") {
    const absPath = storage.resolveAbsolutePath(storageKey);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
    return absPath;
  }

  /** Inserts a media_assets row and (unless overrides.skipOriginalFile) writes a real file for it. */
  async function insertAsset(projectId, overrides = {}) {
    const id = crypto.randomUUID();
    const storageKey = `${id}/original.mp4`;
    await mediaAssets.insert({
      id,
      projectId,
      uploadedBy: overrides.uploadedBy || null,
      originalFilename: "clip.mp4",
      mediaType: "video",
      mimeType: "video/mp4",
      extension: ".mp4",
      fileSizeBytes: 1234,
      storageKey,
    });
    if (overrides.status) {
      await mediaAssets.setOverallStatus(id, overrides.status, overrides.errorMessage || null);
    }
    if (overrides.metadata) {
      await mediaAssets.setMetadata(id, overrides.metadata);
    }
    if (overrides.status === "READY" && !overrides.skipOriginalFile) {
      writeFakeFile(storageKey);
    }
    if (overrides.withProxy) {
      const proxyKey = `${id}/proxy.mp4`;
      await mediaAssets.setDerivedStatus(id, "proxy", "READY", null, proxyKey);
      if (!overrides.skipProxyFile) writeFakeFile(proxyKey, "fake-proxy-bytes");
    }
    return id;
  }

  // --- resolveProjectAsset -------------------------------------------------

  test("resolveProjectAsset: FORBIDDEN when userId is omitted (fails closed, never throws)", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, { status: "READY" });

    const result = await resolver.resolveProjectAsset(projectId, assetId, {});
    assert.equal(result.status, RESOLUTION_STATUS.FORBIDDEN);
  });

  test("resolveProjectAsset: FORBIDDEN for a project owned by someone else", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, { status: "READY" });

    const result = await resolver.resolveProjectAsset(projectId, assetId, { userId: intruder });
    assert.equal(result.status, RESOLUTION_STATUS.FORBIDDEN);
  });

  test("resolveProjectAsset: FORBIDDEN for a nonexistent or malformed project id (never leaks asset existence)", async () => {
    const user = await createUser();

    const r1 = await resolver.resolveProjectAsset("00000000-0000-0000-0000-000000000000", crypto.randomUUID(), {
      userId: user,
    });
    assert.equal(r1.status, RESOLUTION_STATUS.FORBIDDEN);

    const r2 = await resolver.resolveProjectAsset("not-a-uuid; DROP TABLE media_assets;--", crypto.randomUUID(), {
      userId: user,
    });
    assert.equal(r2.status, RESOLUTION_STATUS.FORBIDDEN);
  });

  test("resolveProjectAsset: NOT_FOUND for a missing or malformed assetId within an owned project", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);

    const r1 = await resolver.resolveProjectAsset(projectId, crypto.randomUUID(), { userId: owner });
    assert.equal(r1.status, RESOLUTION_STATUS.NOT_FOUND);

    const r2 = await resolver.resolveProjectAsset(projectId, "../../etc/passwd", { userId: owner });
    assert.equal(r2.status, RESOLUTION_STATUS.NOT_FOUND);
  });

  test("resolveProjectAsset: WRONG_PROJECT when the asset belongs to a different (also-owned) project", async () => {
    const owner = await createUser();
    const projectA = await createProject(owner);
    const projectB = await createProject(owner);
    const assetInB = await insertAsset(projectB, { status: "READY" });

    const result = await resolver.resolveProjectAsset(projectA, assetInB, { userId: owner });
    assert.equal(result.status, RESOLUTION_STATUS.WRONG_PROJECT);
  });

  test("resolveProjectAsset: NOT_READY while UPLOADING, PROCESSING, or FAILED", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);

    const uploading = await insertAsset(projectId); // default status from insert() is UPLOADING
    const r1 = await resolver.resolveProjectAsset(projectId, uploading, { userId: owner });
    assert.equal(r1.status, RESOLUTION_STATUS.NOT_READY);
    assert.equal(r1.assetStatus, "UPLOADING");

    const processing = await insertAsset(projectId, { status: "PROCESSING" });
    const r2 = await resolver.resolveProjectAsset(projectId, processing, { userId: owner });
    assert.equal(r2.status, RESOLUTION_STATUS.NOT_READY);
    assert.equal(r2.assetStatus, "PROCESSING");

    const failed = await insertAsset(projectId, { status: "FAILED", errorMessage: "ffprobe failed" });
    const r3 = await resolver.resolveProjectAsset(projectId, failed, { userId: owner });
    assert.equal(r3.status, RESOLUTION_STATUS.NOT_READY);
    assert.equal(r3.assetStatus, "FAILED");
    assert.equal(r3.errorMessage, "ffprobe failed");
  });

  test("resolveProjectAsset: SOURCE_MISSING when the DB says READY but the original file isn't on disk", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, { status: "READY", skipOriginalFile: true });

    const result = await resolver.resolveProjectAsset(projectId, assetId, { userId: owner });
    assert.equal(result.status, RESOLUTION_STATUS.SOURCE_MISSING);
    assert.match(result.message, /original/i);
  });

  test("resolveProjectAsset: SOURCE_MISSING for preview purpose when proxy is READY in the DB but its file is gone (no silent fallback to original)", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, { status: "READY", withProxy: true, skipProxyFile: true });

    const result = await resolver.resolveProjectAsset(projectId, assetId, { userId: owner, purpose: "preview" });
    assert.equal(result.status, RESOLUTION_STATUS.SOURCE_MISSING);
    assert.match(result.message, /proxy/i);
  });

  test("resolveProjectAsset: READY returns full metadata, a resolvable sourcePath, and never a raw storage_key", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, {
      status: "READY",
      metadata: {
        durationSeconds: 2.0,
        width: 320,
        height: 240,
        fps: 25,
        videoCodec: "h264",
        audioCodec: "aac",
        containerFormat: "mp4",
        bitrateBps: 500000,
        sampleRateHz: 44100,
        channels: 2,
        hasAudio: true,
      },
    });

    const result = await resolver.resolveProjectAsset(projectId, assetId, { userId: owner });
    assert.equal(result.status, RESOLUTION_STATUS.READY);
    assert.equal(result.asset.id, assetId);
    assert.equal(result.asset.projectId, projectId);
    assert.equal(result.asset.mediaType, "video");
    assert.equal(result.asset.width, 320);
    assert.equal(result.asset.videoCodec, "h264");
    assert.equal(result.asset.hasAudio, true);
    assert.equal(fs.existsSync(result.asset.sourcePath), true);
    assert.ok(!("storage_key" in result.asset));
    assert.ok(!("storageKey" in result.asset));
    // No proxy was set up for this asset, so preview purpose (the default)
    // must fall back to the original.
    assert.equal(result.asset.purpose, "preview");
    assert.equal(result.asset.sourceKind, "original");
    assert.equal(result.asset.sourcePath, result.asset.originalPath);
    assert.equal(result.asset.proxyPath, null);
  });

  test("resolveProjectAsset: purpose='render' always selects the original, even when a proxy is READY", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, { status: "READY", withProxy: true });

    const result = await resolver.resolveProjectAsset(projectId, assetId, { userId: owner, purpose: "render" });
    assert.equal(result.status, RESOLUTION_STATUS.READY);
    assert.equal(result.asset.purpose, "render");
    assert.equal(result.asset.sourceKind, "original");
    assert.equal(result.asset.sourcePath, result.asset.originalPath);
    assert.notEqual(result.asset.proxyPath, null);
    assert.notEqual(result.asset.sourcePath, result.asset.proxyPath);
  });

  test("resolveProjectAsset: purpose='preview' (and the default) selects the proxy when it is READY", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, { status: "READY", withProxy: true });

    const explicitPreview = await resolver.resolveProjectAsset(projectId, assetId, {
      userId: owner,
      purpose: "preview",
    });
    assert.equal(explicitPreview.asset.sourceKind, "proxy");
    assert.equal(explicitPreview.asset.sourcePath, explicitPreview.asset.proxyPath);

    const defaulted = await resolver.resolveProjectAsset(projectId, assetId, { userId: owner });
    assert.equal(defaulted.asset.purpose, "preview");
    assert.equal(defaulted.asset.sourceKind, "proxy");
  });

  // --- getProjectAssetsMap --------------------------------------------------

  test("getProjectAssetsMap: FORBIDDEN for a project the caller doesn't own, or with no userId", async () => {
    const owner = await createUser();
    const intruder = await createUser();
    const projectId = await createProject(owner);

    assert.equal((await resolver.getProjectAssetsMap(projectId, intruder)).status, "FORBIDDEN");
    assert.equal((await resolver.getProjectAssetsMap(projectId, undefined)).status, "FORBIDDEN");
  });

  test("getProjectAssetsMap: OK with an empty Map for a project with no media", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);

    const result = await resolver.getProjectAssetsMap(projectId, owner);
    assert.equal(result.status, "OK");
    assert.equal(result.assets.size, 0);
  });

  test("getProjectAssetsMap: OK, correctly classifying READY/NOT_READY/SOURCE_MISSING assets in one pass", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);

    const readyId = await insertAsset(projectId, {
      status: "READY",
      metadata: { durationSeconds: 1, width: 100, height: 100, fps: 24, hasAudio: false },
    });
    const processingId = await insertAsset(projectId, { status: "PROCESSING" });
    const missingFileId = await insertAsset(projectId, { status: "READY", skipOriginalFile: true });

    const result = await resolver.getProjectAssetsMap(projectId, owner);
    assert.equal(result.status, "OK");
    assert.equal(result.assets.size, 3);

    assert.equal(result.assets.get(readyId).status, RESOLUTION_STATUS.READY);
    assert.equal(result.assets.get(readyId).asset.width, 100);

    assert.equal(result.assets.get(processingId).status, RESOLUTION_STATUS.NOT_READY);
    assert.equal(result.assets.get(processingId).assetStatus, "PROCESSING");

    assert.equal(result.assets.get(missingFileId).status, RESOLUTION_STATUS.SOURCE_MISSING);
  });

  test("getProjectAssetsMap: never includes an asset belonging to a different project", async () => {
    const owner = await createUser();
    const projectA = await createProject(owner);
    const projectB = await createProject(owner);
    await insertAsset(projectB, { status: "READY" });

    const result = await resolver.getProjectAssetsMap(projectA, owner);
    assert.equal(result.status, "OK");
    assert.equal(result.assets.size, 0);
  });

  test("getProjectAssetsMap: honors purpose for every asset in the map, matching resolveProjectAsset", async () => {
    const owner = await createUser();
    const projectId = await createProject(owner);
    const assetId = await insertAsset(projectId, { status: "READY", withProxy: true });

    const renderMap = await resolver.getProjectAssetsMap(projectId, owner, { purpose: "render" });
    assert.equal(renderMap.assets.get(assetId).asset.sourceKind, "original");

    const previewMap = await resolver.getProjectAssetsMap(projectId, owner, { purpose: "preview" });
    assert.equal(previewMap.assets.get(assetId).asset.sourceKind, "proxy");
  });

  // --- Isolation matrix (brief section 18, "Isolation tests") --------------

  describe("Sprint 3 isolation matrix", () => {
    test("User A -> Project A -> Asset A = success; User A -> Project B -> Asset B = denied; User B -> Project A -> Asset A = denied", async () => {
      const userA = await createUser();
      const userB = await createUser();
      const projectA = await createProject(userA);
      const projectB = await createProject(userB);
      const assetA = await insertAsset(projectA, { status: "READY" });
      const assetB = await insertAsset(projectB, { status: "READY" });

      const aToA = await resolver.resolveProjectAsset(projectA, assetA, { userId: userA });
      assert.equal(aToA.status, RESOLUTION_STATUS.READY);

      const aToB = await resolver.resolveProjectAsset(projectB, assetB, { userId: userA });
      assert.equal(aToB.status, RESOLUTION_STATUS.FORBIDDEN);

      const bToA = await resolver.resolveProjectAsset(projectA, assetA, { userId: userB });
      assert.equal(bToA.status, RESOLUTION_STATUS.FORBIDDEN);

      // Same matrix through getProjectAssetsMap.
      const mapForA = await resolver.getProjectAssetsMap(projectA, userA);
      assert.equal(mapForA.status, "OK");
      assert.ok(mapForA.assets.has(assetA));

      const mapForBAsA = await resolver.getProjectAssetsMap(projectB, userA);
      assert.equal(mapForBAsA.status, "FORBIDDEN");

      const mapForAAsB = await resolver.getProjectAssetsMap(projectA, userB);
      assert.equal(mapForAAsB.status, "FORBIDDEN");
    });
  });
});
