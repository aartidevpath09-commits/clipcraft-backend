/**
 * Controllers for the media API (Route -> Controller -> Service -> Storage
 * layering: this file only orchestrates; all real work happens in
 * app/services/*).
 */

const fs = require("fs");
const mediaAssets = require("../db/mediaAssets.repository");
const { checkProjectOwnership } = require("../services/ownership.service");
const { parseMediaUpload } = require("../services/uploadParser.service");
const { processMediaAsset } = require("../services/processing.service");
const { enqueue } = require("../services/processingQueue.service");
const storage = require("../services/storage.service");
const { mimeTypeForExtension } = require("../services/validation.service");
const { streamFileWithRange } = require("../utils/rangeStream");
const { ApiError } = require("../utils/apiError");
const { isUuid } = require("../utils/isUuid");

/** Loads a media asset by id and verifies the requesting dev user owns its project. 404 vs 403 semantics: a nonexistent asset (or one whose project no longer exists) is 404; an asset that exists but isn't yours is 403. */
async function loadOwnedAsset(assetId, devUserId) {
  if (!isUuid(assetId)) {
    throw ApiError.badRequest("Invalid media asset id");
  }

  const asset = await mediaAssets.findById(assetId);
  if (!asset) {
    throw ApiError.notFound("Media asset not found");
  }

  const ownership = await checkProjectOwnership(asset.project_id, devUserId);
  if (!ownership.exists) {
    throw ApiError.notFound("Media asset not found");
  }
  if (!ownership.isOwner) {
    throw ApiError.forbidden("You do not have access to this media asset");
  }

  return asset;
}

function serializeAsset(asset) {
  return {
    id: asset.id,
    projectId: asset.project_id,
    originalFilename: asset.original_filename,
    mediaType: asset.media_type,
    mimeType: asset.mime_type,
    fileSizeBytes: Number(asset.file_size_bytes),
    status: asset.status,
    errorMessage: asset.error_message,
    durationSeconds: asset.duration_seconds,
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    videoCodec: asset.video_codec,
    audioCodec: asset.audio_codec,
    containerFormat: asset.container_format,
    bitrateBps: asset.bitrate_bps !== null ? Number(asset.bitrate_bps) : null,
    sampleRateHz: asset.sample_rate_hz,
    channels: asset.channels,
    hasAudio: asset.has_audio,
    proxy: { status: asset.proxy_status, error: asset.proxy_error_message },
    thumbnail: { status: asset.thumbnail_status, error: asset.thumbnail_error_message },
    waveform: { status: asset.waveform_status, error: asset.waveform_error_message },
    createdAt: asset.created_at,
    updatedAt: asset.updated_at,
  };
}

async function upload(req, res, next) {
  try {
    const parsed = await parseMediaUpload(req, req.devUser.userId);

    const asset = await mediaAssets.insert({
      id: parsed.assetId,
      projectId: parsed.projectId,
      uploadedBy: req.devUser.userId,
      originalFilename: parsed.originalFilename,
      mediaType: parsed.mediaType,
      mimeType: parsed.mimeType,
      extension: parsed.extension,
      fileSizeBytes: parsed.fileSizeBytes,
      storageKey: parsed.storageKey,
    });

    // Kick off ffprobe/ffmpeg work in the background -- never block this response.
    enqueue(() => processMediaAsset(asset.id));

    res.status(201).json({ asset: serializeAsset(asset) });
  } catch (err) {
    next(err);
  }
}

/**
 * Shared by both listing routes below. Verifies project ownership, then
 * returns that project's media assets in stable order (findByProjectId
 * orders by created_at DESC, backed by the idx_media_assets_project_created
 * composite index -- a single indexed query, not one query per asset).
 */
async function fetchProjectMediaList(projectId, devUserId) {
  if (!isUuid(projectId)) {
    throw ApiError.badRequest("Invalid projectId");
  }

  const ownership = await checkProjectOwnership(projectId, devUserId);
  if (!ownership.exists) throw ApiError.notFound("Project not found");
  if (!ownership.isOwner) throw ApiError.forbidden("You do not have access to this project");

  const assets = await mediaAssets.findByProjectId(projectId);
  return assets.map(serializeAsset);
}

