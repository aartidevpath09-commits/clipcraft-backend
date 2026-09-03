# Member 2 — Sprint 3: Media Management, Asset Resolution & Final Integration

Engineering report for Sprint 3, the final integration sprint. Builds on [`MEMBER2_MEDIA_MANAGEMENT.md`](./MEMBER2_MEDIA_MANAGEMENT.md) (Sprint 1) and [`MEMBER2_SPRINT2.md`](./MEMBER2_SPRINT2.md) (Sprint 2) — read those first for storage layout, the processing lifecycle, and the Sprint 1/2 ownership model. **This document supersedes `mediaResolver.service.js`'s call signature as described in Sprint 2** (`resolveProjectAsset` argument order and shape changed this sprint — see section 3); everything else from Sprint 1/2 is unchanged and still accurate.

**Scope, restated:** Member 2 owns media management, asset resolution, and the final integration boundary with Member 3A (Video Engine). This sprint hardened that boundary into a stable, purpose-aware contract, added the physical-file-existence guarantee it was missing, and prepared the auth/authorization seam for a clean handoff to Member 1's real system. **No timeline schema, FFmpeg filtergraph compilation, export job queue, worker, or export storage was implemented — those remain Member 1 / 3A / 3B's scope respectively.**

## 0. Repository inspection & a discrepancy from the brief

Per the brief's instruction to inspect before changing anything and to adapt to (and document) any difference from what was assumed: the Sprint 3 brief's flow diagram and section 6 describe integrating **Member 1's real `authenticateToken` / `requireProjectAccess` middleware and real `users`/`projects` tables**. Inspection of the repository — including the actual git remote, not just the local working tree — found that **none of this exists yet, anywhere**:

- The working tree has no auth routes, user model, or real `projects` table/migration beyond Sprint 1/2's own `dev_users`/`dev_projects` placeholders.
- The repository's remote (`origin`) has four feature branches — `feature/media-management` (this one), `feature/core-api-auth` (Member 1), `feature/render-queue` (Member 3B), `feature/video-engine` (Member 3A). `core-api-auth`, `render-queue`, and `video-engine` are all still sitting at the exact same base commit as `origin/main`, with no commits of their own pushed yet.

So, per the brief's own contingency instruction ("if another member's component does not exist yet, create the minimum integration contract/interface necessary, but do not implement their subsystem"), this sprint's auth/project work is scoped to **finalizing the integration seam** — so that plugging in Member 1's real system later is a small, well-defined change — rather than integrating something that does not exist. This is documented inline in the new code (see section 3) and called out here so it isn't mistaken for an oversight.

## 1. Files changed

**New:**

```
app/middleware/requireProjectAccess.js   Sprint 3 authorization seam: req.user.id -> req.project
tests/mediaResolver.test.js               rewritten in place for the new resolver contract (17 tests)
MEMBER2_SPRINT3.md                        this report
```

**Modified (all additive/targeted, no rewrites of working logic):**

