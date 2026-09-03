# ClipCraft Backend — Media Management (Member 2)

**Team status report — Sprint 1, 2 & 3**

Owner: Member 2 (Media Storage, Asset Processing, Project Integration & Final Resolver Contract)
Stack: Node.js + Express 5 + PostgreSQL (`pg`, no ORM) — same as the rest of `clipcraft-backend`

*Supersedes the earlier Sprint 1–2 report with the same name minus "-3" — this version adds Sprint 3.*

---

## TL;DR

Media Management is complete and integration-ready across all three sprints. The backend can take a video/image/audio upload, validate it against real file bytes (not just its claimed type), extract technical metadata, generate a proxy/thumbnail/waveform, stream it back with Range support, and delete it cleanly — and every one of those operations is now locked to "does this user own the project this media belongs to," with no cross-user or cross-project leakage anywhere. On top of that, there's a single stable contract other members can build against without ever touching this module's database or filesystem: one function to resolve one asset, one function to resolve a whole project's media at once, both purpose-aware (render vs. preview), both guaranteeing the file they hand back actually exists on disk. 76 automated tests pass, 0 failing, all against a real database and real ffmpeg — no mocks anywhere in the suite.

Nothing outside Member 2's scope was touched across any sprint: no auth system, no project CRUD, no timeline processing, no render/export pipeline, no job queue.

---

## Sprint 1 — Media Storage & Asset Processing

**Goal:** get media files into the backend safely, process them, and serve them back out.

- **Upload API** — streaming multipart upload that never buffers a full file in memory, with magic-byte sniffing to catch spoofed files (a PNG renamed to `.mp4` gets rejected) before anything touches disk.
- **Formats:** video (MP4, MOV, WebM, MKV), image (JPEG, PNG, WebP), audio (MP3, WAV, AAC/M4A, OGG) — verified against real ffmpeg-generated files in tests.
- **Background processing** — ffprobe metadata extraction, an H.264/AAC 360p proxy, a JPEG thumbnail, and a waveform-peaks JSON, each with its own independent status so one failing (e.g. no audio track) never blocks the others. The upload request itself never waits on any of this.
- **Storage** — local filesystem behind an abstraction built for a later S3 swap; hard path-traversal protection; one directory per asset so deletion is a single recursive removal.
- **Streaming, metadata, thumbnail, waveform, and delete endpoints**, with HTTP Range support for scrubbing/seeking.
- **A temporary, clearly isolated dev-auth mechanism** — since real auth didn't exist yet, built just enough (its own JWT secret, its own DB tables, marked "delete me later") to give ownership checks something real to check against.

**Result:** 46 tests passing.

## Sprint 2 — Project & User Ownership Integration

**Goal:** make media a real part of a project, not a loose pile of files, and lock every operation to project/user ownership.

- **Real foreign key** — `media_assets.project_id` enforced with `ON DELETE CASCADE`, plus a composite index so listing a project's media is one indexed query, not one lookup per asset.
- **Ownership enforced everywhere** — upload, metadata, streaming, thumbnail, waveform, delete, and listing all check that the requester owns the asset's project, using only the server-verified identity.
- **New endpoint:** `GET /api/v1/projects/:projectId/media` — the project's media bin.
- **First version of the Video Engine contract** — a resolver service so Member 3A could get an asset's metadata and file paths without touching the database or storage folder directly.
- **Project-deletion cleanup contract** — a function Member 1's project-deletion flow is meant to call so deleting a project never leaves orphaned files behind (the database FK alone can guarantee no orphaned *rows*, but Postgres can't touch the filesystem).

**Result:** 20 new tests (66 total).

## Sprint 3 — Final Resolver Contract & Integration Hardening

**Goal:** turn the Sprint 2 resolver into the final, stable contract Member 3A can build a whole rendering pipeline on, and get the auth/authorization seam ready for Member 1's real system.

