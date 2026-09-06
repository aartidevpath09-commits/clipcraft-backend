# Member 2 — Media Storage, Asset Processing & Project Integration

**Final report — Sprints 1–3, plus the post-review hardening pass.**

Owner: Member 2 (Media Storage, Asset Processing, Project Integration & Final Resolver Contract)
Stack: Node.js, Express 5, PostgreSQL via `pg` (no ORM), plain JavaScript (CommonJS) — matching the rest of `clipcraft-backend`. No Next.js, TypeScript, Drizzle, or second backend was introduced at any point.

This document supersedes `MEMBER2_SPRINT2.md`, `MEMBER2_SPRINT3.md`, `MEMBER2_TEAM_REPORT_SPRINT1-2.md`, and `MEMBER2_TEAM_REPORT_SPRINT1-3.md` — all folded into this single file describing the final, current state of the module, plus the full history of how it got there. Those files are being removed; nothing in them is lost, it's consolidated here.

This module owns: media upload, multi-layer validation, storage, ffprobe metadata extraction, FFmpeg proxy/thumbnail generation, waveform generation, the streaming/CRUD API, project/user ownership enforcement on every media-touching endpoint, and the integration contracts other members build against. It does **not** implement auth, project CRUD, timeline, export/rendering, or the render queue — that remains Member 1 / 3A / 3B's scope. A small, clearly isolated dev-only auth placeholder stands in for Member 1's not-yet-available auth.

---

## TL;DR

Media Management is complete, integration-ready, and has been through a full code-review hardening pass. The backend takes a video/image/audio upload, validates it against real file bytes (not just its claimed type), extracts technical metadata, generates a proxy/thumbnail/waveform in the background, streams it back with Range support, and deletes it cleanly — and every one of those operations is locked to "does this user own the project this media belongs to," with no cross-user or cross-project leakage. On top of that, there's a single stable contract other members build against without touching this module's database or filesystem: one function to resolve one asset, one to resolve a whole project's media at once, both purpose-aware (render vs. preview), both guaranteeing the file handed back actually exists on disk.

A subsequent code review (`Member_2_Media_Management_Code_Review_Report.docx`, status "Changes Required Before Merge") flagged eight items — a real race condition, an unsafe deletion path, a validation gap, a memory-growth risk, a test-hygiene issue, and a documentation gap; one flagged item turned out to be a false alarm on inspection. All are now resolved (see "Code review response" below). The authenticated-user shape was also standardized team-wide to `req.user.userId` during this pass.

**82 automated tests pass, 0 failing**, all against a real PostgreSQL database and real `ffmpeg`/`ffprobe` binaries — no mocks anywhere in the suite.

Nothing outside Member 2's scope was touched at any point: no auth system, no project CRUD, no timeline processing, no render/export pipeline, no job queue.

---

## 1. File manifest (final state)