/** GET /api/v1/media?projectId=... (query-param form, kept from Sprint 1 for backward compatibility) */
async function list(req, res, next) {
  try {
    const { projectId } = req.query;
    if (!projectId) {
      throw ApiError.badRequest("projectId query parameter is required");
    }
    const assets = await fetchProjectMediaList(projectId, req.devUser.userId);
    res.json({ assets });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/projects/:projectId/media (Sprint 2 canonical path-based
 * form, for building the project's media bin).
 *
 * Sprint 3: ownership is now verified once, upstream, by the
 * requireProjectAccess middleware (see app/routes/projectMedia.routes.js),
 * which attaches req.project -- this handler trusts that and fetches
 * directly rather than re-checking ownership via fetchProjectMediaList
 * (which remains the query-param `list` route's own ownership-check path,
 * since that route has no :projectId to hang a requireProjectAccess check
 * on).
 */
async function listByProject(req, res, next) {
  try {
    const assets = await mediaAssets.findByProjectId(req.project.id);
    res.json({ assets: assets.map(serializeAsset) });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const asset = await loadOwnedAsset(req.params.id, req.devUser.userId);
    res.json({ asset: serializeAsset(asset) });
  } catch (err) {
    next(err);
  }
}

async function streamMedia(req, res, next) {
  try {
    const asset = await loadOwnedAsset(req.params.id, req.devUser.userId);

    const variant = req.query.variant === "original" ? "original" : "auto";
    const useProxy = variant === "auto" && asset.proxy_status === "READY";

    if (useProxy) {
      await streamFileWithRange(req, res, storage.resolveAbsolutePath(asset.proxy_storage_key), "video/mp4");
      return;
    }

    if (asset.status !== "READY" && asset.status !== "PROCESSING") {
      throw ApiError.badRequest("Media asset is not yet available for streaming");
    }

    const contentType = mimeTypeForExtension(asset.extension);
    await streamFileWithRange(req, res, storage.resolveAbsolutePath(asset.storage_key), contentType);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/media/:id/proxy (Sprint 3) -- explicit access to the 360p
 * proxy file, symmetric with getThumbnail/getWaveform below. This
 * complements (does not replace) `stream`'s existing auto-proxy-preferring
 * behavior: `stream` picks proxy vs. original for playback automatically,
 * while this endpoint is for a caller that specifically wants the proxy
 * file itself, mirroring the render/preview selection now centralized in
 * mediaResolver.service.js.
 */
async function getProxy(req, res, next) {
  try {
    const asset = await loadOwnedAsset(req.params.id, req.devUser.userId);

    if (asset.proxy_status !== "READY") {
      throw ApiError.notFound("Proxy is not available for this asset");
    }

    await streamFileWithRange(req, res, storage.resolveAbsolutePath(asset.proxy_storage_key), "video/mp4");
  } catch (err) {
    next(err);
  }
}

async function getThumbnail(req, res, next) {
  try {
    const asset = await loadOwnedAsset(req.params.id, req.devUser.userId);

    if (asset.thumbnail_status !== "READY") {
      throw ApiError.notFound("Thumbnail is not available for this asset");
    }

    await streamFileWithRange(req, res, storage.resolveAbsolutePath(asset.thumbnail_storage_key), "image/jpeg");
  } catch (err) {
    next(err);
  }
}

async function getWaveform(req, res, next) {
  try {
    const asset = await loadOwnedAsset(req.params.id, req.devUser.userId);

    if (asset.waveform_status !== "READY") {
      throw ApiError.notFound("Waveform is not available for this asset");
    }

    const absolutePath = storage.resolveAbsolutePath(asset.waveform_storage_key);
    res.setHeader("Content-Type", "application/json");
    fs.createReadStream(absolutePath).pipe(res);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const asset = await loadOwnedAsset(req.params.id, req.devUser.userId);

    await mediaAssets.deleteById(asset.id);
    await storage.deleteAssetDirectory(asset.id);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { upload, list, listByProject, getOne, streamMedia, getProxy, getThumbnail, getWaveform, remove };