- **Repository inspection first, as instructed** — checked not just the local files but the actual git remote's other team branches (`core-api-auth`, `render-queue`, `video-engine`). All three are still at the same base commit as `main` with nothing pushed. So this sprint's "integrate real auth" work was scoped to *finalizing the seam* for that integration rather than plugging into a system that doesn't exist yet — documented plainly rather than guessed around.
- **Finalized resolver contract** — `resolveProjectAsset(projectId, assetId, { userId, purpose })` and `getProjectAssetsMap(projectId, userId, { purpose })`. `userId` is required and fails closed (never throws, never guesses) if it's missing.
- **Render vs. preview, centralized** — pass `purpose: 'render'` and you always get the original source file; `purpose: 'preview'` gets you the proxy when it's ready, otherwise the original. Member 3A never has to branch on this itself or construct a storage path by hand.
- **A guarantee that was missing before:** the resolver now verifies the actual file exists on disk before ever calling something "ready" — a database row saying `READY` is no longer good enough on its own. If the database and the filesystem disagree (e.g. a proxy file got deleted outside the app), the resolver reports that clearly instead of silently serving the wrong file or letting a broken path reach FFmpeg.
- **Authorization seam finalized** — a new `requireProjectAccess` middleware matches the exact flow Member 1's real auth is expected to plug into (`authenticateToken → req.user.id → requireProjectAccess → req.project`), wired into the project-media-bin route today.
- **New endpoint:** `GET /api/v1/media/:id/proxy` — direct access to the proxy file, closing a gap where the brief expected it but the earlier implementation only exposed proxy selection through the streaming endpoint's auto-selection logic.
- **Isolation re-verified explicitly** — a dedicated test proves the exact three-user matrix: your own asset resolves, another user's project is denied, and someone else's asset in your project id is denied.

**Result:** 10 new tests (76 total). No new database migration was needed — Sprint 1/2's schema already covered everything Sprint 3 needed; the one thing genuinely blocked (a real `user_id → users.id` foreign key) can't exist until Member 1 ships the real `users` table, and that's called out explicitly rather than worked around.

---

## Testing summary

| | Sprint 1 | Sprint 2 | Sprint 3 | Total |
|---|---|---|---|---|
| Automated tests | 46 | +20 | +10 | **76** |
| Status | passing | passing | passing | **0 failing** |

Every test runs against a real PostgreSQL database and real `ffmpeg`/`ffprobe` binaries — no mocks or fakes of the implementation anywhere in the suite, across all three sprints.

---

## What the rest of the team needs to know now

- **Member 1 (Auth & Projects):** the real `users`/`projects` tables and real auth middleware are the one thing still blocking full cutover. When they land: point one file (`ownership.service.js`) at the real `projects` table, run the single follow-up FK migration already written and waiting, and swap the dev-auth middleware for the real one (it only needs to set `req.user.id`). Also: call `deleteAllMediaForProject(projectId)` before deleting a project row — don't reimplement filesystem cleanup on your side.
- **Member 3A (Video Engine):** the contract is final. Use `resolveProjectAsset` / `getProjectAssetsMap` from `mediaResolver.service.js` exactly as documented in `MEMBER2_SPRINT3.md` — pass `purpose: 'render'` when compiling for export, `purpose: 'preview'` for playback. You'll never need SQL or a storage path.
- **Member 3B (Render Queue):** not touched, not depended on, and nothing here assumes anything about how/when your worker exists. When it needs source media, the expectation is it goes through the same resolver contract Member 3A uses.

## Explicitly out of scope (all three sprints)

No authentication system, no project CRUD, no timeline persistence or processing, no render/export compiler, no render queue, no export storage. The dev-only auth/project scaffolding exists solely to make Member 2's own work testable in isolation while real auth doesn't exist yet, and is marked for deletion the moment it does.

---

*Full technical detail — schema, every API contract, file-by-file diffs, and the reasoning behind each design decision — lives in `MEMBER2_MEDIA_MANAGEMENT.md` (Sprint 1), `MEMBER2_SPRINT2.md` (Sprint 2), and `MEMBER2_SPRINT3.md` (Sprint 3) in the repo root.*
