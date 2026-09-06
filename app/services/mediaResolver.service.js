/**
 * MediaResolver: the sole integration contract Member 3A (Video Engine)
 * should use to go from a project's media to usable files + metadata for
 * timeline compilation and rendering.
 *
 * This is intentionally the ONLY thing outside this module that should ever
 * need to know a media asset maps to files on disk. Callers get back a
 * small discriminated result plus, for a usable asset, a flat metadata
 * object with a single resolved `sourcePath` -- they never see storage
 * keys, the storage root, PostgreSQL table structure, or how/where derived
 * assets are laid out, ffprobe, thumbnailing, or waveform generation work.
 * When storage moves to S3 (or anywhere else), only storage.service.js
 * changes -- this resolver's return shapes stay the same.
 *
 * ---------------------------------------------------------------------
 * Sprint 3 contract (see MEMBER2_SPRINT3.md for the full integration doc):
 *
 *   resolveProjectAsset(projectId, assetId, { userId, purpose })
 *     Resolve one specific asset for a given purpose ('render' | 'preview',
 *     default 'preview'). Returns a discriminated result -- see
 *     RESOLUTION_STATUS below -- so the Video Engine can never accidentally
 *     treat a not-ready / not-yours / missing-on-disk asset as usable.
 *
 *   getProjectAssetsMap(projectId, userId, { purpose })
 *     Resolve every asset in a project at once (e.g. to validate/compile a
 *     whole timeline in a single indexed query). Returns
 *     { status: 'FORBIDDEN' } or { status: 'OK', assets: Map<assetId, entry> },
 *     where each entry has the same shape as resolveProjectAsset's result.
 *
 * `userId` is REQUIRED wherever authorization matters (never optional, never
 * trusted from anywhere but the caller's own authenticated identity) -- a
 * call without it is treated as unauthenticated and always resolves to
 * FORBIDDEN rather than throwing, so a caller that forgets to pass it fails
 * closed, not open.
 * ---------------------------------------------------------------------
 *
 * A lower-level resolveAsset(mediaAssetId) is also exported for simpler
 * internal use where the caller has already established authorization by
 * some other means -- it does NOT check project ownership itself.
 */

const mediaAssets = require("../db/mediaAssets.repository");
const storage = require("./storage.service");
const { checkProjectOwnership } = require("./ownership.service");
const { isUuid } = require("../utils/isUuid");

const RESOLUTION_STATUS = {
  FORBIDDEN: "FORBIDDEN", // projectId doesn't exist, doesn't belong to userId, or userId was omitted
  NOT_FOUND: "NOT_FOUND", // no media_assets row with this id at all
  WRONG_PROJECT: "WRONG_PROJECT", // the asset exists, but not inside the given project
  NOT_READY: "NOT_READY", // asset exists and belongs to the project, but isn't READY yet
  SOURCE_MISSING: "SOURCE_MISSING", // DB says READY, but the physical file this purpose needs isn't on disk
  READY: "READY",
};

const PURPOSES = { RENDER: "render", PREVIEW: "preview" };

/** Anything other than the literal 'render' is treated as 'preview' -- the safer, lighter-weight default. */
function normalizePurpose(purpose) {
  return purpose === PURPOSES.RENDER ? PURPOSES.RENDER : PURPOSES.PREVIEW;
}

/** Builds the full metadata + resolvable file locations payload for a READY asset (before the purpose/existence pass below). */
function buildMetadataPayload(asset) {
  return {
    id: asset.id,
    projectId: asset.project_id,
    mediaType: asset.media_type,
    status: asset.status,
    durationSeconds: asset.duration_seconds,
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    hasAudio: asset.has_audio,
    videoCodec: asset.video_codec,
    audioCodec: asset.audio_codec,
    containerFormat: asset.container_format,
    // Server-side-only absolute paths -- these must never be forwarded to a
    // browser/HTTP client, only used internally by the Video Engine's own
    // FFmpeg invocations.
    originalPath: storage.resolveAbsolutePath(asset.storage_key),
    proxyPath: asset.proxy_status === "READY" ? storage.resolveAbsolutePath(asset.proxy_storage_key) : null,
    thumbnailPath:
      asset.thumbnail_status === "READY" ? storage.resolveAbsolutePath(asset.thumbnail_storage_key) : null,
    waveformPath:
      asset.waveform_status === "READY" ? storage.resolveAbsolutePath(asset.waveform_storage_key) : null,
  };
}

/**
 * Render vs. preview asset selection, centralized here so Member 3A never
 * has to decide (or manually construct a path) themselves:
 *   - purpose 'render'  -> always the original source file.
 *   - purpose 'preview' -> the proxy when one is READY, else the original.
 * Returns which underlying storage key was chosen (so its existence can be
 * verified) alongside the already-resolved absolute path.
 */
function selectSourceForPurpose(asset, payload, purpose) {
  const useProxy = purpose === PURPOSES.PREVIEW && asset.proxy_status === "READY";
  return useProxy
    ? { kind: "proxy", storageKey: asset.proxy_storage_key, path: payload.proxyPath }
    : { kind: "original", storageKey: asset.storage_key, path: payload.originalPath };
}

/**
 * Given an asset row already confirmed to belong to the right project,
 * decide NOT_READY / SOURCE_MISSING / READY for the requested purpose.
 * Async because it verifies the selected file actually exists on disk --
 * a database status of READY is never enough on its own (see section 13 of
 * the Sprint 3 brief: "do not allow a missing physical file to silently
 * reach FFmpeg").
 */
