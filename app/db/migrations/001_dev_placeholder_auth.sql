-- 001_dev_placeholder_auth.sql
--
-- ============================================================================
-- TEMPORARY / DEVELOPMENT-ONLY SCAFFOLDING -- NOT PART OF THE PERMANENT SCHEMA
-- ============================================================================
-- Member 1 (Core API, Authentication & Projects/Timeline) owns the real
-- `users` / `projects` tables and real auth. Those do not exist yet in this
-- branch, but Media Management (Member 2) needs *some* concept of "a user"
-- and "a project that user owns" to enforce ownership checks on media
-- uploads/downloads while Sprint 1 is being built in parallel.
--
-- `dev_users` and `dev_projects` below exist ONLY to unblock local
-- development and testing of the media pipeline. They are:
--   - prefixed with `dev_` so they can never be mistaken for the real tables
--   - deliberately NOT referenced by any foreign key from `media_assets`
--     (see 002_media_assets.sql) -- media_assets.project_id / uploaded_by
--     are plain indexed UUID columns with no DB-level FK constraint, so
--     swapping this placeholder out for Member 1's real tables later
--     requires zero changes to the media schema.
--   - intended to be dropped entirely (this file's tables only) once
--     Member 1's real users/projects tables and auth middleware land.
--
-- Do NOT build on top of these tables outside the isolated dev-auth
-- middleware (see app/middleware/devAuth.js) and the /api/v1/dev/* routes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS dev_users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dev_projects (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES dev_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dev_projects_owner_id ON dev_projects(owner_id);
