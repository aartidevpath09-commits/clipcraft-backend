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

let server;
let baseUrl;
const fixtures = ensureFixtures();

// Every dev_user created below is tracked here and deleted by exact id in
// after() (which cascades to its dev_projects/media_assets rows -- see the
// FKs in app/db/migrations/001_dev_placeholder_auth.sql and
// 003_media_assets_project_fk.sql). This is deliberately NOT a blanket
// TRUNCATE: node --test runs each test *file* as its own concurrent child
// process against the same shared development database (see
// tests/helpers/testEnv.js), so a TRUNCATE here could delete rows another
// test file is still using mid-run. Deleting only the specific ids this
// file created is safe under that concurrency because ids are random
// UUIDs that never collide across files.
const createdUserIds = [];

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

async function uploadFile({ token, projectId, filePath, mimeType, fieldOrderSwap, filenameOverride }) {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mimeType });
  const filename = filenameOverride || path.basename(filePath);
  if (fieldOrderSwap) {
    form.append("file", blob, filename);
    if (projectId) form.append("projectId", projectId);
  } else {
    if (projectId) form.append("projectId", projectId);
    form.append("file", blob, filename);
  }
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

describe("Media Management API (integration)", () => {
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

  test("rejects unauthenticated requests", async () => {
    const res = await jsonRequest("GET", "/api/v1/media?projectId=00000000-0000-0000-0000-000000000000");
    assert.equal(res.status, 401);
  });

  test("dev login + project creation works", async () => {
    const { token, projectId } = await createUserAndProject("Alice");
    assert.ok(token);
    assert.ok(projectId);
  });

  test("full lifecycle: upload -> processing -> stream -> thumbnail -> waveform -> delete", async () => {
    const { token, projectId } = await createUserAndProject("Bob");

    const upload = await uploadFile({
      token,
      projectId,
      filePath: fixtures["sample.mp4"],
      mimeType: "video/mp4",
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.json.asset.status, "UPLOADING");
    const assetId = upload.json.asset.id;

    const finalAsset = await waitUntilProcessed(token, assetId);
    assert.equal(finalAsset.status, "READY");
    assert.equal(finalAsset.proxy.status, "READY");
    assert.equal(finalAsset.thumbnail.status, "READY");
    assert.equal(finalAsset.waveform.status, "READY");
    assert.equal(finalAsset.width, 320);
    assert.equal(finalAsset.videoCodec, "h264");

    const streamRes = await fetch(`${baseUrl}/api/v1/media/${assetId}/stream`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get("accept-ranges"), "bytes");
    await streamRes.arrayBuffer();

    const rangeRes = await fetch(`${baseUrl}/api/v1/media/${assetId}/stream`, {
      headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-999" },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get("content-length"), "1000");
    await rangeRes.arrayBuffer();

    const thumbRes = await fetch(`${baseUrl}/api/v1/media/${assetId}/thumbnail`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(thumbRes.status, 200);
    assert.equal(thumbRes.headers.get("content-type"), "image/jpeg");

    const waveformRes = await jsonRequest("GET", `/api/v1/media/${assetId}/waveform`, { token });
    assert.equal(waveformRes.status, 200);
    assert.ok(Array.isArray(waveformRes.json.peaks));

    const listRes = await jsonRequest("GET", `/api/v1/media?projectId=${projectId}`, { token });
    assert.equal(listRes.json.assets.length, 1);

    // Every derived file must actually exist on disk before we assert delete removes them.
    assert.equal(await storage.exists(`${assetId}/original.mp4`), true);
    assert.equal(await storage.exists(`${assetId}/proxy.mp4`), true);
    assert.equal(await storage.exists(`${assetId}/thumbnail.jpg`), true);
    assert.equal(await storage.exists(`${assetId}/waveform.json`), true);

    const deleteRes = await fetch(`${baseUrl}/api/v1/media/${assetId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(deleteRes.status, 204);

    const afterDelete = await jsonRequest("GET", `/api/v1/media/${assetId}`, { token });
    assert.equal(afterDelete.status, 404);

    // DELETE must remove the original AND every derived file, not just the DB row.
    assert.equal(await storage.exists(`${assetId}/original.mp4`), false);
    assert.equal(await storage.exists(`${assetId}/proxy.mp4`), false);
    assert.equal(await storage.exists(`${assetId}/thumbnail.jpg`), false);
    assert.equal(await storage.exists(`${assetId}/waveform.json`), false);
  });

  test("deleting an asset immediately after upload leaves no orphaned derived files once background processing catches up", async () => {
    // Regression test for the upload/processing/delete race (code review
    // section 4.2): background proxy/thumbnail/waveform processing is
    // enqueued fire-and-forget right after upload (see
    // app/services/processingQueue.service.js) and is almost certainly
    // still in flight the instant this DELETE lands -- which is exactly
    // the scenario processing.service.js's runDerivedJob() now guards
    // against (see its own comment for the mechanism).
    const { token, projectId } = await createUserAndProject("RaceConditionUser");

    const upload = await uploadFile({
      token,
      projectId,
      filePath: fixtures["sample.mp4"],
      mimeType: "video/mp4",
    });
    assert.equal(upload.status, 201);
    const assetId = upload.json.asset.id;

    const deleteRes = await fetch(`${baseUrl}/api/v1/media/${assetId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(deleteRes.status, 204);

    // Give any still-in-flight background job (ffprobe + up to three ffmpeg
    // invocations against a 2-second synthetic fixture) time to finish.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // The asset directory must stay gone -- including derived files a
    // still-running job could otherwise have written back into existence
    // (via ensureParentDir's mkdir -p) after this DELETE already removed it.
    assert.equal(await storage.exists(`${assetId}/original.mp4`), false);
    assert.equal(await storage.exists(`${assetId}/proxy.mp4`), false);
    assert.equal(await storage.exists(`${assetId}/thumbnail.jpg`), false);
    assert.equal(await storage.exists(`${assetId}/waveform.json`), false);

    const afterDelete = await jsonRequest("GET", `/api/v1/media/${assetId}`, { token });
    assert.equal(afterDelete.status, 404);
  });

  test("enforces project ownership: 403 for a different user, 404 for a nonexistent project", async () => {
    const owner = await createUserAndProject("Carol");
    const intruder = await createUserAndProject("Mallory");

    const upload = await uploadFile({
      token: owner.token,
      projectId: owner.projectId,
      filePath: fixtures["sample.jpg"],
      mimeType: "image/jpeg",
    });
    const assetId = upload.json.asset.id;

    const asIntruder = await jsonRequest("GET", `/api/v1/media/${assetId}`, { token: intruder.token });
    assert.equal(asIntruder.status, 403);

    const uploadToNonexistentProject = await uploadFile({
      token: owner.token,
      projectId: "00000000-0000-0000-0000-000000000000",
      filePath: fixtures["sample.jpg"],
      mimeType: "image/jpeg",
    });
    assert.equal(uploadToNonexistentProject.status, 404);

    await fetch(`${baseUrl}/api/v1/media/${assetId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
  });

  test("rejects a file field sent before the projectId field", async () => {
    const { token, projectId } = await createUserAndProject("Dave");
    const res = await uploadFile({
      token,
      projectId,
      filePath: fixtures["sample.mp3"],
      mimeType: "audio/mpeg",
      fieldOrderSwap: true,
    });
    assert.equal(res.status, 400);
  });

  test("rejects spoofed file content (real PNG bytes renamed+declared as .mp4)", async () => {
    const { token, projectId } = await createUserAndProject("Eve");
    const res = await uploadFile({
      token,
      projectId,
      filePath: fixtures["sample.png"],
      mimeType: "video/mp4",
      filenameOverride: "evil.mp4",
    });
    assert.equal(res.status, 415);
  });

  test("error responses never include a stack trace or filesystem path", async () => {
    const { token } = await createUserAndProject("Frank");
    const res = await jsonRequest("GET", "/api/v1/media/not-a-valid-uuid", { token });
    assert.equal(res.status, 400);
    const bodyText = JSON.stringify(res.json);
    assert.ok(!bodyText.includes("/home/"));
    assert.ok(!bodyText.includes("at Object."));
    assert.ok(!bodyText.toLowerCase().includes("stack"));
  });

  test("unknown routes return a clean 404", async () => {
    // A path outside any mounted router (media/dev routes require auth
    // first, which would otherwise return 401 before route-matching).
    const res = await jsonRequest("GET", "/api/v1/totally-unknown-route");
    assert.equal(res.status, 404);
  });
});
