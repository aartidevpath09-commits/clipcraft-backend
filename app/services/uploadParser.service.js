/**
 * Streaming multipart upload parser for POST /api/v1/media/upload.
 *
 * The client MUST send the `projectId` field before the `file` field (this
 * is documented on the upload endpoint). That lets us resolve project
 * ownership BEFORE any file bytes are read off the wire, so an
 * unauthorized/unowned upload is rejected immediately rather than after
 * streaming a large file to disk.
 *
 * Uses busboy for streaming multipart parsing (no full-body buffering) and
 * HeaderSniffer (app/utils/headerSniffer.js) to magic-byte-validate a file
 * BEFORE it is ever written to storage.
 */

const crypto = require("crypto");
const Busboy = require("busboy");

const { HeaderSniffer } = require("../utils/headerSniffer");
const { validateUpload, MAGIC_BYTES_SNIFF_LENGTH, maxSizeForCategory } = require("./validation.service");
const { checkProjectOwnership } = require("./ownership.service");
const storage = require("./storage.service");
const { ApiError } = require("../utils/apiError");
const { isUuid } = require("../utils/isUuid");
const { MAX_VIDEO_SIZE_BYTES, MAX_AUDIO_SIZE_BYTES, MAX_IMAGE_SIZE_BYTES } = require("../config/media");

// Hard ceiling applied at the busboy level before we even know the media
// category (we don't know it until the file field's filename/mimetype
// arrive). The tighter, category-specific limit is enforced afterwards via
// storage.saveStream's maxBytes.
const ABSOLUTE_MAX_BYTES = Math.max(
  MAX_VIDEO_SIZE_BYTES,
  MAX_AUDIO_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES
);

/**
 * @param {import('express').Request} req
 * @param {string} devUserId
 * @returns {Promise<{ assetId: string, projectId: string, originalFilename: string, mimeType: string, extension: string, mediaType: string, storageKey: string, fileSizeBytes: number }>}
 */
function parseMediaUpload(req, devUserId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          fileSize: ABSOLUTE_MAX_BYTES,
          files: 1,
          fields: 10,
        },
      });
    } catch (err) {
      return settle(reject, ApiError.badRequest("Malformed multipart request"));
    }

    let projectId = null;
    let ownershipPromise = null;
    let fileFieldSeen = false;

    busboy.on("field", (fieldname, value) => {
      if (fieldname === "projectId") {
        projectId = value;
        ownershipPromise = checkProjectOwnership(projectId, devUserId);
        // Swallow rejections here; awaited (and surfaced) in the 'file' handler.
        ownershipPromise.catch(() => {});
      }
    });

    busboy.on("file", (fieldname, fileStream, info) => {
      if (fieldname !== "file" || fileFieldSeen) {
        fileStream.resume(); // drain and ignore unexpected/duplicate file fields
        return;
      }
      fileFieldSeen = true;

      if (!ownershipPromise) {
        fileStream.resume();
        return settle(
          reject,
          ApiError.badRequest(
            "The 'projectId' field must be sent before the 'file' field in the multipart form"
          )
        );
      }

      if (!isUuid(projectId)) {
        fileStream.resume();
        return settle(reject, ApiError.badRequest("Invalid projectId"));
      }

      const { filename, mimeType } = info;
      const sniffer = new HeaderSniffer({ sniffLength: MAGIC_BYTES_SNIFF_LENGTH });

      let fileTooBig = false;
      fileStream.on("limit", () => {
        fileTooBig = true;
      });

      fileStream.pipe(sniffer);

      sniffer.once("header", async (headerBytes) => {
        try {
          const ownership = await ownershipPromise;

          if (!ownership.exists) {
            sniffer.destroy();
            return settle(reject, ApiError.notFound("Project not found"));
          }
          if (!ownership.isOwner) {
            sniffer.destroy();
            return settle(
              reject,
              ApiError.forbidden("You do not have access to this project")
            );
          }

          if (fileTooBig) {
            sniffer.destroy();
            return settle(reject, ApiError.payloadTooLarge());
          }

          const validation = validateUpload({
            originalFilename: filename,
            declaredMimeType: mimeType,
            headerBytes,
          });

          if (!validation.ok) {
            sniffer.destroy();
            return settle(
              reject,
              ApiError.unsupportedMediaType(validation.reason)
            );
          }

          const assetId = crypto.randomUUID();
          const storageKey = storage.originalKey(assetId, validation.extension);
          const categoryMax = maxSizeForCategory(validation.mediaType);

          const { bytesWritten } = await storage.saveStream(storageKey, sniffer, categoryMax);

          settle(resolve, {
            assetId,
            projectId,
            originalFilename: filename,
            mimeType,
            extension: validation.extension,
            mediaType: validation.mediaType,
            storageKey,
            fileSizeBytes: bytesWritten,
          });
        } catch (err) {
          if (err && err.code === "MAX_BYTES_EXCEEDED") {
            return settle(reject, ApiError.payloadTooLarge());
          }
          settle(reject, err);
        }
      });
    });

    busboy.on("filesLimit", () => {
      settle(reject, ApiError.badRequest("Only one file may be uploaded per request"));
    });

    busboy.on("error", (err) => {
      settle(reject, err);
    });

    busboy.on("finish", () => {
      if (!fileFieldSeen) {
        settle(reject, ApiError.badRequest("A 'file' field is required"));
      }
      // If fileFieldSeen but never resolved/rejected (shouldn't happen), the
      // caller's request will simply hang -- guarded against by the fact
      // every code path in the 'file' handler above settles the promise.
    });

    req.pipe(busboy);
  });
}

module.exports = { parseMediaUpload };
