-- 003_media_assets_project_fk.sql
--
-- Sprint 2: formalize the media_assets -> project relationship with a real
-- foreign key, per the Sprint 2 brief's explicit request for "a proper
-- foreign key where compatible with the existing schema."
--
-- IMPORTANT / PROVISIONAL: Member 1's real `projects` table does not exist
-- on this branch yet (verified by inspection before writing this
-- migration). The only project-like table currently available is the
-- temporary `dev_projects` placeholder from 001_dev_placeholder_auth.sql,
-- so that is what this FK points at for now -- it is the "existing schema"
-- this constraint is compatible with. This is intentionally NOT a
-- statement that dev_projects is permanent; see the note in
-- 001_dev_placeholder_auth.sql.
--
-- CUTOVER TO THE REAL projects TABLE (once Member 1 ships it): assuming
-- `projects.id` is UUID (matching dev_projects.id), the swap is a single
-- follow-up migration:
--   ALTER TABLE media_assets DROP CONSTRAINT fk_media_assets_project;
--   ALTER TABLE media_assets ADD CONSTRAINT fk_media_assets_project
--     FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
-- No other change to media_assets is needed.
--
-- Defensive cleanup first: remove any media_assets rows whose project_id
-- doesn't match a real dev_projects row (e.g. leftover rows from earlier
-- ad-hoc testing before this constraint existed) so the ALTER TABLE below
-- can never fail on pre-existing data.
DELETE FROM media_assets
WHERE project_id NOT IN (SELECT id FROM dev_projects);

ALTER TABLE media_assets
  ADD CONSTRAINT fk_media_assets_project
  FOREIGN KEY (project_id) REFERENCES dev_projects(id) ON DELETE CASCADE;

-- Note on ON DELETE CASCADE: this is a DB-level safety net so a deleted
-- project can never leave orphaned media_assets ROWS behind, even if an
-- application bug skips cleanup. It does NOT delete the underlying storage
-- files (Postgres cannot touch the filesystem) -- that is why
-- app/services/projectMediaCleanup.service.js's deleteAllMediaForProject()
-- exists and must be called by the project-deletion flow BEFORE the
-- project row is deleted. See MEMBER2_SPRINT2.md for the full contract.

-- Sprint 2 also asks to prefer a normalized relationship over duplicating
-- ownership data rather than "blindly" adding both project_id and a
-- separate user_id. media_assets.uploaded_by (added in Sprint 1) is kept
-- as-is: in a *collaborative* project (multiple users can belong to one
-- project), "who uploaded this specific asset" is not the same fact as
-- "who owns the project" -- it is legitimate audit metadata, not a
-- duplicate authorization boundary. It remains NOT used for authorization
-- decisions: every ownership check in this codebase goes through
-- media_assets.project_id -> dev_projects.owner_id (see
-- app/services/ownership.service.js), never through uploaded_by.

-- Replace the single-column project_id index with a composite index that
-- also covers the listing endpoints' ORDER BY created_at DESC -- Postgres
-- can still use the leading column alone for plain project_id lookups, so
-- the old single-column index becomes redundant.
DROP INDEX IF EXISTS idx_media_assets_project_id;
CREATE INDEX idx_media_assets_project_created
  ON media_assets(project_id, created_at DESC);
