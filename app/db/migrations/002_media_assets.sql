-- 002_media_assets.sql
--
-- Core table owned by Member 2 (Media Storage & Asset Processing).
--
-- No ORM is used in this project, so status-style columns use plain TEXT
-- with a CHECK constraint instead of a Postgres ENUM type -- this keeps them
-- easy to extend later (adding a new status value is an `ALTER TABLE ...
-- DROP/ADD CONSTRAINT`, not a type migration).
--
-- `project_id` and `uploaded_by` are intentionally plain indexed UUID
-- columns with NO foreign key constraint. Member 1's real `projects` /
-- `users` tables do not exist yet on this branch; adding an FK now would
-- either point at the temporary dev_* placeholder tables (see
-- 001_dev_placeholder_auth.sql) or block this migration entirely. Ownership
-- is enforced at the application layer (see app/services/ownership.service.js)
-- so this table has zero hard dependency on how/when auth & projects land.
CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY,

  -- Ownership / integration boundary (see note above: no DB-level FK)
  project_id UUID NOT NULL,
  uploaded_by UUID,

  -- Original upload identity
  original_filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('video', 'image', 'audio')),
  mime_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),

  -- Storage location of the original file (storage-provider-relative key,
  -- never an absolute filesystem path -- see app/services/storage.service.js)
  storage_key TEXT NOT NULL,

  -- Overall processing lifecycle
  status TEXT NOT NULL DEFAULT 'UPLOADING'
    CHECK (status IN ('UPLOADING', 'PROCESSING', 'READY', 'FAILED')),
  error_message TEXT,

  -- ffprobe-derived technical metadata (nullable until PROCESSING completes;
  -- not all fields apply to all media_type values)
  duration_seconds DOUBLE PRECISION,
  width INTEGER,
  height INTEGER,
  fps DOUBLE PRECISION,
  video_codec TEXT,
  audio_codec TEXT,
  container_format TEXT,
  bitrate_bps BIGINT,
  sample_rate_hz INTEGER,
  channels INTEGER,
  has_audio BOOLEAN,

  -- Derived asset: browser-friendly proxy (video only)
  proxy_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
    CHECK (proxy_status IN ('NOT_APPLICABLE', 'PENDING', 'PROCESSING', 'READY', 'FAILED')),
  proxy_storage_key TEXT,
  proxy_error_message TEXT,

  -- Derived asset: thumbnail (video + image)
  thumbnail_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
    CHECK (thumbnail_status IN ('NOT_APPLICABLE', 'PENDING', 'PROCESSING', 'READY', 'FAILED')),
  thumbnail_storage_key TEXT,
  thumbnail_error_message TEXT,

  -- Derived asset: waveform peaks (audio + video-with-audio)
  waveform_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
    CHECK (waveform_status IN ('NOT_APPLICABLE', 'PENDING', 'PROCESSING', 'READY', 'FAILED')),
  waveform_storage_key TEXT,
  waveform_error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_assets_project_id ON media_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets(status);
CREATE INDEX IF NOT EXISTS idx_media_assets_uploaded_by ON media_assets(uploaded_by);
