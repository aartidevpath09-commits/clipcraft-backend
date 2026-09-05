function parseTimeline(timeline) {
  if (!timeline || !Array.isArray(timeline.tracks)) {
    throw new Error("Invalid timeline format");
  }

  const videoTrack = timeline.tracks.find(
    (track) => track.type === "video"
  );

  if (!videoTrack || !Array.isArray(videoTrack.clips)) {
    throw new Error("Video track not found");
  }

  const sortedClips = [...videoTrack.clips].sort(
    (a, b) => a.start - b.start
  );

  return sortedClips.map((clip) => ({
    assetId: clip.assetId,
    start: clip.start,
    duration: clip.duration,
    volume: clip.volume ?? 1,
    transform: clip.transform || {
      scale: 1,
      x: 0,
      y: 0,
    },
  }));
}

function getVideoPathsFromTimeline(timeline, assetMap) {
  const clips = parseTimeline(timeline);

  return clips.map((clip) => {
    const videoPath = assetMap[clip.assetId];

    if (!videoPath) {
      throw new Error(`Video asset not found: ${clip.assetId}`);
    }

    return videoPath;
  });
}

function getTimelineClips(timeline, assetMap) {
  const clips = parseTimeline(timeline);

  return clips.map((clip) => {
    const videoPath = assetMap[clip.assetId];

    if (!videoPath) {
      throw new Error(`Video asset not found: ${clip.assetId}`);
    }

    return {
      assetId: clip.assetId,
      inputPath: videoPath,
      start: clip.start,
      duration: clip.duration,
      volume: clip.volume ,
      transform: clip.transform ,
    };
  });
}

module.exports = {
  parseTimeline,
  getVideoPathsFromTimeline,
  getTimelineClips,
};