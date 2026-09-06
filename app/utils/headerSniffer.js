/**
 * HeaderSniffer: a Transform stream that withholds the first `sniffLength`
 * bytes of a stream from any downstream consumer until it has buffered that
 * many bytes (or the stream ends, for files smaller than sniffLength), at
 * which point it emits a `header` event carrying that buffer and only then
 * releases everything (header bytes + all subsequent chunks) downstream.
 *
 * This lets a caller magic-byte-sniff an upload BEFORE deciding whether to
 * pipe it to storage at all -- an invalid/spoofed upload never reaches disk,
 * rather than being written and then deleted.
 *
 * Usage:
 *   const sniffer = new HeaderSniffer({ sniffLength: 64 });
 *   fileStream.pipe(sniffer);
 *   sniffer.once('header', (headerBuf) => {
 *     const result = validateUpload({ headerBytes: headerBuf, ... });
 *     if (result.ok) {
 *       storage.saveStream(key, sniffer); // flushes buffered header + continues
 *     } else {
 *       sniffer.destroy(); // upstream (busboy file stream) is drained/discarded
 *     }
 *   });
 *
 * IMPORTANT: do not attach any consumer (.pipe(), .on('data', ...),
 * .resume()) to the sniffer before the 'header' event fires. Buffered bytes
 * are only held back while nothing is reading -- piping into it early
 * switches it to flowing mode and bytes will be emitted before validation
 * has a chance to run.
 */

const { Transform } = require("stream");

class HeaderSniffer extends Transform {
  constructor({ sniffLength = 64 } = {}) {
    super();
    this.sniffLength = sniffLength;
    this._chunks = [];
    this._bufferedBytes = 0;
    this._headerEmitted = false;
  }

  _transform(chunk, _encoding, callback) {
    if (this._headerEmitted) {
      this.push(chunk);
      return callback();
    }

    this._chunks.push(chunk);
    this._bufferedBytes += chunk.length;

    if (this._bufferedBytes >= this.sniffLength) {
      this._flushHeader();
    }

    callback();
  }

  _flush(callback) {
    if (!this._headerEmitted) {
      // Stream ended before reaching sniffLength (very small file).
      this._flushHeader();
    }
    callback();
  }

  _flushHeader() {
    const combined = Buffer.concat(this._chunks, this._bufferedBytes);
    this._chunks = [];
    this._headerEmitted = true;
    this.push(combined);
    this.emit("header", combined.subarray(0, Math.min(combined.length, this.sniffLength)));
  }
}

module.exports = { HeaderSniffer };