async function classifyAsset(asset, purpose) {
  if (asset.status !== "READY") {
    return {
      status: RESOLUTION_STATUS.NOT_READY,
      assetStatus: asset.status, // 'UPLOADING' | 'PROCESSING' | 'FAILED'
      errorMessage: asset.status === "FAILED" ? asset.error_message : null,
    };
  }

  const payload = buildMetadataPayload(asset);
  const normalizedPurpose = normalizePurpose(purpose);
  const selected = selectSourceForPurpose(asset, payload, normalizedPurpose);

  // The original is the foundational guarantee of a READY row -- verify it
  // regardless of which file was actually selected, so a asset whose source
  // was deleted out from under the database is never reported usable.
  const originalExists = await storage.exists(asset.storage_key);
  if (!originalExists) {
    return {
      status: RESOLUTION_STATUS.SOURCE_MISSING,
      message: "The original media file is missing from storage",
    };
  }

  if (selected.kind === "proxy") {
    const proxyExists = await storage.exists(selected.storageKey);
    if (!proxyExists) {
      // Deliberately NOT a silent fallback to the original -- a proxy row
      // marked READY whose file is gone indicates a real inconsistency
      // between the database and storage that a caller needs to see, not
      // one this resolver should paper over.
      return {
        status: RESOLUTION_STATUS.SOURCE_MISSING,
        message: "The proxy file is missing from storage",
      };
    }
  }

  return {
    status: RESOLUTION_STATUS.READY,
    asset: {
      ...payload,
      purpose: normalizedPurpose,
      sourcePath: selected.path,
      sourceKind: selected.kind, // 'original' | 'proxy' -- which file sourcePath actually points at
    },
  };
}

/**
 * Resolve a single asset for the Video Engine, for a given purpose. Project
 * ownership is checked BEFORE the asset is even looked up, so an
 * unauthorized caller learns nothing about whether the asset id exists.
 *
 * @param {string} projectId
 * @param {string} assetId
 * @param {{ userId: string, purpose?: 'render' | 'preview' }} options
 *   `userId` is required -- omitting it always resolves to FORBIDDEN.
 *   `purpose` defaults to 'preview'.
 * @returns {Promise<
 *   | { status: 'FORBIDDEN' }
 *   | { status: 'NOT_FOUND' }
 *   | { status: 'WRONG_PROJECT' }
 *   | { status: 'NOT_READY', assetStatus: string, errorMessage: string | null }
 *   | { status: 'SOURCE_MISSING', message: string }
 *   | { status: 'READY', asset: object }
 * >}
 */
async function resolveProjectAsset(projectId, assetId, options = {}) {
  const { userId, purpose } = options;

  if (!userId || !isUuid(projectId)) {
    return { status: RESOLUTION_STATUS.FORBIDDEN };
  }

  const ownership = await checkProjectOwnership(projectId, userId);
  if (!ownership.exists || !ownership.isOwner) {
    return { status: RESOLUTION_STATUS.FORBIDDEN };
  }

  if (!isUuid(assetId)) {
    return { status: RESOLUTION_STATUS.NOT_FOUND };
  }

  const asset = await mediaAssets.findById(assetId);
  if (!asset) {
    return { status: RESOLUTION_STATUS.NOT_FOUND };
  }
  if (asset.project_id !== projectId) {
    return { status: RESOLUTION_STATUS.WRONG_PROJECT };
  }

  return classifyAsset(asset, purpose);
}

/**
 * Resolve every asset belonging to a project at once (e.g. to validate or
 * compile a whole timeline in one pass) -- a single indexed query, not one
 * lookup per clip, followed by one existence check per asset.
 *
 * @param {string} projectId
 * @param {string} userId required -- omitting it always resolves to FORBIDDEN.
 * @param {{ purpose?: 'render' | 'preview' }} [options]
 * @returns {Promise<
 *   | { status: 'FORBIDDEN' }
 *   | { status: 'OK', assets: Map<string, { status: string, asset?: object, assetStatus?: string, errorMessage?: string|null, message?: string }> }
 * >}
 */
async function getProjectAssetsMap(projectId, userId, options = {}) {
  const { purpose } = options;

  if (!userId || !isUuid(projectId)) {
    return { status: RESOLUTION_STATUS.FORBIDDEN };
  }

  const ownership = await checkProjectOwnership(projectId, userId);
  if (!ownership.exists || !ownership.isOwner) {
    return { status: RESOLUTION_STATUS.FORBIDDEN };
  }

  const rows = await mediaAssets.findByProjectId(projectId);
  const assets = new Map();
  for (const asset of rows) {
    assets.set(asset.id, await classifyAsset(asset, purpose));
  }

  return { status: "OK", assets };
}

/**
 * Lower-level single-asset lookup with NO ownership check of its own and NO
 * physical-file verification -- only use this where the caller has already
 * established authorization by some other means (or pass expectedProjectId
 * as a minimal defense-in-depth check). Prefer resolveProjectAsset for
 * anything reachable from user input or from Member 3A.
 *
 * @param {string} mediaAssetId
 * @param {{ expectedProjectId?: string }} [options]
 * @returns {Promise<null | object>} same metadata shape as buildMetadataPayload, or null if not found / invalid id / wrong project
 */
async function resolveAsset(mediaAssetId, options = {}) {
  if (!isUuid(mediaAssetId)) return null;

  const asset = await mediaAssets.findById(mediaAssetId);
  if (!asset) return null;

  if (options.expectedProjectId && asset.project_id !== options.expectedProjectId) {
    return null;
  }

  return buildMetadataPayload(asset);
}

module.exports = {
  RESOLUTION_STATUS,
  PURPOSES,
  resolveProjectAsset,
  getProjectAssetsMap,
  resolveAsset,
};
