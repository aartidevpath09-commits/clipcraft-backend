/**
 * Processing lifecycle orchestration for a single media asset.
 *
 * Triggered asynchronously (via processingQueue.service.js) right after an
 * upload is accepted, so it never blocks the upload request/response.
 *
 * Status model:
 *   overall status:  UPLOADING -> PROCESSING -> READY | FAILED
 *     (READY means "the original file + technical metadata are available";
 *      it does NOT wait for derived assets, which have their own statuses)
 *   proxy_status / thumbnail_status / waveform_status, each independently:
 *     NOT_APPLICABLE | PENDING -> PROCESSING -> READY | FAILED
 *
 * Every failure is caught at its own scope and recorded with a short, safe
 * message (no stderr, no filesystem paths) -- one derived asset failing
 * never fails the others or the overall asset.
 */

const mediaAssets = require("../db/mediaAssets.repository");
const storage = require("./storage.service");
const ffprobeService = require("./ffprobe.service");
const ffmpegService = require("./ffmpeg.service");
const waveformService = require("./waveform.service");

function isProxyApplicable(mediaType) {
  return mediaType === "video";
}

function isThumbnailApplicable(mediaType) {
  return mediaType === "video" || mediaType === "image";
}

function isWaveformApplicable(mediaType, hasAudio) {
  return mediaType === "audio" || (mediaType === "video" && Boolean(hasAudio));
}

/**
 * Runs one derived-asset job (proxy/thumbnail/waveform), guarding against
 * the asset being deleted while this background job is still in flight.
 *
 * DB status writes against an already-deleted row are harmless no-ops
 * (UPDATE ... WHERE id = $1 just affects 0 rows) -- but a derived-asset
 * *file* write is not harmless: generateProxy/generateThumbnail/
 * generateWaveform all call ensureParentDir() first, which will happily
 * recreate the asset's storage directory via `mkdir -p` even if
 * deleteAssetDirectory() already removed it. Left unguarded, a delete that
 * lands mid-job produces an orphaned file on disk that nothing will ever
 * reference or clean up again, since the DB row is gone.
 *
 * Two checks close that window: skip starting the job at all if the asset
 * is already gone (the common case, since ffmpeg/ffprobe work is what's
 * slow), and if the asset was deleted while `run()` was writing its
 * output, remove that output immediately afterward instead of keeping it.
 */
async function runDerivedJob({ assetId, kind, run }) {
  const stillExistsBefore = await mediaAssets.findById(assetId);
  if (!stillExistsBefore) {
    console.warn(
      `[processing] skipping ${kind} for asset ${assetId}: asset was deleted before this job started`
    );
    return;
  }

  try {
    await mediaAssets.setDerivedStatus(assetId, kind, "PROCESSING");
    const storageKey = await run();
    const updated = await mediaAssets.setDerivedStatus(assetId, kind, "READY", null, storageKey);
    if (!updated) {
      // The row was deleted while run() was writing its output file --
      // that file is now an orphan (recreated the just-deleted asset
      // directory via ensureParentDir); remove it rather than leave it.
      console.warn(
        `[processing] asset ${assetId} was deleted mid-${kind}; removing orphaned output instead of keeping it`
      );
      await storage.deleteKey(storageKey).catch(() => {});
    }
  } catch (err) {
    console.error(`[processing] ${kind} failed for asset ${assetId}:`, err.message);
    await mediaAssets
      .setDerivedStatus(assetId, kind, "FAILED", `${kind} generation failed`)
      .catch(() => {});
  }
}

async function processMediaAsset(assetId) {
  const asset = await mediaAssets.findById(assetId);
  if (!asset) {
    console.error(`[processing] asset ${assetId} vanished before processing started`);
    return;
  }

  await mediaAssets.setOverallStatus(assetId, "PROCESSING");

  const absoluteInputPath = storage.resolveAbsolutePath(asset.storage_key);

  let metadata;
  try {
    metadata = await ffprobeService.probeMedia(absoluteInputPath);
  } catch (err) {
    console.error(`[processing] ffprobe failed for asset ${assetId}:`, err.message);
    await mediaAssets.setOverallStatus(
      assetId,
      "FAILED",
      "Could not read media metadata (file may be corrupt or unsupported)"
    );
    return;
  }

  await mediaAssets.setMetadata(assetId, metadata);

  const mediaType = asset.media_type;
  const proxyApplicable = isProxyApplicable(mediaType);
  const thumbnailApplicable = isThumbnailApplicable(mediaType);
  const waveformApplicable = isWaveformApplicable(mediaType, metadata.hasAudio);

  await mediaAssets.updateFields(assetId, {
    proxy_status: proxyApplicable ? "PENDING" : "NOT_APPLICABLE",
    thumbnail_status: thumbnailApplicable ? "PENDING" : "NOT_APPLICABLE",
    waveform_status: waveformApplicable ? "PENDING" : "NOT_APPLICABLE",
  });

  // The original file + its metadata are usable now; derived assets finish
  // independently in the background.
  await mediaAssets.setOverallStatus(assetId, "READY");

  const derivedJobs = [];

  if (proxyApplicable) {
    derivedJobs.push(
      runDerivedJob({
        assetId,
        kind: "proxy",
        run: async () => {
          const storageKey = storage.derivedKey(assetId, "proxy");
          await ffmpegService.generateProxy(
            absoluteInputPath,
            storage.resolveAbsolutePath(storageKey),
            { hasAudio: metadata.hasAudio }
          );
          return storageKey;
        },
      })
    );
  }

  if (thumbnailApplicable) {
    derivedJobs.push(
      runDerivedJob({
        assetId,
        kind: "thumbnail",
        run: async () => {
          const storageKey = storage.derivedKey(assetId, "thumbnail");
          const seekSeconds = metadata.durationSeconds ? Math.min(1, metadata.durationSeconds / 2) : 0;
          await ffmpegService.generateThumbnail(
            absoluteInputPath,
            storage.resolveAbsolutePath(storageKey),
            { mediaType, seekSeconds }
          );
          return storageKey;
        },
      })
    );
  }

  if (waveformApplicable) {
    derivedJobs.push(
      runDerivedJob({
        assetId,
        kind: "waveform",
        run: async () => {
          const storageKey = storage.derivedKey(assetId, "waveform");
          await waveformService.generateWaveform(
            absoluteInputPath,
            storage.resolveAbsolutePath(storageKey),
            metadata.durationSeconds || 0
          );
          return storageKey;
        },
      })
    );
  }

  await Promise.allSettled(derivedJobs);
}

module.exports = { processMediaAsset };
