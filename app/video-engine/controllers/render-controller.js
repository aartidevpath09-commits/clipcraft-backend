const path = require("path");

const {
  getTimelineClips,
} = require("../utils/timeline-parser");

const {
  renderTimeline,
} = require("../services/ffmpeg");

const STORAGE_DIR = path.join(process.cwd(), "storage");

// Temporary asset mapping for MVP testing
const assetMap = {
  clipA: path.join(STORAGE_DIR, "clipA.mp4"),
  clipB: path.join(STORAGE_DIR, "clipB.mp4"),
  clipC: path.join(STORAGE_DIR, "clipC.mp4"),
};

async function renderVideo(req, res) {
  try {
    const { timeline } = req.body;

    if (!timeline) {
      return res.status(400).json({
        success: false,
        message: "Timeline is required",
      });
    }

    const clips = getTimelineClips(timeline, assetMap);

    const outputFileName = `render-${Date.now()}.mp4`;
    const outputPath = path.join(STORAGE_DIR, outputFileName);

    await renderTimeline(clips, outputPath);

    return res.status(200).json({
      success: true,
      message: "Video rendered successfully",
      fileName: outputFileName,
      outputPath,
    });
  } catch (error) {
    console.error("Video render failed:", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
}

module.exports = {
  renderVideo,
};