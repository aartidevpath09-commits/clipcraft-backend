/**
 * Typed application error. Every deliberate rejection (validation failure,
 * ownership failure, not-found, etc.) throughout the media module uses this
 * so the central error-handling middleware (app/middleware/errorHandler.js)
 * can respond consistently and never leak stack traces or filesystem paths.
 */

class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }

  static badRequest(message, code = "VALIDATION_ERROR") {
    return new ApiError(400, code, message);
  }

  static unauthenticated(message = "Authentication required") {
    return new ApiError(401, "UNAUTHENTICATED", message);
  }

  static forbidden(message = "You do not have access to this resource") {
    return new ApiError(403, "FORBIDDEN", message);
  }

  static notFound(message = "Resource not found") {
    return new ApiError(404, "NOT_FOUND", message);
  }

  static payloadTooLarge(message = "Upload exceeds the maximum allowed size") {
    return new ApiError(413, "PAYLOAD_TOO_LARGE", message);
  }

  static unsupportedMediaType(message) {
    return new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", message);
  }

  static internal(message = "Internal server error") {
    return new ApiError(500, "INTERNAL_ERROR", message);
  }
}

module.exports = { ApiError };
