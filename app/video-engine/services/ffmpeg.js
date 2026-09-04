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

module.exports = {
  runFFmpeg,
  runFFprobe,
  trimVideo,
};