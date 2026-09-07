require("./helpers/testEnv");
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");

const { ensureFixtures } = require("./helpers/fixtures");
const { runMigrations } = require("../app/db/migrate");
const pool = require("../app/config/db");
const storage = require("../app/services/storage.service");
const app = require("../app/server");

/**
 * Sprint 2: project/user ownership boundaries around media, the project
 * media-bin listing endpoint, and the project-deletion cleanup integration
 * point for Member 1.
 */

// Tracked and deleted by exact id in after() -- see the matching comment in
// tests/api.test.js for why this is scoped per-id rather than a TRUNCATE.
const createdUserIds = [];

let server;
let baseUrl;
const fixtures = ensureFixtures();

async function jsonRequest(method, urlPath, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, headers: res.headers, json, text };
}

async function uploadFile({ token, projectId, filePath, mimeType }) {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mimeType });
  form.append("projectId", projectId);
  form.append("file", blob, path.basename(filePath));
  const res = await fetch(`${baseUrl}/api/v1/media/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function createUserAndProject(displayName) {
  const login = await jsonRequest("POST", "/api/v1/dev/login", { body: { displayName } });
  const token = login.json.token;
  const userId = login.json.userId;
  createdUserIds.push(userId);
  const project = await jsonRequest("POST", "/api/v1/dev/projects", {
    token,
    body: { name: `${displayName}'s project` },
  });
  return { token, userId, projectId: project.json.id };
}