- **`app/services/mediaResolver.service.js`** — the core of this sprint. Signature change (`resolveProjectAsset(assetId, projectId, userId)` → `resolveProjectAsset(projectId, assetId, { userId, purpose })`, matching the Sprint 3 spec exactly), a new `SOURCE_MISSING` status backed by a real filesystem check, and centralized render-vs-preview path selection. See section 3.
- **`app/middleware/devAuth.js`** — one addition: after setting `req.devUser`, also sets `req.user = req.devUser` (same object). No behavior change; this is purely so new code can be written once against `req.user.id` (the name Member 1's real auth is expected to use) and keep working unchanged the moment this file is replaced.
- **`app/routes/projectMedia.routes.js`** — `GET /:projectId/media` now runs through the new `requireProjectAccess` middleware instead of the controller re-deriving ownership itself.
- **`app/controllers/media.controller.js`** — `listByProject` simplified to trust `req.project` (set by the middleware above) instead of re-checking ownership; added `getProxy`, a new handler mirroring `getThumbnail`/`getWaveform`. `list`, `upload`, `getOne`, `streamMedia`, `remove`, and `fetchProjectMediaList` (still used by the query-param `list` route) are unchanged.
- **`app/routes/media.routes.js`** — one new route, `GET /:id/proxy`, wired to the handler above.
- **`tests/projectMedia.test.js`** — three tests appended (proxy endpoint, malformed-projectId handling, full-pipeline integration). Every Sprint 2 test in this file is untouched.

**Not touched:** `app/services/storage.service.js`, `app/services/ffprobe.service.js`, `app/services/ffmpeg.service.js`, `app/services/waveform.service.js`, `app/services/processing.service.js`, `app/services/processingQueue.service.js`, `app/services/uploadParser.service.js`, `app/services/validation.service.js`, `app/services/ownership.service.js`, `app/services/projectMediaCleanup.service.js`, `app/db/mediaAssets.repository.js`, `app/db/migrations/*`, `app/db/migrate.js`, `app/controllers/dev.controller.js`, `app/routes/dev.routes.js`, `app/server.js`, `package.json` (no new dependency), and every Sprint 1 test file.

## 2. Member 2 work completed

- Finalized `mediaResolver.service.js` to the exact Sprint 3 contract shape: `resolveProjectAsset(projectId, assetId, options)` and `getProjectAssetsMap(projectId, userId, options)`.
- Added centralized render-vs-preview source selection (`options.purpose`) so Member 3A never branches on proxy-vs-original itself.
- Added a physical-file-existence guarantee: a `READY` database row is no longer sufficient on its own — the resolver now verifies the selected file (and always the original) actually exists on disk before calling anything `READY`, via a new `SOURCE_MISSING` status.
- Hardened the resolver against malformed/unsafe `projectId`/`assetId` input (UUID-shape validation before either ID ever reaches a SQL query), rather than letting Postgres throw on invalid input.
- Added the `requireProjectAccess` authorization seam and wired it into the one route it naturally fits, matching Member 1's expected `authenticateToken -> req.user.id -> requireProjectAccess -> req.project` flow.
- Added `GET /api/v1/media/:id/proxy` for direct, ownership-checked access to the 360p proxy file.
- Re-verified project/user isolation end to end (see section 4) and added an explicit isolation-matrix test.
- Re-verified `deleteAllMediaForProject` (Sprint 2) against the finalized architecture — no changes were needed; it already used the storage abstraction, already scoped strictly to one project, and already handled partial filesystem failures safely.
- Documented the full Member 3A integration contract (section 5) and the database field mapping (section 6).

## 3. The final Member 2 → Member 3A contract

### `resolveProjectAsset(projectId, assetId, options)`

**Inputs:**
- `projectId` (string, UUID) — the project the asset is expected to belong to.
- `assetId` (string, UUID) — the asset to resolve.
- `options.userId` (string, UUID) — **required.** The authenticated caller's user id. Omitting it is treated as unauthenticated and always resolves to `FORBIDDEN` — it never throws, and it never falls through to "check anyway."
- `options.purpose` (`'render' | 'preview'`, optional, default `'preview'`) — see below.

**Output — one of:**

| `status` | Meaning | Extra fields |
|---|---|---|
| `FORBIDDEN` | `projectId` doesn't exist, doesn't belong to `userId`, `userId` was omitted, or `projectId`/`userId` was malformed | — |
| `NOT_FOUND` | No `media_assets` row with this `assetId` (or `assetId` was malformed) | — |
| `WRONG_PROJECT` | The asset exists, but not inside the given project | — |
| `NOT_READY` | The asset belongs to the project but isn't `READY` yet | `assetStatus` (`'UPLOADING'\|'PROCESSING'\|'FAILED'`), `errorMessage` (set only when `FAILED`) |
| `SOURCE_MISSING` | The database says `READY`, but the physical file this call needs isn't on disk | `message` |
| `READY` | Fully usable | `asset` (full payload, below) |

**The `READY` `asset` payload:** `id`, `projectId`, `mediaType`, `status`, `durationSeconds`, `width`, `height`, `fps`, `hasAudio`, `videoCodec`, `audioCodec`, `containerFormat`, `originalPath`, `proxyPath` (`null` until the proxy is itself `READY`), `thumbnailPath`, `waveformPath`, plus three new Sprint 3 fields: **`purpose`** (echoes what was requested, normalized), **`sourceKind`** (`'original' | 'proxy'` — which file was actually selected), and **`sourcePath`** — **the one path Member 3A's FFmpeg calls should actually use.** `originalPath`/`proxyPath` are still included for transparency and backward compatibility, but `sourcePath` is the point of this contract: Member 3A should never have to decide between them itself.

**Authorization ordering (unchanged from Sprint 2, still load-bearing):** project ownership is checked *before* the asset is even looked up, so a caller with no access to the project gets `FORBIDDEN` regardless of whether the asset id they passed exists — nothing about asset existence leaks to someone who shouldn't see the project at all.

**Readiness, precisely (brief section 13):** an asset is only ever reported `READY` when *all* of: the database record exists, it belongs to the requested project, it belongs to the authenticated user's project, `status === 'READY'`, **and** the physical file needed for the requested purpose actually exists on disk. If the database and filesystem disagree — e.g. a proxy row is marked `READY` but its file was deleted out from under it — the resolver returns `SOURCE_MISSING` rather than silently falling back to the original or otherwise masking the inconsistency. This is a deliberate design choice: a caller (or an on-call engineer looking at a failed render) should be able to see that something is wrong, not have it silently downgraded to a different file they didn't ask for.

### `getProjectAssetsMap(projectId, userId, options)`

**Inputs:** `projectId`, `userId` (required, same fail-closed behavior as above), `options.purpose` (optional, applied uniformly to every asset in the project).

**Output:** `{ status: 'FORBIDDEN' }` or `{ status: 'OK', assets: Map<assetId, entry> }`, where each `entry` has exactly the same shape as `resolveProjectAsset`'s result (`NOT_READY` / `SOURCE_MISSING` / `READY`, etc.) for that asset. One indexed database query (`idx_media_assets_project_created`) regardless of asset count, plus one filesystem existence check per asset — not one query per clip. Assets from any other project are never included, by construction (the underlying query is scoped to `project_id` from the start).

### How Member 3A is expected to use this

```js
const { getProjectAssetsMap, resolveProjectAsset } = require("./services/mediaResolver.service");

// Resolving a whole timeline for compilation/export:
const map = await getProjectAssetsMap(projectId, userId, { purpose: "render" });
if (map.status !== "OK") { /* deny the whole operation */ }

for (const clip of timeline.clips) {
  const resolved = map.assets.get(clip.mediaAssetId);
  if (!resolved || resolved.status !== "READY") {
    // NOT_READY / SOURCE_MISSING / missing entirely -- reject this clip
    // (or the whole render) with a clear error. Never pass anything else
    // to FFmpeg.
    continue;
  }
  ffmpegInput(resolved.asset.sourcePath); // always the original, since purpose was 'render'
}

// Resolving one asset for a preview player:
const single = await resolveProjectAsset(projectId, assetId, { userId, purpose: "preview" });
if (single.status === "READY") {
  playbackSource(single.asset.sourcePath); // proxy when ready, else original
}
```

At no point does Member 3A write SQL, reference `media_assets`, touch `storage.service.js`, or construct a path like `/storage/originals/...` or `/storage/proxies/...` itself — every example above is exactly what a project's Sprint 3 integration test (`tests/projectMedia.test.js`, "full pipeline") exercises.

**Error behavior:** the resolver never throws for an expected authorization/readiness outcome — every one of those is a typed status in the table above, so Member 3A can `switch` on `status` rather than wrapping every call in `try/catch`. It *can* throw for a genuinely unexpected failure (e.g. the database connection itself is down) — that should be treated as an internal error by the caller, same as any other unexpected exception.

## 4. Project/user isolation — verified

The three-user matrix from the brief, and its `getProjectAssetsMap` equivalent, are both covered by a dedicated test (`tests/mediaResolver.test.js`, "Sprint 3 isolation matrix"):

```
User A -> Project A -> Asset A  = READY (success)
User A -> Project B -> Asset B  = FORBIDDEN (denied)
User B -> Project A -> Asset A  = FORBIDDEN (denied)
```

This is enforced identically everywhere media is touched — upload, metadata, stream, proxy, thumbnail, waveform, delete, project listing, and both resolver functions — all through the same `project_id -> dev_projects.owner_id` check in `ownership.service.js` (Sprint 1/2, unchanged this sprint). No endpoint or resolver path trusts a client-supplied `userId` or `projectId` on its own; identity always comes from the authenticated session (`req.devUser.id` / `req.user.id`, or the `userId` explicitly passed by an in-process caller like Member 3A).

## 5. Database

**No new migration this sprint.** The existing `media_assets` schema (Sprint 1's `002_media_assets.sql`, Sprint 2's `003_media_assets_project_fk.sql`) already satisfies every conceptual field the Sprint 3 brief lists — under different, pre-existing names, per the brief's own instruction not to "blindly create duplicate metadata fields if the project already has equivalent fields":

| Brief's conceptual field | Actual column | Note |
|---|---|---|
| `id` | `id` | — |
| `user_id` | `uploaded_by` | Non-authoritative audit metadata (Sprint 2 decision, unchanged) — see below |
| `project_id` | `project_id` | FK to `dev_projects(id)`, `ON DELETE CASCADE` (Sprint 2) |
| `original_name` | `original_filename` | — |
| `storage_path` | `storage_key` | Storage-relative key, never an absolute path (Sprint 1 design, unchanged) |
| `proxy_path` | `proxy_storage_key` | — |
| `thumbnail_path` | `thumbnail_storage_key` | — |
| `waveform_path` | `waveform_storage_key` | — |
| `media_type`, `mime_type`, `status`, `duration_seconds`, `width`, `height`, `fps`, `has_audio` | same names | — |
| codec info | `video_codec`, `audio_codec`, `container_format`, `bitrate_bps`, `sample_rate_hz`, `channels` | — |
| timestamps | `created_at`, `updated_at` | — |

**`media_assets.user_id → users.id`: cannot be created yet.** No `users` table exists anywhere in the repository or on any remote branch (see section 0) — an FK to a nonexistent table isn't a migration Postgres could even run. This is an external dependency on Member 1, not a Member 2 gap. Ownership is, as of Sprint 2, deliberately **not** carried by a per-row `user_id`/FK at all — it's derived transitively via `project_id -> dev_projects.owner_id` (soon `projects.owner_id`/equivalent), on the reasoning that ownership is a project-level fact. `uploaded_by` remains non-authoritative audit metadata and is still never consulted by any authorization check in this codebase. **When Member 1 ships the real `projects` table, the cutover is the single follow-up migration already documented in `003_media_assets_project_fk.sql`** (drop the FK to `dev_projects`, add the same FK pointing at `projects(id)`) — nothing else in this schema needs to change.

**Indexes:** `idx_media_assets_project_created (project_id, created_at DESC)` (Sprint 2) and `idx_media_assets_uploaded_by (uploaded_by)` (Sprint 1) already satisfy the brief's `project_id` and `user_id` index guidance. A composite `(project_id, uploaded_by)` index was considered and **not** added — no query in this codebase filters by both together (ownership goes through `dev_projects.owner_id`, not `uploaded_by`), so it would add write overhead with no read benefit. Per the brief's own "where justified by the existing schema" qualifier, it isn't.

## 6. API compatibility

Every Sprint 1/2 endpoint listed in the brief is preserved, unchanged in URL and response shape. One endpoint the brief listed as already existing (`GET /api/v1/media/:id/proxy`) did not — the actual Sprint 1/2 implementation exposed proxy selection only through `GET /api/v1/media/:id/stream`'s automatic proxy-vs-original logic, with no standalone `/proxy` route. This is called out per the brief's own instruction to document discrepancies from what it assumed already existed. Since the brief explicitly names this endpoint as expected, it was added this sprint (section 2) rather than left as a gap — it's a small, additive, backward-compatible route that mirrors the already-existing `/thumbnail` and `/waveform` handlers, not a rename or behavior change to anything that already worked.

| Method | Path | Sprint |
|---|---|---|
| POST | `/api/v1/media/upload` | 1 |
| GET | `/api/v1/media?projectId=...` | 1 |
| GET | `/api/v1/media/:id` | 1 |
| GET | `/api/v1/media/:id/stream` | 1 |
| GET | `/api/v1/media/:id/proxy` | **3 (new)** |
| GET | `/api/v1/media/:id/thumbnail` | 1 |
| GET | `/api/v1/media/:id/waveform` | 1 |
| DELETE | `/api/v1/media/:id` | 1 |
| GET | `/api/v1/projects/:projectId/media` | 2 (authorization now via `requireProjectAccess`, Sprint 3) |

## 7. Tests

**Baseline (measured before any Sprint 3 change, per the brief's explicit instruction):** `npm test` → **66 passed, 0 failed** (Sprint 1's 46 + Sprint 2's 20).

**After Sprint 3:** `npm test` → **76 passed, 0 failed.** All 66 prior tests still pass; `tests/mediaResolver.test.js` was rewritten in place to match the resolver's new, intentionally-changed signature (this is an update to match a deliberate API change this same sprint, not a weakened assertion — every scenario the old file covered is still covered, plus the new ones below) and now has 17 tests (up from 10); `tests/projectMedia.test.js` gained 3 tests on top of its existing 10, none removed or weakened.

New coverage this sprint, matching the brief's testing requirements section by section:

- **Resolver tests:** valid project + valid asset (`READY`, full metadata, `sourcePath` resolvable and existing on disk); valid project + missing/malformed asset id (`NOT_FOUND`); wrong project + existing asset (`WRONG_PROJECT`); wrong user + existing asset, and no `userId` at all (`FORBIDDEN`, fails closed); asset not `READY` for each of `UPLOADING`/`PROCESSING`/`FAILED` (`NOT_READY`); a `READY` database row whose original file is missing from disk, and separately one whose `READY` proxy file is missing while the original is present (`SOURCE_MISSING`, both cases, including confirming no silent fallback); `purpose: 'render'` (always original, even with a ready proxy) and `purpose: 'preview'` (proxy when ready, else original, including the default with no `purpose` passed).
- **Isolation tests:** the exact three-line matrix from the brief (section 4 above), through both `resolveProjectAsset` and `getProjectAssetsMap`.
- **Project deletion tests:** unchanged from Sprint 2 (still passing) — re-verified rather than re-implemented, since `deleteAllMediaForProject` needed no changes this sprint.
- **Integration test:** a new end-to-end test (`tests/projectMedia.test.js`, "full pipeline") drives the real flow the brief describes — user → project → real upload → real ffprobe/ffmpeg processing → `getProjectAssetsMap`/`resolveProjectAsset` → confirms the resolver's metadata matches what the HTTP API reports for the same asset, and that `sourcePath` for both `render` and `preview` purposes points at a file that actually exists on disk.

No test in any Sprint 3 file mocks or fakes anything under `app/` — all of it runs against the real Postgres database, the real filesystem, and (for the integration test) the real `ffmpeg`/`ffprobe` binaries.

## 8. Cross-member dependencies

**Member 1 must provide (not yet available, per section 0):**
- Real `users` and `projects` tables, and real `authenticateToken` middleware that sets `req.user.id` from a verified session/token.
- Once available: point `ownership.service.js`'s query at the real `projects` table (one file), run the FK-cutover migration already documented in `003_media_assets_project_fk.sql`, and swap `devAuthRequired` for the real auth middleware in `media.routes.js`/`projectMedia.routes.js`/`dev.routes.js`'s replacement. `requireProjectAccess.js` needs no change either way (see its own doc comment).
- Their project-deletion flow must call `deleteAllMediaForProject(projectId)` (Sprint 2, re-verified this sprint) *before* deleting the project row — this remains the only way project media cleanup happens; Member 1 should not implement their own filesystem cleanup.

**Member 3A can consume:**
- `resolveProjectAsset(projectId, assetId, { userId, purpose })` and `getProjectAssetsMap(projectId, userId, { purpose })` from `app/services/mediaResolver.service.js`, exactly as documented in section 3 — no database or storage access needed.

**Member 3B should consume:**
- Nothing from Member 2 directly today (no export/render-queue code exists yet on any branch — see section 0). When their worker needs to read source media for muxing/output, the expectation is the same resolver contract Member 3A uses (almost certainly `purpose: 'render'`), never direct filesystem or database access to `media_assets`. Member 2's storage stays strictly `storage/originals` / `storage/proxies` / `storage/thumbnails` / `storage/waveforms`-shaped; nothing here writes to or assumes an `exports/` tree, which remains exclusively Member 3B's.

## 9. Remaining work for Member 2

- **FK cutover** (`media_assets.project_id -> projects.id`) and **auth middleware swap**, both blocked entirely on Member 1's real system landing — scoped to a single migration and a small set of `require()` swaps, both already documented (section 5, section 8).
- **Deletion of the dev-auth/dev-projects scaffolding** (`app/middleware/devAuth.js`, `app/routes/dev.routes.js`, `app/controllers/dev.controller.js`, migration `001`'s tables) once Member 1's real system replaces it — unchanged guidance from Sprint 1/2, still pending on the same external dependency.
- No other Member 2 work is outstanding for Sprint 3. The resolver contract, isolation guarantees, physical-file verification, and cleanup integration are all implemented and tested against the current, real state of the repository.
