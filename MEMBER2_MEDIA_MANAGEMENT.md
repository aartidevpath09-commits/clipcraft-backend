# Member 2 — Media Storage & Asset Processing

Implementation report for the `feature/media-management` branch. Stack: Node.js, Express 5, PostgreSQL via `pg` (no ORM), plain JavaScript (CommonJS) — matching the rest of `clipcraft-backend`. No Next.js, TypeScript, Drizzle, or second backend was introduced.

**This document covers Sprint 1 (upload, storage, processing, streaming API) as originally shipped.** Sprint 2 (project/user ownership enforcement, the `media_assets -> projects` foreign key, the project media-bin endpoint, the project-deletion cleanup contract, and the Member 3A integration contract) is covered in **[`MEMBER2_SPRINT2.md`](./MEMBER2_SPRINT2.md)**, which supersedes a few of this document's now-outdated statements (notably section C's "no foreign key" rationale, and the route table in section E — see the Sprint 2 doc for the current, accurate state). This file is kept as-is below for historical/audit purposes rather than silently rewritten.

This module owns: media upload, multi-layer validation, storage, ffprobe metadata extraction, FFmpeg proxy/thumbnail generation, waveform generation, and the streaming/CRUD API. It does **not** implement auth, project CRUD, timeline, export/rendering, or the render queue — those remain Member 1 / 3A / 3B's scope. A small, clearly isolated dev-only auth placeholder stands in for Member 1's not-yet-available auth (see section B and J).

## A. Files created

```
app/config/media.js                          env-driven config (storage root, size limits, ffmpeg/ffprobe paths)

app/db/migrate.js                             minimal hand-rolled SQL migration runner
app/db/migrations/001_dev_placeholder_auth.sql  TEMPORARY dev_users / dev_projects tables
app/db/migrations/002_media_assets.sql        media_assets table (the real, permanent schema)
app/db/mediaAssets.repository.js              all media_assets SQL lives here

app/services/storage.service.js               local filesystem storage abstraction (swappable for S3)
app/services/validation.service.js            extension + MIME + magic-byte + size validation
app/services/uploadParser.service.js          streaming multipart parser (busboy + HeaderSniffer)
app/services/ownership.service.js             project-ownership check (talks to dev_projects for now)
app/services/ffprobe.service.js               ffprobe wrapper -> normalized metadata
app/services/ffmpeg.service.js                proxy + thumbnail generation
app/services/waveform.service.js              waveform peak-JSON generation
app/services/processing.service.js            per-asset processing lifecycle orchestration
app/services/processingQueue.service.js       fire-and-forget job seam (swappable for a real queue)
app/services/mediaResolver.service.js         integration contract for Member 3A (Video Engine)

app/middleware/devAuth.js                     ISOLATED dev/test-only auth (temporary, see section J)
app/middleware/errorHandler.js                central error handler + 404 handler (no stack/path leaks)

app/controllers/dev.controller.js             dev-only login/project endpoints
app/controllers/media.controller.js           media API request handlers

app/routes/dev.routes.js                      mounted at /api/v1/dev
app/routes/media.routes.js                    mounted at /api/v1/media

app/utils/headerSniffer.js                    Transform stream: magic-byte peek before any disk write
app/utils/apiError.js                         typed ApiError used by every deliberate rejection
app/utils/rangeStream.js                      generic HTTP Range file streaming (fs.createReadStream only)
app/utils/isUuid.js                           input validation guard for :id / projectId params

storage/.gitkeep                              (storage/ itself was already in .gitignore)

tests/helpers/testEnv.js                      isolates test storage root from dev storage/
tests/helpers/fixtures.js                     generates real media fixtures via ffmpeg (no binaries committed)
tests/validation.test.js
tests/headerSniffer.test.js
tests/storage.test.js
tests/ffprobe.test.js
tests/ffmpeg.test.js
tests/waveform.test.js
tests/api.test.js                             full HTTP integration suite

MEMBER2_MEDIA_MANAGEMENT.md                   this report
```

## B. Files modified, and why