async function waitUntilProcessed(token, assetId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { json } = await jsonRequest("GET", `/api/v1/media/${assetId}`, { token });
    if (!json?.asset) {
      throw new Error(`Invalid media status response: ${JSON.stringify(json)}`);
    }
    const a = json.asset;
    if (a.status === "READY" || a.status === "FAILED") {
      const derivedSettled = [a.proxy.status, a.thumbnail.status, a.waveform.status].every(
        (s) => s === "READY" || s === "FAILED" || s === "NOT_APPLICABLE"
      );
      if (derivedSettled) return a;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out waiting for media processing");
}

describe("Project-scoped media API (Sprint 2 integration)", () => {
  before(async () => {
    await runMigrations();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (createdUserIds.length > 0) {
      await pool.query("DELETE FROM dev_users WHERE id = ANY($1::uuid[])", [createdUserIds]);
    }
    await pool.end();
  });

  test("GET /api/v1/projects/:projectId/media requires authentication", async () => {
    const res = await jsonRequest("GET", "/api/v1/projects/00000000-0000-0000-0000-000000000000/media");
    assert.equal(res.status, 401);
  });

  test("GET /api/v1/projects/:projectId/media returns an empty array for a fresh project", async () => {
    const { token, projectId } = await createUserAndProject("Grace");
    const res = await jsonRequest("GET", `/api/v1/projects/${projectId}/media`, { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.assets, []);
  });

  test("GET /api/v1/projects/:projectId/media returns 404 for a nonexistent project", async () => {
    const { token } = await createUserAndProject("Heidi");
    const res = await jsonRequest("GET", "/api/v1/projects/00000000-0000-0000-0000-000000000000/media", { token });
    assert.equal(res.status, 404);
  });

  test("GET /api/v1/projects/:projectId/media returns 403 for a project owned by someone else", async () => {
    const owner = await createUserAndProject("Ivan");
    const intruder = await createUserAndProject("Judy");
    const res = await jsonRequest("GET", `/api/v1/projects/${owner.projectId}/media`, { token: intruder.token });
    assert.equal(res.status, 403);
  });

  test("GET /api/v1/projects/:projectId/media returns non-leaky metadata for the project's media bin, newest first, and matches the query-param form", async () => {
    const { token, projectId } = await createUserAndProject("Kevin");

    const upload1 = await uploadFile({ token, projectId, filePath: fixtures["sample.jpg"], mimeType: "image/jpeg" });
    await new Promise((r) => setTimeout(r, 50)); // ensure a distinct created_at ordering
    const upload2 = await uploadFile({ token, projectId, filePath: fixtures["sample.mp3"], mimeType: "audio/mpeg" });

    await waitUntilProcessed(token, upload1.json.asset.id);
    await waitUntilProcessed(token, upload2.json.asset.id);

    const res = await jsonRequest("GET", `/api/v1/projects/${projectId}/media`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.json.assets.length, 2);
    // Stable order: created_at DESC -> most recently uploaded first.
    assert.equal(res.json.assets[0].id, upload2.json.asset.id);
    assert.equal(res.json.assets[1].id, upload1.json.asset.id);

    for (const asset of res.json.assets) {
      assert.equal(asset.projectId, projectId);
      assert.ok("mediaType" in asset);
      assert.ok("status" in asset);
      assert.ok("durationSeconds" in asset);
      // Never leak filesystem details through the public HTTP API.
      assert.equal("storageKey" in asset, false);
      assert.equal("storage_key" in asset, false);
      assert.ok(!JSON.stringify(asset).includes(storage.STORAGE_ROOT));
    }

    // Backward-compatible query-param form (kept from Sprint 1) must agree.
    const legacy = await jsonRequest("GET", `/api/v1/media?projectId=${projectId}`, { token });
    assert.equal(legacy.status, 200);
    assert.deepEqual(
      legacy.json.assets.map((a) => a.id).sort(),
      res.json.assets.map((a) => a.id).sort()
    );

    // Cleanup.
    await fetch(`${baseUrl}/api/v1/media/${upload1.json.asset.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await fetch(`${baseUrl}/api/v1/media/${upload2.json.asset.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  });

  test("stream/thumbnail/waveform/delete all return 403 for a user who does not own the asset's project", async () => {
    const owner = await createUserAndProject("Laura");
    const intruder = await createUserAndProject("Mike");

    const upload = await uploadFile({
      token: owner.token,
      projectId: owner.projectId,
      filePath: fixtures["sample.mp4"],
      mimeType: "video/mp4",
    });
    const assetId = upload.json.asset.id;
    await waitUntilProcessed(owner.token, assetId);

    const streamRes = await fetch(`${baseUrl}/api/v1/media/${assetId}/stream`, {
      headers: { Authorization: `Bearer ${intruder.token}` },
    });
    assert.equal(streamRes.status, 403);

    const thumbRes = await fetch(`${baseUrl}/api/v1/media/${assetId}/thumbnail`, {
      headers: { Authorization: `Bearer ${intruder.token}` },
    });
    assert.equal(thumbRes.status, 403);

    const waveformRes = await jsonRequest("GET", `/api/v1/media/${assetId}/waveform`, { token: intruder.token });
    assert.equal(waveformRes.status, 403);

    const deleteRes = await fetch(`${baseUrl}/api/v1/media/${assetId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${intruder.token}` },
    });
    assert.equal(deleteRes.status, 403);

    // The asset and all its files must be completely untouched by the
    // rejected delete attempt.
    const stillThere = await jsonRequest("GET", `/api/v1/media/${assetId}`, { token: owner.token });
    assert.equal(stillThere.status, 200);
    assert.equal(await storage.exists(`${assetId}/original.mp4`), true);
    assert.equal(await storage.exists(`${assetId}/proxy.mp4`), true);

    // The real owner can still do all of the above.
    const ownerStream = await fetch(`${baseUrl}/api/v1/media/${assetId}/stream`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(ownerStream.status, 200);
    await ownerStream.arrayBuffer();

    await fetch(`${baseUrl}/api/v1/media/${assetId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
  });

  test("project-deletion media cleanup: deleting a project with no media is a safe no-op", async () => {
    const { token, projectId } = await createUserAndProject("Nancy");
    const res = await fetch(`${baseUrl}/api/v1/dev/projects/${projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 204);

    const check = await pool.query("SELECT 1 FROM dev_projects WHERE id = $1", [projectId]);
    assert.equal(check.rows.length, 0);
  });

  test("project-deletion media cleanup: 404 for a nonexistent project, 403 for someone else's project", async () => {
    const owner = await createUserAndProject("Oscar");
    const intruder = await createUserAndProject("Peggy");

    const notFound = await fetch(`${baseUrl}/api/v1/dev/projects/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(notFound.status, 404);

    const forbidden = await fetch(`${baseUrl}/api/v1/dev/projects/${owner.projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${intruder.token}` },
    });
    assert.equal(forbidden.status, 403);

    // Confirm the rejected delete attempt left the project intact.
    const stillThere = await pool.query("SELECT 1 FROM dev_projects WHERE id = $1", [owner.projectId]);
    assert.equal(stillThere.rows.length, 1);
  });

  test("project-deletion media cleanup: deleting a project removes every media_assets row AND every file on disk, not just the project row", async () => {
    const { token, projectId } = await createUserAndProject("Quinn");

    const upload1 = await uploadFile({ token, projectId, filePath: fixtures["sample.mp4"], mimeType: "video/mp4" });
    const upload2 = await uploadFile({ token, projectId, filePath: fixtures["sample.jpg"], mimeType: "image/jpeg" });
    const assetId1 = upload1.json.asset.id;
    const assetId2 = upload2.json.asset.id;

    await waitUntilProcessed(token, assetId1);
    await waitUntilProcessed(token, assetId2);

    assert.equal(await storage.exists(`${assetId1}/original.mp4`), true);
    assert.equal(await storage.exists(`${assetId1}/proxy.mp4`), true);
    assert.equal(await storage.exists(`${assetId2}/original.jpg`), true);

    const del = await fetch(`${baseUrl}/api/v1/dev/projects/${projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(del.status, 204);

    // Project row gone.
    const projectRow = await pool.query("SELECT 1 FROM dev_projects WHERE id = $1", [projectId]);
    assert.equal(projectRow.rows.length, 0);

    // media_assets rows gone (via the explicit cleanup call, backed by the
    // ON DELETE CASCADE FK as a safety net either way).
    const assetRows = await pool.query("SELECT 1 FROM media_assets WHERE project_id = $1", [projectId]);
    assert.equal(assetRows.rows.length, 0);

    // Every file for both assets actually removed from disk -- the part a
    // DB-level cascade alone could never do.
    assert.equal(await storage.exists(`${assetId1}/original.mp4`), false);
    assert.equal(await storage.exists(`${assetId1}/proxy.mp4`), false);
    assert.equal(await storage.exists(`${assetId1}/thumbnail.jpg`), false);
    assert.equal(await storage.exists(`${assetId2}/original.jpg`), false);
    assert.equal(await storage.exists(`${assetId2}/thumbnail.jpg`), false);

    // The asset is gone through the API too, not just the DB.
    const afterDelete = await jsonRequest("GET", `/api/v1/media/${assetId1}`, { token });
    assert.equal(afterDelete.status, 404);
  });

  test("project-deletion media cleanup is idempotent (safe to call twice)", async () => {
    const { token, projectId } = await createUserAndProject("Ruth");
    const upload = await uploadFile({ token, projectId, filePath: fixtures["sample.jpg"], mimeType: "image/jpeg" });
    await waitUntilProcessed(token, upload.json.asset.id);

    const { deleteAllMediaForProject } = require("../app/services/projectMediaCleanup.service");
    const first = await deleteAllMediaForProject(projectId);
    assert.equal(first.deletedCount, 1);

    const second = await deleteAllMediaForProject(projectId);
    assert.equal(second.deletedCount, 0);

    await pool.query("DELETE FROM dev_projects WHERE id = $1", [projectId]);
  });

  // --- Sprint 3 ------------------------------------------------------------

  test("GET /api/v1/media/:id/proxy serves the proxy file when ready, 404s when not, and is ownership-checked", async () => {
    const owner = await createUserAndProject("Sam");
    const intruder = await createUserAndProject("Tina");

    const upload = await uploadFile({
      token: owner.token,
      projectId: owner.projectId,
      filePath: fixtures["sample.mp4"],
      mimeType: "video/mp4",
    });
    const assetId = upload.json.asset.id;
    const finalAsset = await waitUntilProcessed(owner.token, assetId);
    assert.equal(finalAsset.proxy.status, "READY");

    const ok = await fetch(`${baseUrl}/api/v1/media/${assetId}/proxy`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "video/mp4");
    await ok.arrayBuffer();

    const forbidden = await fetch(`${baseUrl}/api/v1/media/${assetId}/proxy`, {
      headers: { Authorization: `Bearer ${intruder.token}` },
    });
    assert.equal(forbidden.status, 403);

    // A still-image upload never gets a video proxy -- proxy_status stays
    // NOT_APPLICABLE, so the endpoint must 404, not serve a stale/empty file.
    const imageUpload = await uploadFile({
      token: owner.token,
      projectId: owner.projectId,
      filePath: fixtures["sample.jpg"],
      mimeType: "image/jpeg",
    });
    await waitUntilProcessed(owner.token, imageUpload.json.asset.id);
    const noProxy = await fetch(`${baseUrl}/api/v1/media/${imageUpload.json.asset.id}/proxy`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(noProxy.status, 404);

    await fetch(`${baseUrl}/api/v1/media/${assetId}`, { method: "DELETE", headers: { Authorization: `Bearer ${owner.token}` } });
    await fetch(`${baseUrl}/api/v1/media/${imageUpload.json.asset.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
  });

  test("requireProjectAccess: GET /api/v1/projects/:projectId/media rejects a malformed projectId with 400, not a raw DB error", async () => {
    const { token } = await createUserAndProject("Uma");
    const res = await jsonRequest("GET", "/api/v1/projects/not-a-real-uuid/media", { token });
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.json).toLowerCase().includes("syntax"));
  });

  test("full pipeline: user -> project -> upload -> processing -> mediaResolver -> Member 3A-compatible contract", async () => {
    const { token, userId, projectId } = await createUserAndProject("Victor");
    const { getProjectAssetsMap, resolveProjectAsset, RESOLUTION_STATUS } = require("../app/services/mediaResolver.service");

    const upload = await uploadFile({
      token,
      projectId,
      filePath: fixtures["sample.mp4"],
      mimeType: "video/mp4",
    });
    const assetId = upload.json.asset.id;
    const apiAsset = await waitUntilProcessed(token, assetId);

    // This is exactly how Member 3A is expected to consume media: never SQL,
    // never a storage path, only projectId + the authenticated userId.
    const map = await getProjectAssetsMap(projectId, userId);
    assert.equal(map.status, "OK");
    assert.ok(map.assets.has(assetId));

    const resolved = map.assets.get(assetId);
    assert.equal(resolved.status, RESOLUTION_STATUS.READY);
    assert.equal(resolved.asset.width, apiAsset.width);
    assert.equal(resolved.asset.durationSeconds, apiAsset.durationSeconds);
    assert.equal(resolved.asset.videoCodec, apiAsset.videoCodec);
    assert.equal(fs.existsSync(resolved.asset.sourcePath), true);

    // resolveProjectAsset for the same asset must agree with the map entry.
    const single = await resolveProjectAsset(projectId, assetId, { userId });
    assert.equal(single.status, RESOLUTION_STATUS.READY);
    assert.equal(single.asset.sourcePath, resolved.asset.sourcePath);

    // And an explicit render-purpose resolution must point at the original,
    // which the timeline compiler needs for a real export.
    const forRender = await resolveProjectAsset(projectId, assetId, { userId, purpose: "render" });
    assert.equal(forRender.asset.sourceKind, "original");
    assert.equal(fs.existsSync(forRender.asset.sourcePath), true);

    await fetch(`${baseUrl}/api/v1/media/${assetId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  });
});
