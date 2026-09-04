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

function renderTimeline(inputPaths, outputPath) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    return Promise.reject(new Error("Timeline must contain at least one video"));
  }

  const inputs = [];

  inputPaths.forEach((inputPath) => {
    inputs.push("-i", inputPath);
  });

  const filterInputs = inputPaths
    .map((_, index) => `[${index}:v:0][${index}:a:0]`)
    .join("");

  const filterComplex =
    `${filterInputs}concat=n=${inputPaths.length}:v=1:a=1[outv][outa]`;

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

module.exports = {
  runFFmpeg,
  runFFprobe,
  trimVideo,
  splitVideo,
  reorderVideos,
  renderTimeline,
};