- **`app/server.js`** — added two `require`s (dev routes, media routes, error handler), two `app.use()` mounts (`/api/v1/dev`, `/api/v1/media`), the error-handling middleware pair at the bottom, and wrapped `app.listen()` in `if (require.main === module)` so the test suite can `require("../app/server")` and attach it to its own ephemeral port without a second process fighting over `PORT`. Every existing line, and the existing `/` and `/api/v1/health` behavior, is unchanged. Diff is additive only — clearly commented with `// --- Media Management (Member 2) ---` boundaries.
- **`package.json`** — added one dependency (`busboy`, see section D) and two scripts (`migrate`, `test`). Nothing else touched.
- **`package-lock.json`** — regenerated by `npm install busboy`; no other dependency versions changed.

**Not touched:** `app/config/db.js` (reused as-is), `.gitignore` (already had `storage/*` / `!storage/.gitkeep`, no change needed), `README.MD`.

## C. Database changes

Two migrations, applied via `npm run migrate` (or `node app/db/migrate.js`). No ORM — plain SQL, tracked in a `schema_migrations` table so re-running is a no-op for already-applied files.

**`media_assets`** (permanent, owned by this module) — id (uuid pk), `project_id` / `uploaded_by` (plain indexed UUID columns, **no FK** — see rationale below), original file identity (filename, media_type, mime_type, extension, file_size_bytes, storage_key), overall `status` (`UPLOADING → PROCESSING → READY/FAILED`), ffprobe-derived metadata (duration, width, height, fps, codecs, container, bitrate, sample rate, channels, has_audio), and three independent derived-asset status/key/error triples for `proxy_*`, `thumbnail_*`, `waveform_*` (each `NOT_APPLICABLE | PENDING | PROCESSING | READY | FAILED`). Status columns use `TEXT` + `CHECK` constraints, not Postgres ENUMs, so adding a new status value later is a constraint change, not a type migration.

**`dev_users` / `dev_projects`** — **temporary, isolated placeholder tables**, not part of the permanent schema. See section J for why they exist and how to remove them.

**Why no foreign key from `media_assets` to projects/users:** Member 1's real `projects`/`users` tables don't exist on this branch yet. Adding an FK now would either point at the temporary `dev_projects` table (coupling the permanent schema to throwaway scaffolding) or block this migration outright. `project_id`/`uploaded_by` are plain indexed UUID columns; ownership is enforced at the application layer (`ownership.service.js`), so `media_assets` has zero hard dependency on how/when auth and projects land. **Once Member 1's real `projects` table exists, add `REFERENCES projects(id)` in a follow-up migration** — no other change to this schema is needed.

## D. Dependencies added, and why