```
app/config/db.js                              existing, reused as-is
app/config/media.js                           env-driven config (storage root, size limits, ffmpeg/ffprobe paths, concurrency)

app/db/migrate.js                             minimal hand-rolled SQL migration runner
app/db/migrations/001_dev_placeholder_auth.sql  TEMPORARY dev_users / dev_projects tables
app/db/migrations/002_media_assets.sql        media_assets table (the real, permanent schema)
app/db/migrations/003_media_assets_project_fk.sql  real FK: media_assets.project_id -> dev_projects.id
app/db/mediaAssets.repository.js              all media_assets SQL

app/services/storage.service.js               local filesystem storage abstraction (swappable for S3)
app/services/validation.service.js            extension + MIME + magic-byte + size validation
app/services/uploadParser.service.js          streaming multipart parser (busboy + HeaderSniffer)
app/services/ownership.service.js             project-ownership check (talks to dev_projects for now)
app/services/ffprobe.service.js               ffprobe wrapper -> normalized metadata
app/services/ffmpeg.service.js                proxy + thumbnail generation
app/services/waveform.service.js              streaming waveform peak-JSON generation
app/services/processing.service.js            per-asset processing lifecycle orchestration, race-safe
app/services/processingQueue.service.js       bounded-concurrency job queue (swappable for a real queue)
app/services/mediaResolver.service.js         final integration contract for Member 3A (Video Engine)
app/services/projectMediaCleanup.service.js   project-deletion cleanup contract for Member 1

app/middleware/devAuth.js                     ISOLATED dev/test-only auth (temporary, see section 9)
app/middleware/requireProjectAccess.js        authorization seam matching Member 1's expected flow
app/middleware/errorHandler.js                central error handler + 404 handler (no stack/path leaks)

app/controllers/dev.controller.js             dev-only login/project endpoints (incl. deleteProject scaffolding)
app/controllers/media.controller.js           media API request handlers

app/routes/dev.routes.js                      mounted at /api/v1/dev
app/routes/media.routes.js                    mounted at /api/v1/media
app/routes/projectMedia.routes.js             GET /:projectId/media, mounted at /api/v1/projects

app/utils/headerSniffer.js                    Transform stream: magic-byte peek before any disk write
app/utils/apiError.js                         typed ApiError used by every deliberate rejection
app/utils/rangeStream.js                      generic HTTP Range file streaming (fs.createReadStream only)
app/utils/isUuid.js                           input validation guard for :id / projectId params, and for
                                               deleteAssetDirectory's own internal safety check

storage/.gitkeep                              (storage/ itself is in .gitignore)

tests/helpers/testEnv.js                      isolates test storage root from dev storage/
tests/helpers/fixtures.js                     generates real media fixtures via ffmpeg (no binaries committed)
tests/validation.test.js
tests/headerSniffer.test.js
tests/storage.test.js
tests/ffprobe.test.js
tests/ffmpeg.test.js
tests/waveform.test.js
tests/mediaResolver.test.js
tests/projectMedia.test.js
tests/api.test.js                             full HTTP integration suite

MEMBER2_MEDIA_MANAGEMENT.md                   this report (final, consolidated)
```

**Shared files modified, and why:** `app/server.js` (dev routes, media routes, project-media routes, error handler — all additive, wrapped `app.listen()` in `if (require.main === module)` so tests can attach the app to their own ephemeral port); `package.json` (one dependency, `busboy`; `migrate`/`test` scripts). Nothing else in either file was touched. `app/config/db.js` and `README.MD` were never touched.

---

## 2. Database schema (final)

Three migrations, applied via `npm run migrate` (idempotent — a `schema_migrations` table skips already-applied files).

**`media_assets`** (permanent, owned by this module): `id` (uuid pk), `project_id` (FK, see below) / `uploaded_by` (plain indexed UUID, non-authoritative audit metadata only — never consulted by any authorization check), original file identity (filename, media_type, mime_type, extension, file_size_bytes, storage_key), overall `status` (`UPLOADING → PROCESSING → READY/FAILED`), ffprobe-derived metadata (duration, width, height, fps, codecs, container, bitrate, sample rate, channels, has_audio), and three independent derived-asset status/key/error triples for `proxy_*`, `thumbnail_*`, `waveform_*` (each `NOT_APPLICABLE | PENDING | PROCESSING | READY | FAILED`). Status columns are `TEXT` + `CHECK` constraints, not Postgres ENUMs.

**Foreign key:** `media_assets.project_id REFERENCES dev_projects(id) ON DELETE CASCADE`. This is provisional and documented as such in migration `003` — Member 1's real `projects` table doesn't exist on this branch yet. The cutover once it does is a single follow-up migration (drop this constraint, add the same constraint pointing at `projects(id)`) — no other change to `media_assets` is needed.

**`user_id`: deliberately not added as its own column.** `media_assets.project_id -> dev_projects.owner_id` already gives an unambiguous ownership path (User → Project → Media Assets is a project-level ownership fact, not a per-asset one); duplicating it onto every row would create a second source of truth that could drift.

**Indexing:** `idx_media_assets_project_created (project_id, created_at DESC)` — serves plain `project_id` lookups and backs every listing endpoint's `ORDER BY created_at DESC` in a single indexed scan. `idx_media_assets_uploaded_by (uploaded_by)` also exists. A composite `(project_id, uploaded_by)` index was considered and not added — nothing queries by both together.

**`dev_users` / `dev_projects`** — temporary, isolated placeholder tables, not part of the permanent schema. See section 9 for removal instructions.

---

## 3. Dependencies

- **`busboy` (^1.6.0)** — the only new runtime dependency across all sprints. Streaming multipart parser: never buffers a full upload in memory, required to magic-byte-sniff and validate a file before any bytes reach disk.
- No new dev dependency at any point. Tests use Node's built-in `node:test` + `node:assert`.
- `argon2`, `cors`, `dotenv`, `express`, `jsonwebtoken`, `pg`, `nodemon` were already present and reused as-is.

