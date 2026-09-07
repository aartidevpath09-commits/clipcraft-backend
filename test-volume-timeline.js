const {
  renderTimeline,
} = require("./app/video-engine/services/ffmpeg");

const timeline = {
  tracks: [
    {
      type: "video",
      clips: [
        {
          inputPath: "./storage/clipA.mp4",
          start: 0,
          duration: 5,
          volume: 0.5,
        },
        {
          inputPath: "./storage/clipB.mp4",
          start: 5,
          duration: 8,
          volume: 1,
        },
        {
          inputPath: "./storage/silent-test.mp4",
          start: 13,
          duration: 10,
          volume: 0,
        },
      ],
    },
  ],
};

const clips = timeline.tracks[0].clips;

renderTimeline(clips, "./storage/volume-timeline-test-new.mp4")
  .then(() => {
    console.log("Volume timeline render successful");
  })
  .catch((error) => {
    console.error("Volume timeline render failed:", error);
  });