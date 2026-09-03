/**
 * ============================================================================
 * ISOLATED DEVELOPMENT/TEST AUTH -- TEMPORARY, NOT PRODUCTION ARCHITECTURE
 * ============================================================================
 * Member 1 owns real authentication. It doesn't exist on this branch yet, so
 * Media Management needs *some* way to establish "who is making this
 * request" in order to enforce project-ownership checks on media
 * upload/access/delete.
 *
 * This file is deliberately kept small, isolated, and impossible to mistake
 * for real auth:
 *   - it only issues/verifies tokens for the `dev_users` placeholder table
 *     (see app/db/migrations/001_dev_placeholder_auth.sql)
 *   - it signs with its own env var (DEV_AUTH_JWT_SECRET), never a
 *     production auth secret
 *   - it is only ever wired to the /api/v1/dev/* routes (see
 *     app/routes/dev.routes.js) and used by devAuthRequired below
 *   - nothing outside this file and dev.routes.js should import from
 *     `dev_users` / `dev_projects`
 *
 * DELETE THIS FILE (and app/routes/dev.routes.js, and the dev_* tables) once
 * Member 1's real auth + projects ship. Do not extend this into permanent
 * media architecture.
 * ============================================================================
 */

const jwt = require("jsonwebtoken");

const DEV_AUTH_JWT_SECRET =
  process.env.DEV_AUTH_JWT_SECRET || "clipcraft-dev-only-insecure-secret";

if (!process.env.DEV_AUTH_JWT_SECRET) {
  // Loud on purpose: nobody should be surprised this isn't a real secret.
  console.warn(
    "[devAuth] DEV_AUTH_JWT_SECRET not set -- using an insecure development default. " +
      "This auth mechanism is temporary scaffolding and must never be used in production."
  );
}

function issueDevToken(devUserId) {
  return jwt.sign({ sub: devUserId }, DEV_AUTH_JWT_SECRET, { expiresIn: "7d" });
}

function devAuthRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({
      error: "UNAUTHENTICATED",
      message: "Missing or malformed Authorization header (expected: Bearer <dev token>)",
    });
  }

  try {
    const payload = jwt.verify(token, DEV_AUTH_JWT_SECRET);
    req.devUser = { id: payload.sub };
    // Sprint 3: also expose the identity as `req.user`, the field name
    // Member 1's real auth middleware (authenticateToken) is expected to
    // set (see requireProjectAccess.js and the Sprint 3 flow diagram in
    // MEMBER2_SPRINT3.md). Same object, two names -- purely so new Sprint 3
    // code can be written once against `req.user.id` and keep working
    // unchanged the moment this file is deleted in favor of the real thing.
    req.user = req.devUser;
    next();
  } catch {
    return res.status(401).json({
      error: "UNAUTHENTICATED",
      message: "Invalid or expired development token",
    });
  }
}

module.exports = { issueDevToken, devAuthRequired };