---

## 4. API surface (final)

All routes require `Authorization: Bearer <token>` (see section 9 for how to get one in dev).

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/media/upload` | `multipart/form-data`. Fields must be sent `projectId` (text) then `file`. Ownership checked before any file bytes are read. |
| GET | `/api/v1/media?projectId=...` | list assets for a project (query-param form) |
| GET | `/api/v1/projects/:projectId/media` | list assets for a project (path-param form, the project's "media bin") — same response shape, shares one internal helper with the form above so there's exactly one implementation of "verify ownership, then fetch" |
| GET | `/api/v1/media/:id` | one asset's metadata + processing status |
| GET | `/api/v1/media/:id/stream` | HTTP Range-capable playback; serves the proxy when ready, else the original (`?variant=original` forces the original) |
| GET | `/api/v1/media/:id/proxy` | direct, ownership-checked access to the proxy file |
| GET | `/api/v1/media/:id/thumbnail` | JPEG thumbnail |
| GET | `/api/v1/media/:id/waveform` | waveform peaks JSON |
| DELETE | `/api/v1/media/:id` | deletes the DB row and every file (original + all derived) |

Dev-only (section 9): `POST /api/v1/dev/login`, `POST|GET /api/v1/dev/projects`, `DELETE /api/v1/dev/projects/:id` (scaffolding exercising the Member 1 cleanup contract, not real project CRUD).

Every response is JSON `{ error: "CODE", message: "..." }` on failure; ownership failures are 404 for a nonexistent asset/project and 403 for one that exists but isn't yours. No response ever includes a stack trace or filesystem path — covered by an automated test.

`projectMedia.routes.js` deliberately defines *only* `GET /:projectId/media` under the `/api/v1/projects` prefix, leaving the rest of that prefix free for Member 1's project CRUD router with no path collision.

---

## 5. FFmpeg / ffprobe requirements

Both binaries must be on `PATH` (or via `FFPROBE_PATH` / `FFMPEG_PATH`). Supported formats, verified against real ffmpeg-generated files in the test suite:

- **Video:** MP4, MOV, WebM, MKV
- **Image:** JPEG, PNG, WebP
- **Audio:** MP3, WAV, AAC (raw ADTS) and M4A (ISO-BMFF container) as two independently validated formats, OGG

Every invocation uses `child_process.execFile`/`spawn` with an argument array — never a shell. ffprobe extracts duration/width/height/fps/codecs/container/bitrate/sample rate/channels/has-audio. FFmpeg generates a browser-friendly H.264/AAC MP4 proxy (capped at 1280px, `+faststart`) for video, a JPEG thumbnail (capped at 320px) for video and image, and (via `waveform.service.js`) a waveform peaks JSON for audio and video-with-audio. Every failure mode (missing binary, corrupt file, timeout, no audio track) is caught and recorded with a short, generic message — never raw stderr.

`ffmpeg.service.js` and `waveform.service.js` both take absolute filesystem paths rather than storage keys — this is a deliberate, permanent design choice, not local-filesystem coupling that needs fixing (see section 8, item 8).

---

## 6. Storage layout & lifecycle

Local filesystem, rooted at `MEDIA_STORAGE_ROOT` (defaults to `<repo>/storage/`). Layout, all paths stored in the DB as storage keys (never absolute paths):

```
storage/<assetId>/original.<ext>
storage/<assetId>/proxy.mp4        (video only)
storage/<assetId>/thumbnail.jpg    (video + image)
storage/<assetId>/waveform.json    (audio + video-with-audio)
```

Everything for one asset lives under one directory, so deleting an asset is a single recursive directory removal — verified by tests that every derived file is actually gone afterward. All reads/writes go through `storage.service.js`, the **only** module that maps a storage key to a filesystem path; every other module deals exclusively in storage keys and streams, so moving to S3-compatible storage later means replacing this one file.

`resolveAbsolutePath()` is `storage.service.js`'s one sanctioned exception to "callers only deal with storage keys and streams": it hands a real, seekable filesystem path to the native ffmpeg/ffprobe processes that need one (there's no stream-based way to give them an arbitrary input/output). It has hard path-traversal protection (rejects any resolved path escaping the storage root), and `deleteAssetDirectory()` additionally requires a genuine UUID before it will touch anything recursively — closing the specific case where `resolveAbsolutePath(".")` legitimately resolves to the storage root itself rather than "escaping" it (see section 8, item 2).

Upload writes (`saveStream()`) wait for the write stream to actually close before cleaning up a partial file on failure, rather than racing an unlink against a still-open handle (section 8, item 6).

---

## 7. Processing lifecycle

Triggered asynchronously right after upload via `processingQueue.service.js`'s `enqueue()` — the upload request never blocks on ffprobe/ffmpeg work. The queue caps how many jobs run concurrently (`MEDIA_PROCESSING_CONCURRENCY`, default 4); jobs beyond the cap wait rather than all starting at once (section 8, item 4).

Overall `status`: `UPLOADING → PROCESSING → READY | FAILED`. `READY` means the original file + ffprobe metadata are available and streamable — it does not wait for derived assets, which have their own independent status columns and never fail each other. Applicability is media-type-driven: proxy only for video; thumbnail for video + image; waveform for audio, or video only if ffprobe reports an audio track.

Each derived-asset job (`processing.service.js`'s `runDerivedJob`) checks the asset still exists before starting, and checks whether its own status update actually affected a database row after finishing; if the asset was deleted mid-job, the orphaned output file is removed rather than left on disk (section 8, item 5).

---

## 8. Code review response (post-Sprint-3 hardening pass)

A code review (`Member_2_Media_Management_Code_Review_Report.docx`, status "Changes Required Before Merge") was received and fully resolved. Each item below was independently verified against the actual code before being fixed — one turned out not to reproduce.

1. **`server.js` calling `app.listen()` twice (EADDRINUSE risk) — false alarm.** Inspection confirmed exactly one `app.listen()` call, guarded by `if (require.main === module)` (present since Sprint 1, for the test suite's benefit). No change needed.
2. **`deleteAssetDirectory()` unsafe `assetId` validation — fixed.** `resolveAbsolutePath(".")` resolves to `STORAGE_ROOT` itself (it doesn't "escape" the root, so the traversal check alone didn't catch it) — meaning an `assetId` of `"."` would previously have deleted the entire storage root. Fixed by requiring `isUuid(assetId)` inside `deleteAssetDirectory` itself, independent of any upstream validation, and covered by a test asserting every unsafe value (`.`, `..`, empty string, a path with separators, a non-UUID string) is rejected.
3. **`.aac` vs `.m4a` validation — fixed.** Raw AAC (an ADTS elementary stream) and M4A (an ISO-BMFF container) were incorrectly grouped under one magic-byte check that only recognized the ISO-BMFF `ftyp` box — meaning no real raw `.aac` file could ever have passed validation. Split into two independent format entries with their own magic-byte detectors; verified against a real ffmpeg-generated ADTS file (`ffmpeg -f adts`) byte-for-byte.
4. **Waveform generation OOM risk — fixed.** The previous implementation accumulated every decoded PCM chunk into memory (capped at 250MB per job) before computing peaks. Rewrote `waveform.service.js` to a genuinely streaming design: a fixed-capacity (4000-bucket) `[min, max]` accumulator folds each PCM chunk in as it arrives and is discarded immediately, with adjacent buckets merged pairwise (halving resolution, doubling the sample span) if the real sample count ever runs past current capacity — so memory stays bounded regardless of file length, including the case where ffprobe couldn't determine a duration up front. Paired with a new concurrency cap on background jobs (`processingQueue.service.js`, `MEDIA_PROCESSING_CONCURRENCY`) so a burst of uploads can't spawn an unbounded number of concurrent ffmpeg processes either.
5. **Upload/processing/delete race condition — fixed.** Deleting a media asset while its background processing job was still running could previously leave orphaned derived files behind (or resurrect a just-deleted asset's directory via `ensureParentDir`'s `mkdir -p`). `runDerivedJob` now checks the asset still exists before starting, and checks whether its completion update actually affected a row; if not (the asset was deleted mid-job), it removes the orphaned output file instead of leaving it. Covered by a test that deletes an asset immediately after upload and confirms no derived files exist once background processing catches up.
6. **Upload stream cleanup race — fixed.** `saveStream()` previously called `unlink` immediately after `destroy()` on a failed upload, racing against the write stream's file handle actually closing (a known-risky pattern on Windows in particular). It now waits for the `close` event (with a 2-second safety-net timeout) before unlinking.
7. **Test rows accumulating in the shared dev database — fixed.** `node --test` runs each test file concurrently as its own process against the same shared development database, which ruled out a blanket `TRUNCATE` at the end of a test file (it could wipe rows a concurrently-running sibling file still needed) — that alternative was tried and deliberately reverted. Each affected test file's `after()` hook now deletes exactly the `dev_users`/`dev_projects` rows it created, scoped by id (`DELETE ... WHERE id = ANY($1::uuid[])`).
8. **Storage abstraction clarity — resolved via documentation, not a new interface.** The question raised was why `ffmpeg.service.js` and `waveform.service.js` take absolute filesystem paths instead of storage keys, given that the whole point of `storage.service.js` is that nothing else touches paths directly. This is intentional: ffmpeg/ffprobe are native processes with no stream-based way to accept an arbitrary input/output — they need a real, seekable file on disk. `storage.service.js`'s header comment and `resolveAbsolutePath()`'s own doc comment, plus matching comments added to `ffmpeg.service.js` and `waveform.service.js`, now explain this explicitly and identify `resolveAbsolutePath()` as the exact seam a future S3-backed implementation would use to stage objects to local temp files — so those two files' signatures are already the right shape for that swap and aren't expected to change when it happens. No new interface was introduced, since the existing shape was already correct; it just wasn't explained.

**Separately, in the same pass:** the team standardized how the authenticated user's id is exposed on the request object, to `req.user.userId` (and `req.devUser.userId`) instead of `.id`. `app/middleware/devAuth.js`, `app/middleware/requireProjectAccess.js`, `app/controllers/dev.controller.js`, `app/controllers/media.controller.js`, and a comment in `app/routes/projectMedia.routes.js` were updated to match — every other `.id` usage in the codebase (unrelated to the authenticated user, e.g. asset/project ids) was left untouched.

---

## 9. Integration dependencies for other members

**For Member 3A (Video Engine):** use `app/services/mediaResolver.service.js` — the sole integration surface. Two entry points, both requiring the caller's authenticated `userId` (never a client-supplied one) and failing closed (never throwing, never guessing) if it's missing:

```js
const { resolveProjectAsset, getProjectAssetsMap } = require("./services/mediaResolver.service");

