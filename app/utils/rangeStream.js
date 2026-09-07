/**
 * Generic HTTP Range-aware file streaming, shared by the original-file and
 * proxy-file streaming endpoints.
 *
 * Always uses fs.createReadStream (with a byte range when requested) --
 * never fs.readFile -- so serving a multi-gigabyte file never buffers it
 * fully in memory, and clients (e.g. a <video> seek bar) can request
 * arbitrary byte ranges.
 */

const fs = require("fs");

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} absoluteFilePath
 * @param {string} contentType
 */
async function streamFileWithRange(req, res, absoluteFilePath, contentType) {
  const stat = await fs.promises.stat(absoluteFilePath);
  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  if (!rangeHeader) {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
    });
    return pipeAndHandle(fs.createReadStream(absoluteFilePath), res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (match[1] === "" && match[2] === "")) {
    res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
    return res.end();
  }

  let start = match[1] === "" ? undefined : parseInt(match[1], 10);
  let end = match[2] === "" ? undefined : parseInt(match[2], 10);

  if (start === undefined) {
    // suffix range: "bytes=-500" means the last 500 bytes
    start = Math.max(0, fileSize - end);
    end = fileSize - 1;
  } else if (end === undefined) {
    end = fileSize - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= fileSize) {
    res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
    return res.end();
  }

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    "Content-Type": contentType,
    "Content-Length": chunkSize,
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
  });

  return pipeAndHandle(fs.createReadStream(absoluteFilePath, { start, end }), res);
}

function pipeAndHandle(readStream, res) {
  return new Promise((resolve) => {
    readStream.on("error", () => {
      // Headers are already sent by this point; just terminate the response.
      res.destroy();
      resolve();
    });
    res.on("close", () => {
      readStream.destroy();
      resolve();
    });
    readStream.on("end", resolve);
    readStream.pipe(res);
  });
}

module.exports = { streamFileWithRange };
