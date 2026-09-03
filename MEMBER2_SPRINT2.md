# Member 2 — Sprint 2: Media / Project Integration

Engineering report for Sprint 2. Builds directly on the Sprint 1 media pipeline documented in [`MEMBER2_MEDIA_MANAGEMENT.md`](./MEMBER2_MEDIA_MANAGEMENT.md); read that first for storage layout, the processing lifecycle, and the multipart upload contract, none of which changed.

**Sprint 3 ([`MEMBER2_SPRINT3.md`](./MEMBER2_SPRINT3.md)) changes `mediaResolver.service.js`'s call signature** (section 3 of this document's `resolveProjectAsset(assetId, projectId, userId)` became `resolveProjectAsset(projectId, assetId, options)`, and adds a `SOURCE_MISSING` status plus render/preview source selection) and adds `GET /api/v1/media/:id/proxy`. Everything else below is unchanged and still accurate.

**Scope, restated:** Member 2 owns media management and project-media integration — associating media assets with projects, enforcing project/user ownership on every media-touching endpoint, and giving the Video Engine a clean way to resolve a project's media without knowing this module's internals. **Timeline processing remains Member 3A's responsibility.** This sprint did not touch authentication, project CRUD, timeline persistence/processing, the FFmpeg render compiler, or the render queue.

## 1. Files changed

**New:**

```
app/db/migrations/003_media_assets_project_fk.sql   real FK: media_assets.project_id -> dev_projects.id
app/routes/projectMedia.routes.js                   GET /:projectId/media, mounted at /api/v1/projects
app/services/mediaResolver.service.js                Member 3A integration contract
app/services/projectMediaCleanup.service.js          Member 1 project-deletion cleanup contract

tests/mediaResolver.test.js                          10 new tests
tests/projectMedia.test.js                            10 new tests

MEMBER2_SPRINT2.md                                    this report
```

**Modified (all additive, called out inline with `// Sprint 2` / `-- Sprint 2` comments):**

- **`app/server.js`** — two new `require`s (`projectMedia.routes.js`) and one new `app.use("/api/v1/projects", projectMediaRoutes)` mount. Every Sprint 1 line, mount, and behavior is unchanged.
- **`app/controllers/media.controller.js`** — added `listByProject` (backs the new path-param endpoint) and refactored the Sprint 1 `list` handler to share a new `fetchProjectMediaList` helper instead of duplicating the ownership-check-then-fetch logic. `list`'s external behavior (response shape, status codes) is unchanged; it now shares code with `listByProject` rather than being rewritten.
- **`app/controllers/dev.controller.js`** — added `deleteProject`, which demonstrates the cleanup contract (see section 6). This is dev-only scaffolding, not Member 2's project CRUD — see section 9.
- **`app/routes/dev.routes.js`** — one new route, `DELETE /projects/:id`, wired to the handler above.
- **`app/db/mediaAssets.repository.js`** — added `deleteAllByProjectId` (single bulk `DELETE ... WHERE project_id = $1`, used by the cleanup service). Every Sprint 1 function is unchanged.
- **`MEMBER2_MEDIA_MANAGEMENT.md`** — one paragraph added at the top pointing here for the now-superseded FK/route-table statements; no other line touched.

**Not touched at all:** `app/services/storage.service.js`, `app/services/ffprobe.service.js`, `app/services/ffmpeg.service.js`, `app/services/waveform.service.js`, `app/services/processing.service.js`, `app/services/processingQueue.service.js`, `app/services/uploadParser.service.js`, `app/services/validation.service.js`, `app/services/ownership.service.js` (already had the right shape from Sprint 1 — see section 4), `app/middleware/devAuth.js`, `app/middleware/errorHandler.js`, `app/config/*`, `app/db/migrate.js`, `app/db/migrations/001_*.sql`, `app/db/migrations/002_*.sql`, all Sprint 1 test files, `package.json` (no new dependency was needed).

## 2. Database changes

One new migration, `003_media_assets_project_fk.sql`, applied via the existing `npm run migrate` runner (idempotent — already applied migrations are skipped).

**Foreign key.** `media_assets.project_id` now has a real, enforced FK:

```sql
ALTER TABLE media_assets
  ADD CONSTRAINT fk_media_assets_project
  FOREIGN KEY (project_id) REFERENCES dev_projects(id) ON DELETE CASCADE;
```

**This is provisional and documented as such in the migration file.** Member 1's real `projects` table does not exist on this branch yet (confirmed by inspecting the repository before writing this migration — `dev_projects` is the only project-like table that exists). The FK points at `dev_projects` because that is the actual existing schema this constraint can be compatible with today. The cutover once Member 1 ships the real table is a single follow-up migration (drop this constraint, add the same constraint pointing at `projects(id)`) — no other change to `media_assets` is needed. A defensive `DELETE` runs before the `ALTER TABLE` to remove any pre-existing rows that would violate the new constraint, so the migration can never fail on old ad-hoc test data.

**`user_id` column: deliberately not added.** The brief asked to decide this rather than default to adding both. `media_assets.project_id -> dev_projects.owner_id` already gives an unambiguous ownership path, and a project is (per the brief's own conceptual chain) User → Project → Media Assets — ownership is a project-level fact, not a per-asset one. Duplicating it onto every media row would create a second source of truth that could drift from the project's actual owner. `media_assets.uploaded_by` (a Sprint 1 column) is kept, but as non-authoritative audit metadata only — "who uploaded this asset" is a different fact from "who owns the project" in a collaborative editor, and it is never consulted by any authorization check in this codebase.

**Indexing.** The Sprint 1 single-column `idx_media_assets_project_id` is replaced with a composite index:

```sql
CREATE INDEX idx_media_assets_project_created
  ON media_assets(project_id, created_at DESC);
```

This serves plain `project_id` lookups (as the leading column) and also backs the listing endpoints' `ORDER BY created_at DESC` directly, so project-media listing is a single indexed scan rather than an index lookup plus a separate sort. The old single-column index would have been redundant alongside it, hence the drop.

**All Sprint 1 columns are unchanged** — no column was renamed, retyped, or dropped.

## 3. API changes

**New endpoint:**

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/projects/:projectId/media` | Canonical Sprint 2 form for building a project's media bin. Same response shape as the list below. 404 for a nonexistent project, 403 for one you don't own, 200 with `{ assets: [] }` for an empty-but-owned project. |

**Kept, unchanged in behavior:** `GET /api/v1/media?projectId=...` (Sprint 1's query-param form) still works exactly as before — both endpoints now share one internal helper (`fetchProjectMediaList`) so there is exactly one implementation of "verify ownership, then fetch," not two that could drift apart. `POST /api/v1/media/upload`, `GET /api/v1/media/:id`, `GET /api/v1/media/:id/stream`, `GET /api/v1/media/:id/thumbnail`, `GET /api/v1/media/:id/waveform`, and `DELETE /api/v1/media/:id` are all unchanged from Sprint 1 — this sprint added authorization-adjacent plumbing around them, not a redesign (they already enforced ownership via `loadOwnedAsset`, which was already correct going into this sprint — see section 4).

**Dev-only (not part of the permanent API surface, see section 9):** `DELETE /api/v1/dev/projects/:id`, demonstrating the cleanup contract in section 6.

Route-namespace note: `projectMedia.routes.js` defines *only* `GET /:projectId/media` under the `/api/v1/projects` prefix. It deliberately does not define `GET /:projectId`, `POST /`, `PATCH /:projectId`, etc. — that leaves the rest of `/api/v1/projects` free for Member 1's project CRUD router to be mounted at the same prefix later without any path collision, since Express matches on the full pattern and `/:projectId/media` never matches a bare `/:projectId` request.

Error convention is unchanged from Sprint 1: every failure is `{ error: "CODE", message: "..." }` with one of 400/401/403/404/413/415/500 (409/422 were available in `ApiError` but no Sprint 2 endpoint needed them — nothing here has a uniqueness/conflict case or a semantically-invalid-but-well-formed-input case beyond what 400/415 already cover). No response includes a stack trace or filesystem path (unchanged from Sprint 1, still covered by an automated test).

## 4. Authorization

**Every media-touching endpoint requires project/user ownership**, checked via `checkProjectOwnership(projectId, userId)` in `app/services/ownership.service.js` — this file already existed from Sprint 1 with exactly the right shape (`{exists, isOwner}`) and needed no change this sprint. The chain enforced everywhere is `media_assets.project_id -> dev_projects.owner_id === <authenticated user>`:

- **Upload** (`uploadParser.service.js`) resolves ownership as soon as the `projectId` field arrives, before any file bytes are read — an unauthorized or nonexistent-project upload is rejected immediately, never after streaming a large file to disk. (Unchanged from Sprint 1; re-verified this sprint per the brief's request, no defect found.)
- **Every single-asset operation** (metadata, stream, thumbnail, waveform, delete) goes through `loadOwnedAsset(assetId, userId)` in `media.controller.js`, which loads the asset, then checks ownership of *its project* — never a client-supplied `projectId` or `userId`. 404 vs 403 semantics: a nonexistent asset, or one whose project no longer exists, is 404; an asset that exists but isn't yours is 403 (this boundary was already correct from Sprint 1 and is now covered by dedicated Sprint 2 tests for stream/thumbnail/waveform specifically, not just metadata — see section 7).
- **Project media listing**, both forms, goes through `fetchProjectMediaList(projectId, userId)`, which checks ownership *before* querying `media_assets` at all.
- **Project deletion cleanup** (`deleteAllMediaForProject`) is only ever reachable, in this codebase, after the caller (`dev.controller.js`'s `deleteProject`) has already verified ownership — the function itself does not re-check, since by contract it is Member 1's project-deletion flow that is responsible for calling it in the right place (after their own authorization, before their own row delete).

**Identity is never taken from the request body.** The authenticated user id comes from `req.devUser.id`, set by `devAuthRequired` (`app/middleware/devAuth.js`) after verifying a signed JWT — the same isolated dev-auth placeholder from Sprint 1, unchanged this sprint. No handler anywhere reads `req.body.userId` or a client-supplied user id for an authorization decision. When Member 1's real auth lands, only `devAuthRequired`'s replacement needs to keep setting `req.devUser.id` from verified session/token state — every ownership check downstream already only trusts that field.

**All queries remain parameterized** — no string-built SQL was introduced this sprint (see `ownership.service.js`, `mediaAssets.repository.js`, `dev.controller.js`). Path-traversal and storage-key validation in `storage.service.js` are untouched.

## 5. Member 3A (Video Engine) integration contract

`app/services/mediaResolver.service.js` is the sole integration surface Member 3A should use. It never exposes PostgreSQL table structure, storage folder layout, or how upload/ffprobe/thumbnail/waveform work — callers get back either a small discriminated status plus (for `READY`) a flat metadata + absolute-path object.

**Two entry points**, both taking the caller's authenticated `userId` and the `projectId` being operated on (never a client-supplied `userId`):

```js
const { resolveProjectAsset, getProjectAssetsMap, RESOLUTION_STATUS } = require("./services/mediaResolver.service");

// One asset:
const result = await resolveProjectAsset(assetId, projectId, userId);
// result.status is one of:
//   FORBIDDEN     - projectId doesn't exist, or doesn't belong to userId
//   NOT_FOUND     - no media_assets row with this id at all
//   WRONG_PROJECT - the asset exists, but not inside the given project
//   NOT_READY     - asset exists and belongs to the project, but isn't READY
//                   (result.assetStatus is 'UPLOADING' | 'PROCESSING' | 'FAILED';
//                    result.errorMessage is set when assetStatus is 'FAILED')
//   READY         - result.asset has the full payload (below)

// A whole project at once (e.g. to process a timeline in one pass):
const projectResult = await getProjectAssetsMap(projectId, userId);
// projectResult.status is 'FORBIDDEN' or 'OK'
// projectResult.assets is a Map<assetId, entry>, one query, not one lookup per clip
```

The `READY` payload (`resolveProjectAsset`'s `result.asset`, and each `OK` entry with `status: 'READY'` in `getProjectAssetsMap`'s map): `id`, `projectId`, `mediaType`, `status`, `durationSeconds`, `width`, `height`, `fps`, `hasAudio`, `videoCodec`, `audioCodec`, `containerFormat`, and four server-side-only absolute paths — `originalPath`, `proxyPath`, `thumbnailPath`, `waveformPath` (each derived-asset path is `null`, not a dangling path, until that specific derived asset's own status is `READY`). **These absolute paths are for the Video Engine's own in-process FFmpeg calls only and must never be forwarded to a browser/HTTP client** — nothing in this codebase's HTTP layer returns them (verified by a Sprint 2 test asserting the public listing endpoints never include a storage key or the storage root path).

Ownership is checked **before** the asset is looked up in `resolveProjectAsset`, so an unauthorized caller's response is indistinguishable whether the asset exists or not (`FORBIDDEN` either way) — it never leaks asset existence to someone who shouldn't see the project at all. A caller who already owns the project but is confused about the asset gets the more specific `NOT_FOUND` / `WRONG_PROJECT` / `NOT_READY`.

A lower-level `resolveAsset(mediaAssetId, { expectedProjectId })` is also exported, explicitly documented as **not** performing an ownership check itself — only for internal use where the caller has already established authorization some other way.

**When storage moves to S3 or anywhere else**, only `storage.service.js` changes; this resolver's shapes and every one of Member 3A's call sites stay the same.

## 6. Project-deletion media cleanup integration (for Member 1)

Member 2 does not own project deletion — Member 1 does. `app/services/projectMediaCleanup.service.js` exports the one function their project-deletion flow needs to call:

```js
const { deleteAllMediaForProject } = require("./services/projectMediaCleanup.service");

// In Member 1's project-deletion flow, AFTER their own ownership/auth check:
await deleteAllMediaForProject(projectId);   // 1. removes every file + every media_assets row
await pool.query("DELETE FROM projects WHERE id = $1", [projectId]); // 2. Member 1's own code
```

**Order matters, and is documented at the top of the file:** call this *before* deleting the project row.

**Why this is needed even though there is now an `ON DELETE CASCADE` FK (section 2):** the cascade is a database-level safety net — it guarantees a deleted project can never leave orphaned `media_assets` *rows* behind, even if application code forgets to call this function. But Postgres cannot touch the filesystem. If a project row is deleted without calling `deleteAllMediaForProject` first, the cascade silently removes the database rows while every original/proxy/thumbnail/waveform file for that project is left on disk forever, with no row left pointing at it and nothing that will ever clean it up. Calling this function first removes the files and the rows together, so nothing is orphaned in either place regardless of which order a future refactor might introduce.

Behavior: fetches every `media_assets` row for the project, deletes each asset's entire storage directory (original + all derived files in one recursive removal — reusing `storage.service.js`'s existing `deleteAssetDirectory`, the same one Sprint 1's single-asset delete uses), logging and continuing past any individual filesystem failure rather than aborting the whole batch or blocking project deletion on a bad file. It then does **one bulk** `DELETE FROM media_assets WHERE project_id = $1` (not N per-asset deletes) via the new `deleteAllByProjectId` repository function. Safe to call on a project with zero media (no-op, `deletedCount: 0`) and safe to call twice (idempotent) — both covered by tests.

`app/controllers/dev.controller.js`'s new `deleteProject` handler (`DELETE /api/v1/dev/projects/:id`) exists **solely to make this contract exercisable end-to-end today**, standing in for Member 1's not-yet-built real project-deletion endpoint. It is explicitly not Member 2's project CRUD — it's scaffolding, in the same isolated `dev_*` namespace as the rest of Sprint 1's dev-auth placeholder, and is called out as such in its own doc comment.

## 7. Tests

**Ran the full existing suite first (regression) — all 46 Sprint 1 tests still pass, unchanged, with zero modifications to any Sprint 1 test file.**

**Added 20 new tests, all passing, in two new files:**

`tests/mediaResolver.test.js` (10 tests) — direct, HTTP-free tests of the Member 3A contract against the real database and the real `mediaAssets` repository (no mocks of the resolver itself; asset rows are seeded via the same repository the resolver reads, so PROCESSING/FAILED/UPLOADING states are deterministic instead of racing a background job):
- `resolveProjectAsset`: `FORBIDDEN` for another user's project, `FORBIDDEN` for a nonexistent project (never leaks asset existence), `NOT_FOUND` for a bogus asset id, `WRONG_PROJECT` for an asset that exists but in a different project the same user owns, `NOT_READY` for each of `UPLOADING`/`PROCESSING`/`FAILED` (including that `errorMessage` is only populated for `FAILED`), `READY` with full metadata and confirmation that raw `storage_key`/`storageKey` never appear in the payload and unset derived paths are `null` rather than omitted or wrong.
- `getProjectAssetsMap`: `FORBIDDEN` for a non-owner, `OK` with an empty `Map` for a media-less project, `OK` correctly classifying a mix of `READY`/`PROCESSING`/`FAILED` assets in one call, and confirmation an asset from a different project is never included.

`tests/projectMedia.test.js` (10 tests) — full HTTP integration tests, real server + real DB + real ffmpeg/ffprobe (reusing the same fixture-generation helper as the Sprint 1 suite):
- `GET /api/v1/projects/:projectId/media`: 401 unauthenticated, empty array for a fresh project, 404 for a nonexistent project, 403 for someone else's project, and — with two real uploaded-and-processed assets — correct non-leaky fields, stable `created_at DESC` ordering, and agreement with the Sprint 1 query-param form.
- Stream, thumbnail, waveform, **and** delete each independently return 403 for a user who owns a different project (Sprint 1 only asserted this for plain metadata GET); the asset and its files are confirmed completely untouched after the rejected delete attempt; the real owner is then confirmed to still be able to do all four.
- Project-deletion cleanup: no-op on a media-less project; 404 for a nonexistent project and 403 for someone else's project (with confirmation the project row survives the rejected attempt); deleting a project with two real assets removes the project row, every `media_assets` row, and every file for both assets from disk (not just the DB); calling `deleteAllMediaForProject` twice in a row is confirmed idempotent (`deletedCount: 1` then `0`).

**Full suite result at time of writing: 66 tests, 66 passing, 0 failing, across 9 suites** (`npm test`). No test in either new file uses a mock or fake of anything under `app/` — every assertion runs against the real Postgres database (via `runMigrations()` + the shared pool) and, for the HTTP suite, real `ffmpeg`/`ffprobe` binaries through the unmodified Sprint 1 processing pipeline.

## 8. Confirmation: Sprint 1 is intact

- All 46 Sprint 1 tests pass unmodified.
- No Sprint 1 file was rewritten wholesale; every change to a shared file (`server.js`, `media.controller.js`, `mediaAssets.repository.js`, `dev.routes.js`) is additive and marked inline.
- Sprint 1's upload validation, streaming (Range support), thumbnail/waveform/proxy generation, and single-asset deletion behavior are byte-for-byte unchanged — this sprint added authorization *coverage* and *tests* around them, not new logic in them.
- Every Sprint 1 API response shape is unchanged; the only new field callers will ever see is the presence of the new endpoint itself.

## 9. Scope confirmation

**Implemented this sprint:** the `media_assets -> projects` foreign key (provisional, documented cutover path), project/user ownership enforcement re-verified across every media-touching endpoint, `GET /api/v1/projects/:projectId/media`, the Member 3A resolver contract, the Member 1 project-deletion cleanup contract, indexing for project-scoped listing, and the tests/documentation above.

**Not implemented, and out of scope by design:**
- **Authentication** — still the isolated `dev_*` placeholder from Sprint 1, unchanged in mechanism this sprint (one new dev-only route was added to exercise the cleanup contract, not a new auth mechanism).
- **Project CRUD** — `dev.controller.js`'s `createProject`/`listProjects`/`deleteProject` are dev-only scaffolding to make media ownership and cleanup testable before Member 1's real projects table exists; none of it is meant to survive that table landing (see the cutover notes in `MEMBER2_MEDIA_MANAGEMENT.md` section J and migration `003`'s header comment).
- **Timeline persistence or timeline processing** — not touched; `mediaResolver.service.js` is deliberately just a read-side contract for the Video Engine to consume, with no opinion on timeline data structures.
- **The FFmpeg render/export compiler or the render queue** — not touched; `processingQueue.service.js`'s `enqueue()` seam (Sprint 1) remains the only queue-shaped thing in this module, and it is unrelated to rendering/export.
