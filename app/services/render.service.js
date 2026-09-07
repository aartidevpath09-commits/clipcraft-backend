const { spawn } = require("child_process");

function renderVideo(inputFile, outputFile) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      inputFile,
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-y",
      outputFile
    ]);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(outputFile);
      } else {
        reject(new Error("Video rendering failed"));
      }
    });

    ffmpeg.on("error", (error) => {
      reject(error);
    });
  });
}

module.exports = {
  renderVideo
};