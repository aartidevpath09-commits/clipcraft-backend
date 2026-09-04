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
  }));
}

module.exports = {
  parseTimeline,
};