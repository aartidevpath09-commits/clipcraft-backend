/**
 * Must be required FIRST, before any app/* module, in every test file.
 * Points the media storage root at an isolated temp directory so tests
 * never read/write the developer's real storage/ folder, then loads .env
 * for DB connection settings (dotenv does not override already-set vars,
 * so MEDIA_STORAGE_ROOT below always wins).
 *
 * Sprint 2: suffixed with process.pid. `node --test` runs each test *file*
 * as its own child process, and with more than one file doing real
 * upload/delete I/O (as of Sprint 2's tests/mediaResolver.test.js and
 * tests/projectMedia.test.js alongside Sprint 1's tests/api.test.js), a
 * single shared literal directory across all of them let two processes
 * race on the same files. On Windows that surfaces as an EBUSY on unlink
 * (Windows won't remove a file another handle still has open, unlike
 * POSIX); on Linux/macOS the same race is usually silent. Giving every
 * process its own root removes the shared state entirely, so the race
 * can't happen regardless of how many test files run concurrently.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");

const TEST_STORAGE_ROOT = path.join(os.tmpdir(), `clipcraft-media-test-storage-${process.pid}`);
fs.mkdirSync(TEST_STORAGE_ROOT, { recursive: true });

process.env.MEDIA_STORAGE_ROOT = TEST_STORAGE_ROOT;

require("dotenv").config();

module.exports = { TEST_STORAGE_ROOT };