// One asset:
const result = await resolveProjectAsset(projectId, assetId, { userId, purpose });
// purpose: 'render' (always the original file) | 'preview' (proxy when ready, else original) — default 'preview'
// result.status: FORBIDDEN | NOT_FOUND | WRONG_PROJECT | NOT_READY | SOURCE_MISSING | READY

// A whole project at once:
const map = await getProjectAssetsMap(projectId, userId, { purpose });
// map.status: FORBIDDEN | OK, map.assets: Map<assetId, entry> (same per-entry shape as above)
```

The `READY` payload includes full ffprobe metadata plus `originalPath`/`proxyPath`/`thumbnailPath`/`waveformPath` (each `null` until that derived asset is itself `READY`) and, as of the final contract, `sourceKind` and `sourcePath` — the one path Member 3A's FFmpeg calls should actually use, so it never has to decide between original and proxy itself. `SOURCE_MISSING` is returned (never a silent fallback) if the database says `READY` but the physical file the requested purpose needs isn't actually on disk — a guarantee added specifically so a database/filesystem disagreement is visible rather than masked. These paths are for Member 3A's own in-process FFmpeg calls only and must never be forwarded to a browser/HTTP client — nothing in this codebase's HTTP layer returns them.

**For Member 1 (Auth & Projects):** this branch ships an isolated, temporary dev-auth mechanism (`app/middleware/devAuth.js`, its own JWT secret, backed by `dev_users`/`dev_projects` from migration `001`) so ownership checks have something real to check against. **None of this is meant to survive Member 1's real auth landing.** To cut over: replace `devAuthRequired` with the real auth middleware (it only needs to set `req.user.userId` from verified session/token state — every downstream ownership check already only trusts that field), point `app/services/ownership.service.js`'s query at the real `projects` table, run the FK-cutover migration already documented inline in `003_media_assets_project_fk.sql`, and delete `app/middleware/devAuth.js`, `app/routes/dev.routes.js`, `app/controllers/dev.controller.js`, and migration `001`'s tables. `app/middleware/requireProjectAccess.js` needs no change either way.

Also for Member 1: **call `deleteAllMediaForProject(projectId)` (in `app/services/projectMediaCleanup.service.js`) before deleting a project row**, not after. The FK's `ON DELETE CASCADE` guarantees no orphaned database *rows*, but Postgres can't touch the filesystem — without this call, every original/proxy/thumbnail/waveform file for that project would be left on disk forever with nothing to clean it up. Safe to call on a project with zero media (no-op) and safe to call twice (idempotent).

**For Member 3B (Render Queue):** not touched, not depended on. `processingQueue.service.js`'s `enqueue()` seam is the natural place to plug in a real queue later if derived-asset generation should move off this process, but nothing here assumes that will happen. When 3B's worker needs source media, the expectation is the same resolver contract Member 3A uses (almost certainly `purpose: 'render'`), never direct filesystem or database access to `media_assets`.

---

## 10. Testing

```
npm install
npm run migrate     # applies all three migrations (idempotent)
npm test             # node --test — runs the whole suite in tests/
```

Requires a reachable PostgreSQL (same `.env` / `DB_*` vars as the app) and `ffmpeg`/`ffprobe` on PATH. Tests generate their own small real media files via ffmpeg into a temp directory and use an isolated `MEDIA_STORAGE_ROOT` temp directory, so they never touch the developer's real `storage/` folder. Every `media_assets` row a test creates is deleted by that test; `dev_users`/`dev_projects` rows are now cleaned up per-test-run by id (section 8, item 7) rather than left to accumulate.

**Test count by stage:** Sprint 1 shipped with 46 tests. Sprint 2 added 20 (66 total). Sprint 3 added 10 (76 total). The code-review hardening pass added tests for every fix in section 8 — unsafe-`assetId` rejection, the delete/processing race, ADTS-vs-ISO-BMFF distinction, and the waveform accumulator's unknown-duration growth path, among others.

**Current total: 82 tests, 82 passing, 0 failing, across 10 suites.** No test in the suite mocks or fakes anything under `app/` — every assertion runs against the real Postgres database and, for the HTTP/processing suites, real `ffmpeg`/`ffprobe` binaries.

---

## 11. Known limitations (current, deliberate scope boundaries)

- No real background worker/queue — `enqueue()` is in-process, bounded-concurrency `setImmediate`-based dispatch, structured to be swappable but not swapped.
- No cloud/object storage — local filesystem only, behind an abstraction designed for a later S3 swap (see section 6 and section 8, item 8).
- `dev_users`/`dev_projects` are throwaway scaffolding (section 9) — do not build anything else on top of them.
- No rate limiting / upload quotas beyond the per-category size caps.
- MOV magic-byte detection accepts a small set of legacy non-`ftyp` box headers in addition to `ftyp`; this covers real-world QuickTime output but is not an exhaustive MOV-variant sniffer.
- The FK cutover (`media_assets.project_id -> projects.id`) and the auth middleware swap are both blocked entirely on Member 1's real system landing — both are scoped to a single migration and a small set of `require()` swaps, already documented above.

## Final checklist against the brief's critical rules

- [x] No Next.js / TypeScript / Drizzle / Prisma / second backend introduced — plain JS/Express/pg throughout, all three sprints.
- [x] No git operations performed (no add/commit/push/branch/checkout) — every file was written directly to the working tree via the file bridge; git workflow left entirely to the user.
- [x] No secrets or `.env` committed or shipped.
- [x] No stack traces or filesystem paths in any API response — enforced by `errorHandler.js`, covered by an automated test.
- [x] Streaming never uses `fs.readFile()` — `rangeStream.js` uses `fs.createReadStream` exclusively, range-aware.
- [x] Dev/test auth is isolated (own file, own routes, own DB tables, own JWT secret, loudly marked temporary) and not woven into permanent media logic.
- [x] Only Member 2's scope was implemented across all sprints and the hardening pass — no auth, project CRUD, timeline, export, or render-queue logic.
- [x] Expensive ffprobe/ffmpeg work is triggered asynchronously, bounded by a concurrency cap, and never blocks a request handler.
- [x] Dependency footprint controlled — one new runtime dependency (`busboy`) across the entire project; zero new test-framework dependency.
- [x] Every code-review finding was independently verified against the actual code (not assumed correct or incorrect from its description) before being fixed or dismissed.
