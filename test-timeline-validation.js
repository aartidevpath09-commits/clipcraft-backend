const { parseTimeline } = require("./app/video-engine/utils/timeline-parser");

const validTimeline = {
  tracks: [
    {
      type: "video",
      clips: [
        {
          assetId: "clipA",
          start: 0,
          duration: 5,
          volume: 0.5
        }
      ]
    }
  ]
};

try {
  const result = parseTimeline(validTimeline);
  console.log("Validation test passed");
  console.log(result);
} catch (error) {
  console.error("Validation test failed:", error.message);
}