- **`busboy` (^1.6.0)** — the only new runtime dependency. Streaming multipart parser: never buffers a full upload in memory, which is required to magic-byte-sniff and validate a file before any bytes reach disk, and to support large video uploads without blowing up memory. Checked first against what was already available (`express.json()` doesn't parse multipart at all; the existing dependency list had nothing multipart-capable) before adding it.
- No new dev dependency. Tests use Node's built-in `node:test` + `node:assert` — no Jest/Mocha/supertest added, to keep the dependency footprint minimal.
- `argon2`, `cors`, `dotenv`, `express`, `jsonwebtoken`, `pg`, `nodemon` were already present and are reused as-is (`jsonwebtoken` powers the isolated dev-auth tokens; `pg` powers every query in this module).

## E. API surface

All routes below require `Authorization: Bearer <token>` (see section J for how to get one in dev). Routed at `/api/v1/...` to match the existing `/api/v1/health` convention already in `app/server.js`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/media/upload` | `multipart/form-data`. **Fields must be sent in this order:** `projectId` (text) then `file`. Ownership is checked before any file bytes are read. |
| GET | `/api/v1/media?projectId=...` | list assets for a project |
| GET | `/api/v1/media/:id` | one asset's metadata + processing status |
| GET | `/api/v1/media/:id/stream` | HTTP Range-capable playback; serves the proxy when ready, else the original (`?variant=original` forces the original) |
| GET | `/api/v1/media/:id/thumbnail` | JPEG thumbnail |
| GET | `/api/v1/media/:id/waveform` | waveform peaks JSON |
| DELETE | `/api/v1/media/:id` | deletes the DB row and every file (original + all derived) |

Dev-only (see section J): `POST /api/v1/dev/login`, `POST /api/v1/dev/projects`, `GET /api/v1/dev/projects`.

Every response is JSON `{ error: "CODE", message: "..." }` on failure; ownership failures are 404 for a nonexistent asset/project and 403 for one that exists but isn't yours (never leaks whether a resource exists to someone who shouldn't see it beyond that boundary). No response ever includes a stack trace or filesystem path — verified by an automated test.

## F. FFmpeg / ffprobe requirements

Both binaries must be on `PATH` (or pointed to via `FFPROBE_PATH` / `FFMPEG_PATH`, see section below). Supported formats, all verified against real ffmpeg-generated files in the test suite:

- **Video:** MP4, MOV, WebM, MKV
- **Image:** JPEG, PNG, WebP
- **Audio:** MP3, WAV, AAC/M4A, OGG

Every invocation uses `child_process.execFile`/`spawn` with an argument array — never a shell — so filenames can never be shell-interpolated. ffprobe extracts duration/width/height/fps (parsed from `num/den` rationals)/codecs/container/bitrate/sample rate/channels/has-audio. FFmpeg generates: a browser-friendly H.264/AAC MP4 proxy (capped at 1280px, `+faststart`) for video; a JPEG thumbnail (capped at 320px) for video and image; and a waveform peaks JSON (via raw PCM decode, downsampled in Node) for audio and video-with-audio. Every failure mode (missing binary, corrupt file, timeout, no audio track) is caught and recorded with a short, generic message — never raw stderr.

## G. Storage layout & lifecycle

Local filesystem, rooted at `MEDIA_STORAGE_ROOT` (defaults to `<repo>/storage/`, matching the existing `.gitignore` entry). Layout, all paths stored in the DB as storage keys (never absolute paths):

```
storage/<assetId>/original.<ext>
storage/<assetId>/proxy.mp4        (video only)
storage/<assetId>/thumbnail.jpg    (video + image)
storage/<assetId>/waveform.json    (audio + video-with-audio)
```

Everything for one asset lives under one directory, so `DELETE /api/v1/media/:id` is a single recursive directory removal plus the DB row — verified by an automated test that every derived file is actually gone afterward. All reads/writes go through `storage.service.js`, which resolves storage keys to absolute paths with hard path-traversal protection (rejects any resolved path escaping the storage root) and never uses `fs.readFile()` for streaming — always `fs.createReadStream`/`fs.createWriteStream`. This file is the **only** place that maps a storage key to a filesystem path, so moving to S3-compatible storage later means replacing this one file; every other module only ever deals with storage keys and streams.

## H. Processing lifecycle

Triggered asynchronously right after upload (via `processingQueue.service.js`'s `enqueue()`, currently `setImmediate` — structured as a single seam so swapping in a real queue/worker later touches one file) — **the upload request never blocks on ffprobe/ffmpeg work**.

Overall `status`: `UPLOADING → PROCESSING → READY | FAILED`. `READY` means the original file + its ffprobe metadata are available and streamable — it does **not** wait for derived assets to finish, because those have their own independent status columns (`proxy_status`, `thumbnail_status`, `waveform_status`, each `NOT_APPLICABLE | PENDING → PROCESSING → READY | FAILED`) and one derived asset failing never fails the others or the overall asset. Applicability is media-type-driven: proxy only for video; thumbnail for video + image; waveform for audio, or video only if ffprobe reports an audio track.

## I. Testing instructions

```
npm install
npm run migrate     # applies both migrations (idempotent)
npm test             # node --test — runs the whole suite in tests/
```

Requires a reachable PostgreSQL (same `.env` / `DB_*` vars as the app) and `ffmpeg`/`ffprobe` on PATH — both already required by the app itself, so no new environment dependency. Tests generate their own small real media files via ffmpeg into a temp directory (no binary fixtures committed to the repo) and use an isolated `MEDIA_STORAGE_ROOT` temp directory (`tests/helpers/testEnv.js`), so they never touch the developer's real `storage/` folder. Every media_assets row a test creates is deleted by that test; `dev_users`/`dev_projects` rows accumulate harmlessly across runs (they're throwaway placeholder data — see section J) and can be cleared any time with `TRUNCATE dev_users, dev_projects CASCADE;`. No test requires any secret — `DEV_AUTH_JWT_SECRET` has a dev-only default (a startup warning is logged if it's unset).

46 tests, all passing at time of writing: multi-format validation (all 11 supported formats against real files + 5 negative/spoof cases), HeaderSniffer stream correctness, storage path-traversal + size-limit enforcement, ffprobe extraction + failure paths, ffmpeg proxy/thumbnail generation + failure/cleanup paths, waveform generation + failure paths, and a full HTTP integration suite (upload → processing → range-streamed playback → thumbnail → waveform → delete, plus ownership 403/404, field-order rejection, spoofed-content rejection, and an explicit check that no error response leaks a stack trace or filesystem path).

## J. Integration dependencies for other members

**For Member 3A (Video Engine):** use `app/services/mediaResolver.service.js`'s `resolveAsset(mediaAssetId)` — the sole intended integration point. It returns absolute `originalPath`/`proxyPath`/`thumbnailPath`/`waveformPath` (each `null` until that derived asset is `READY`) plus all ffprobe metadata. It is the only thing outside this module that should need to know a media asset maps to files on disk; nothing about storage keys, the storage root, or S3-vs-local should leak past it.

**For Member 1 (Auth & Projects):** this branch currently ships an **isolated, temporary** dev-auth mechanism so media ownership checks have something to check against: `app/middleware/devAuth.js` (JWT-signed with its own `DEV_AUTH_JWT_SECRET`, never a production secret) plus `app/routes/dev.routes.js` / `app/controllers/dev.controller.js` (`POST /api/v1/dev/login`, `POST|GET /api/v1/dev/projects`) backed by the `dev_users`/`dev_projects` tables (migration `001`). **None of this is meant to survive Member 1's real auth landing.** To cut over: replace `devAuthRequired` in `app/routes/media.routes.js` with the real auth middleware (it only needs to set `req.devUser = { id }` — rename freely), point `app/services/ownership.service.js`'s query at the real `projects` table, add the FK noted in section C, and delete `app/middleware/devAuth.js`, `app/routes/dev.routes.js`, `app/controllers/dev.controller.js`, and migration `001_dev_placeholder_auth.sql`'s tables.

**For Member 3B (Render Queue):** not touched, not depended on. `processingQueue.service.js`'s `enqueue()` seam is the natural place to plug in a real queue later if derived-asset generation should move off this process, but nothing here assumes that will happen or blocks 3B's work.

## K. Known limitations (deliberate Sprint 1 scope)

- No real background worker/queue — `enqueue()` is in-process `setImmediate`, structured to be swappable but not swapped.
- No cloud/object storage — local filesystem only, behind an abstraction designed for a later S3 swap.
- Waveform analysis is capped at ~250MB of decoded PCM per file (a safety guard, not a real-world limit for the audio/video lengths this editor targets).
- `dev_users`/`dev_projects` are throwaway scaffolding (section J) — do not build anything else on top of them.
- No rate limiting / upload quotas beyond the per-category size caps.
- MOV magic-byte detection accepts a small set of legacy non-`ftyp` box headers in addition to `ftyp`; this covers real-world QuickTime output (verified against ffmpeg-generated files) but is not an exhaustive MOV-variant sniffer.

## Final checklist against the brief's critical rules

- [x] No Next.js / TypeScript / Drizzle / Prisma / second backend introduced — plain JS/Express/pg throughout.
- [x] No git operations performed (no add/commit/push/branch/checkout) — every file was written directly to the working tree via the file bridge; git workflow left entirely to the user.
- [x] No secrets or `.env` committed or shipped — `.env` was created only in the sandbox working copy and was never sent to the repo.
- [x] No stack traces or filesystem paths in any API response — enforced by `errorHandler.js` and covered by an automated test.
- [x] Streaming never uses `fs.readFile()` — `rangeStream.js` uses `fs.createReadStream` exclusively, range-aware.
- [x] Dev/test auth is isolated (own file, own routes, own DB tables, own JWT secret, loudly marked temporary) and not woven into permanent media logic.
- [x] Only Member 2's scope was implemented — no auth, project CRUD, timeline, export, or render-queue logic.
- [x] Existing repository structure and conventions were inspected before any change; shared-file edits (`server.js`, `package.json`) are minimal and documented inline.
- [x] Expensive ffprobe/ffmpeg work is triggered asynchronously and never blocks a request handler.
- [x] Dependency footprint controlled — one new runtime dependency (`busboy`), checked against the existing ecosystem first; zero new test-framework dependency.
