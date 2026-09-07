/**
 * Media Management API. Mounted at /api/v1/media in app/server.js.
 *
 * All routes require the isolated dev-auth middleware (see
 * app/middleware/devAuth.js) until Member 1's real auth lands.
 *
 * POST   /api/v1/media/upload         multipart/form-data; fields MUST be
 *                                      sent in this order: `projectId`
 *                                      (text) then `file` (the media file).
 * GET    /api/v1/media?projectId=...  list media assets for a project
 * GET    /api/v1/media/:id            get one asset's metadata/status
 * GET    /api/v1/media/:id/stream     HTTP Range-capable playback
 *                                      (?variant=original to force the
 *                                      original file instead of the proxy)
 * GET    /api/v1/media/:id/proxy      the 360p proxy file directly (Sprint 3)
 * GET    /api/v1/media/:id/thumbnail  JPEG thumbnail
 * GET    /api/v1/media/:id/waveform   waveform peaks JSON
 * DELETE /api/v1/media/:id            deletes the asset + all its files
 */

const express = require("express");
const { devAuthRequired } = require("../middleware/devAuth");
const mediaController = require("../controllers/media.controller");

const router = express.Router();

router.use(devAuthRequired);

router.post("/upload", mediaController.upload);
router.get("/", mediaController.list);
router.get("/:id", mediaController.getOne);
router.get("/:id/stream", mediaController.streamMedia);
router.get("/:id/proxy", mediaController.getProxy);
router.get("/:id/thumbnail", mediaController.getThumbnail);
router.get("/:id/waveform", mediaController.getWaveform);
router.delete("/:id", mediaController.remove);

module.exports = router;
