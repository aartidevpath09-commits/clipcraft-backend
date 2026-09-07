/**
 * Data-access layer for the media_assets table. No ORM: plain parameterized
 * SQL via the shared pg pool (app/config/db.js). Every other module reaches
 * media_assets only through these functions.
 */

const pool = require("../config/db");

async function insert({
  id,
  projectId,
  uploadedBy,
  originalFilename,
  mediaType,
  mimeType,
  extension,
  fileSizeBytes,
  storageKey,
}) {
  const result = await pool.query(
    `INSERT INTO media_assets
       (id, project_id, uploaded_by, original_filename, media_type, mime_type,
        extension, file_size_bytes, storage_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'UPLOADING')
     RETURNING *`,
    [id, projectId, uploadedBy || null, originalFilename, mediaType, mimeType, extension, fileSizeBytes, storageKey]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await pool.query("SELECT * FROM media_assets WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function findByProjectId(projectId) {
  const result = await pool.query(
    "SELECT * FROM media_assets WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );
  return result.rows;
}

async function deleteById(id) {
  await pool.query("DELETE FROM media_assets WHERE id = $1", [id]);
}

/** Bulk-deletes every media_assets row for a project in one query (used by project deletion cleanup). */
async function deleteAllByProjectId(projectId) {
  await pool.query("DELETE FROM media_assets WHERE project_id = $1", [projectId]);
}

/** Generic partial update. `fields` is a plain object of column -> value. */
async function updateFields(id, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return findById(id);

  const setClause = columns.map((col, i) => `${col} = $${i + 2}`).join(", ");
  const values = columns.map((col) => fields[col]);

  const result = await pool.query(
    `UPDATE media_assets SET ${setClause}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return result.rows[0] || null;
}

async function setOverallStatus(id, status, errorMessage = null) {
  return updateFields(id, { status, error_message: errorMessage });
}

async function setMetadata(id, metadata) {
  return updateFields(id, {
    duration_seconds: metadata.durationSeconds,
    width: metadata.width,
    height: metadata.height,
    fps: metadata.fps,
    video_codec: metadata.videoCodec,
    audio_codec: metadata.audioCodec,
    container_format: metadata.containerFormat,
    bitrate_bps: metadata.bitrateBps,
    sample_rate_hz: metadata.sampleRateHz,
    channels: metadata.channels,
    has_audio: metadata.hasAudio,
  });
}

async function setDerivedStatus(id, kind, status, errorMessage = null, storageKey = undefined) {
  const fields = {
    [`${kind}_status`]: status,
    [`${kind}_error_message`]: errorMessage,
  };
  if (storageKey !== undefined) {
    fields[`${kind}_storage_key`] = storageKey;
  }
  return updateFields(id, fields);
}

module.exports = {
  insert,
  findById,
  findByProjectId,
  deleteById,
  deleteAllByProjectId,
  updateFields,
  setOverallStatus,
  setMetadata,
  setDerivedStatus,
};
