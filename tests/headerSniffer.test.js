require("./helpers/testEnv");
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { Readable, PassThrough } = require("stream");

const { HeaderSniffer } = require("../app/utils/headerSniffer");

// Mirrors real usage in uploadParser.service.js: no consumer is attached to
// the sniffer until the 'header' event fires.
async function sniff(chunks, sniffLength) {
  const src = Readable.from(chunks.map((c) => Buffer.from(c)));
  const sniffer = new HeaderSniffer({ sniffLength });
  const sink = new PassThrough();
  const collected = [];
  sink.on("data", (d) => collected.push(d));

  const headerPromise = new Promise((resolve) => sniffer.once("header", resolve));
  src.pipe(sniffer);
  const header = await headerPromise;
  sniffer.pipe(sink);

  await new Promise((resolve, reject) => {
    sink.on("end", resolve);
    sink.on("error", reject);
  });

  return { header, full: Buffer.concat(collected) };
}

describe("HeaderSniffer", () => {
  test("emits the first N bytes as a header and forwards all bytes downstream unchanged", async () => {
    const chunks = ["hello ", "world this is a longer stream of bytes ", "more padding padding"];
    const { header, full } = await sniff(chunks, 8);
    assert.equal(header.toString(), "hello wo");
    assert.deepEqual(full, Buffer.concat(chunks.map((c) => Buffer.from(c))));
  });

  test("handles a file smaller than sniffLength", async () => {
    const { header, full } = await sniff(["hi"], 64);
    assert.equal(header.toString(), "hi");
    assert.equal(full.toString(), "hi");
  });

  test("handles an exact boundary split across chunks", async () => {
    const { header, full } = await sniff(["abcd", "efgh"], 8);
    assert.equal(header.toString(), "abcdefgh");
    assert.equal(full.toString(), "abcdefgh");
  });
});
