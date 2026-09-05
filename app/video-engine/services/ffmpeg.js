const { execFile } = require("child_process");

const FFMPEG_PATH = "ffmpeg";
const FFPROBE_PATH = "ffprobe";

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG_PATH, args, (error, stdout, stderr) => {
      if (error) {
        console.error("FFmpeg Error:", stderr);
        return reject(error);
      }

      resolve({
        stdout,
        stderr,
      });
    });
  });
}

function runFFprobe(args) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_PATH, args, (error, stdout, stderr) => {
      if (error) {
        console.error("FFprobe Error:", stderr);
        return reject(error);
      }

      resolve({
        stdout,
        stderr,
      });
    });
  });
}

function trimVideo(inputPath, outputPath, startTime, duration) {
  return runFFmpeg([
    "-i",
    inputPath,
    "-ss",
    String(startTime),
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-y",
    outputPath,
  ]);
}

function splitVideo(inputPath, firstOutputPath, secondOutputPath, splitTime) {
  return Promise.all([
    runFFmpeg([
      "-i",
      inputPath,
      "-t",
      String(splitTime),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-y",
      firstOutputPath,
    ]),

    runFFmpeg([
      "-i",
      inputPath,
      "-ss",
      String(splitTime),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-y",
      secondOutputPath,
    ]),
  ]);
}

function reorderVideos(inputPaths, outputPath) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    return Promise.reject(new Error("At least one video is required"));
  }

  const inputs = [];

  inputPaths.forEach((inputPath) => {
    inputs.push("-i", inputPath);
  });

  const filterInputs = inputPaths
    .map((_, index) => `[${index}:v:0][${index}:a:0]`)
    .join("");

  const filterComplex = `${filterInputs}concat=n=${inputPaths.length}:v=1:a=1[outv][outa]`;

  return runFFmpeg([
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-y",
    outputPath,
  ]);
}

function renderTimeline(clips, outputPath) {
  if (!Array.isArray(clips) || clips.length === 0) {
    return Promise.reject(new Error("Timeline must contain at least one clip"));
  }

  const inputs = [];

  clips.forEach((clip) => {
    inputs.push("-i", clip.inputPath);
  });

  const filterInputs = clips
    .map(
      (_, index) =>
        `[${index}:v:0]trim=duration=${clips[index].duration},setpts=PTS-STARTPTS[v${index}];` +
        `[${index}:a:0]atrim=duration=${clips[index].duration},asetpts=PTS-STARTPTS[a${index}]`
    )
    .join(";");

  const concatInputs = clips
    .map((_, index) => `[v${index}][a${index}]`)
    .join("");

  const filterComplex =
    `${filterInputs};` +
    `${concatInputs}concat=n=${clips.length}:v=1:a=1[outv][outa]`;

  return runFFmpeg([
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ]);
}

function applyTransform(
  videoPath,
  outputPath,
  scale = 1,
  x = 0,
  y = 0
) {
  const safeScale = Math.max(0.1, Number(scale));
  const safeX = Number(x);
  const safeY = Number(y);

  return runFFmpeg([
    "-i",
    videoPath,
    "-filter_complex",
    `[0:v]split[original][scaled];` +
      `[scaled]scale=iw*${safeScale}:ih*${safeScale}[scaledvideo];` +
      `[original][scaledvideo]overlay=${safeX}:${safeY}:shortest=1[outv]`,
    "-map",
    "[outv]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ]);
}

function addImageOverlay(
  videoPath,
  imagePath,
  outputPath,
  x = 0,
  y = 0,
  opacity = 1
) {
  const safeOpacity = Math.max(0, Math.min(1, Number(opacity)));

  return runFFmpeg([
    "-i",
    videoPath,
    "-i",
    imagePath,
    "-filter_complex",
    `[1:v]format=rgba,colorchannelmixer=aa=${safeOpacity}[overlay];` +
      `[0:v][overlay]overlay=${x}:${y}:format=auto[outv]`,
    "-map",
    "[outv]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ]);
}

module.exports = {
  runFFmpeg,
  runFFprobe,
  trimVideo,
  splitVideo,
  reorderVideos,
  renderTimeline,
  applyTransform,
  addImageOverlay,
};