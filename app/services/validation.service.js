/**
 * Multi-layer media upload validation: extension + declared MIME type +
 * magic-byte (file signature) sniffing, plus per-category size limits.
 *
 * All three identity checks (extension, MIME, magic bytes) must agree on the
 * same media-type family before an upload is accepted. This defends against
 * a mismatched/spoofed Content-Type header or a renamed file extension --
 * neither alone is trusted.
 */

const path = require("path");
const {
  MAX_VIDEO_SIZE_BYTES,
  MAX_AUDIO_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
} = require("../config/media");

// Only the first bytes of a file are needed to check any of these
// signatures. Callers should sniff at least this many bytes.
const MAGIC_BYTES_SNIFF_LENGTH = 64;

function bytesStartWith(buf, offset, expected) {
  if (buf.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (buf[offset + i] !== expected[i]) return false;
  }
  return true;
}

function asciiBytes(str) {
  return Buffer.from(str, "ascii");
}

// ISO Base Media File Format (mp4, mov, m4a): a "ftyp" box, whose 4-byte
// type tag sits at offset 4.
function isIsoBmff(buf) {
  return bytesStartWith(buf, 4, asciiBytes("ftyp"));
}

function isEbml(buf) {
  // Matroska/WebM EBML header magic
  return bytesStartWith(buf, 0, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function isRiffWithForm(buf, form) {
  return (
    bytesStartWith(buf, 0, asciiBytes("RIFF")) &&
    bytesStartWith(buf, 8, asciiBytes(form))
  );
}

const MEDIA_TYPES = [
  {
    category: "video",
    key: "mp4",
    extensions: [".mp4"],
    mimeTypes: ["video/mp4"],
    matchesMagic: isIsoBmff,
  },
  {
    category: "video",
    key: "mov",
    extensions: [".mov"],
    mimeTypes: ["video/quicktime"],
    // QuickTime .mov almost always uses an ftyp box too; a small number of
    // legacy files start straight with moov/mdat/wide/free instead.
    matchesMagic: (buf) =>
      isIsoBmff(buf) ||
      bytesStartWith(buf, 4, asciiBytes("moov")) ||
      bytesStartWith(buf, 4, asciiBytes("mdat")) ||
      bytesStartWith(buf, 4, asciiBytes("wide")) ||
      bytesStartWith(buf, 4, asciiBytes("free")),
  },
  {
    category: "video",
    key: "webm",
    extensions: [".webm"],
    mimeTypes: ["video/webm"],
    matchesMagic: isEbml,
  },
  {
    category: "video",
    key: "mkv",
    extensions: [".mkv"],
    mimeTypes: ["video/x-matroska"],
    matchesMagic: isEbml,
  },
  {
    category: "image",
    key: "jpeg",
    extensions: [".jpg", ".jpeg"],
    mimeTypes: ["image/jpeg"],
    matchesMagic: (buf) =>
      bytesStartWith(buf, 0, Buffer.from([0xff, 0xd8, 0xff])),
  },
  {
    category: "image",
    key: "png",
    extensions: [".png"],
    mimeTypes: ["image/png"],
    matchesMagic: (buf) =>
      bytesStartWith(
        buf,
        0,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ),
  },
  {
    category: "image",
    key: "webp",
    extensions: [".webp"],
    mimeTypes: ["image/webp"],
    matchesMagic: (buf) => isRiffWithForm(buf, "WEBP"),
  },
  {
    category: "audio",
    key: "mp3",
    extensions: [".mp3"],
    mimeTypes: ["audio/mpeg", "audio/mp3"],
    matchesMagic: (buf) =>
      bytesStartWith(buf, 0, asciiBytes("ID3")) ||
      (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0),
  },
  {
    category: "audio",
    key: "wav",
    extensions: [".wav"],
    mimeTypes: ["audio/wav", "audio/x-wav", "audio/wave"],
    matchesMagic: (buf) => isRiffWithForm(buf, "WAVE"),
  },
  {
    category: "audio",
    key: "aac-m4a",
    extensions: [".m4a", ".aac"],
    mimeTypes: ["audio/mp4", "audio/x-m4a", "audio/aac"],
    matchesMagic: (buf) => isIsoBmff(buf),
  },
  {
    category: "audio",
    key: "ogg",
    extensions: [".ogg", ".oga"],
    mimeTypes: ["audio/ogg", "application/ogg"],
    matchesMagic: (buf) => bytesStartWith(buf, 0, asciiBytes("OggS")),
  },
];

const MAX_SIZE_BY_CATEGORY = {
  video: MAX_VIDEO_SIZE_BYTES,
  audio: MAX_AUDIO_SIZE_BYTES,
  image: MAX_IMAGE_SIZE_BYTES,
};

function findByExtension(extension) {
  return MEDIA_TYPES.filter((t) => t.extensions.includes(extension));
}

/**
 * Validate an upload against extension + declared MIME type + magic bytes.
 *
 * @param {object} input
 * @param {string} input.originalFilename
 * @param {string} input.declaredMimeType - Content-Type / form-field MIME as reported by the client
 * @param {Buffer} input.headerBytes - at least MAGIC_BYTES_SNIFF_LENGTH bytes from the start of the file
 * @param {number} input.sizeBytes - total upload size, if known up front (may be undefined for streamed uploads; size is enforced separately as bytes arrive)
 * @returns {{ ok: true, mediaType: string, extension: string } | { ok: false, reason: string }}
 */
function validateUpload({ originalFilename, declaredMimeType, headerBytes, sizeBytes }) {
  const extension = path.extname(originalFilename || "").toLowerCase();

  if (!extension) {
    return { ok: false, reason: "File has no extension" };
  }

  const candidates = findByExtension(extension);
  if (candidates.length === 0) {
    return { ok: false, reason: `Unsupported file extension: ${extension}` };
  }

  const normalizedMime = (declaredMimeType || "").split(";")[0].trim().toLowerCase();
  const mimeMatch = candidates.find((t) => t.mimeTypes.includes(normalizedMime));
  if (!mimeMatch) {
    return {
      ok: false,
      reason: `Declared MIME type "${declaredMimeType}" does not match extension "${extension}"`,
    };
  }

  if (!headerBytes || !mimeMatch.matchesMagic(headerBytes)) {
    return {
      ok: false,
      reason: "File content does not match its declared type (signature check failed)",
    };
  }

  const maxSize = MAX_SIZE_BY_CATEGORY[mimeMatch.category];
  if (typeof sizeBytes === "number" && sizeBytes > maxSize) {
    return {
      ok: false,
      reason: `File exceeds maximum allowed size for ${mimeMatch.category} (${maxSize} bytes)`,
    };
  }

  return { ok: true, mediaType: mimeMatch.category, extension, formatKey: mimeMatch.key };
}

function maxSizeForCategory(category) {
  return MAX_SIZE_BY_CATEGORY[category];
}

/** Canonical MIME type to serve a stored file with, given its extension (e.g. for streaming responses). */
function mimeTypeForExtension(extension) {
  const match = MEDIA_TYPES.find((t) => t.extensions.includes(extension));
  return match ? match.mimeTypes[0] : "application/octet-stream";
}

module.exports = {
  MAGIC_BYTES_SNIFF_LENGTH,
  validateUpload,
  maxSizeForCategory,
  mimeTypeForExtension,
  MEDIA_TYPES,
};
