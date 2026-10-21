import assert from "node:assert/strict";
import test from "node:test";
import { finiteDuration, seekTarget } from "../src/lib/playback-time.ts";
import { makeSeekableWebm } from "../src/lib/seekable-webm.ts";
import EBML from "ts-ebml/dist/EBML.js";

const { Decoder } = EBML;
const bytes = (hex) => Buffer.from(hex, "hex");
function element(id, data) {
  let sizeBytes = 1;
  while (data.length >= 2 ** (7 * sizeBytes) - 1) sizeBytes++;
  const size = Buffer.alloc(sizeBytes);
  let value = data.length;
  for (let i = sizeBytes - 1; i >= 0; i--) {
    size[i] = value & 255;
    value = Math.floor(value / 256);
  }
  size[0] |= 1 << (8 - sizeBytes);
  return Buffer.concat([bytes(id), size, data]);
}
const master = (id, children) => element(id, Buffer.concat(children));

// Match Firefox's live layout: zero Duration, empty SeekHead, unknown-sized
// Segment/Clusters, video + audio, and a block crossing the decoder chunk boundary.
function liveWebm() {
  const header = master("1a45dfa3", [element("4282", Buffer.from("webm"))]);
  const info = master("1549a966", [
    element("2ad7b1", bytes("0f4240")),
    element("4489", Buffer.alloc(8)),
  ]);
  const tracks = master("1654ae6b", [
    master("ae", [
      element("d7", bytes("01")),
      element("83", bytes("01")),
      element("86", Buffer.from("V_VP8")),
      element("23e383", bytes("01fca055")),
    ]),
    master("ae", [
      element("d7", bytes("02")),
      element("83", bytes("02")),
      element("86", Buffer.from("A_OPUS")),
    ]),
  ]);
  const block = (track, time, large = false) => {
    const data = Buffer.alloc(large ? 1024 * 1024 + 50 : 16);
    data[0] = 0x80 | track;
    data.writeInt16BE(time, 1);
    data[3] = 0x80;
    return element("a3", data);
  };
  const cluster = (time, large) =>
    Buffer.concat([
      bytes("1f43b67501ffffffffffffff"),
      element("e7", time === 0 ? bytes("00") : bytes("03e8")),
      block(1, 0, large),
      block(2, 0),
      block(1, 33),
      block(2, 40),
    ]);
  const body = Buffer.concat([cluster(0, true), cluster(1000, false)]);
  const prefix = Buffer.concat([
    header,
    bytes("1853806701ffffffffffffff"),
    element("114d9b74", Buffer.alloc(0)),
    info,
    tracks,
  ]);
  return { blob: new Blob([prefix, body], { type: "video/webm;codecs=vp8,opus" }), body };
}

test("unknown/infinite duration never becomes a seek target", () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, 0, -1]) {
    assert.equal(finiteDuration(value), 0);
    assert.equal(seekTarget(10, value), null);
  }
  assert.equal(seekTarget(Infinity, 331), null);
  assert.equal(seekTarget(NaN, 331), null);
  assert.equal(seekTarget(-10, 331), 0);
  assert.equal(seekTarget(400, 331), 331);
  assert.equal(seekTarget(165.5, 331), 165.5);
});

test("rebuilds duration and correct cue offsets without changing encoded media", async () => {
  const { blob, body } = liveWebm();
  const repaired = await makeSeekableWebm(blob);
  assert.equal(repaired.type, blob.type);
  const output = Buffer.from(await repaired.arrayBuffer());
  const decoded = new Decoder().decode(
    output.buffer.slice(output.byteOffset, output.byteOffset + output.length),
  );
  const duration = decoded.find((e) => e.name === "Duration");
  assert.ok(Number.isFinite(duration.value) && duration.value > 1000);
  const segment = decoded.find((e) => e.name === "Segment");
  const clusters = decoded.filter((e) => e.name === "Cluster" && !e.isEnd);
  const cues = decoded.filter((e) => e.name === "CueClusterPosition");
  assert.equal(cues.length, 2);
  assert.deepEqual(
    cues.map((e) => e.value + segment.dataStart),
    clusters.map((e) => e.tagStart),
  );
  assert.deepEqual(output.subarray(clusters[0].tagStart), body);
});

test("MP4 passes through unchanged", async () => {
  const blob = new Blob(["mp4"], { type: "video/mp4" });
  assert.equal(await makeSeekableWebm(blob), blob);
});

test("malformed WebM and cancellation reject instead of returning a fake repair", async () => {
  await assert.rejects(makeSeekableWebm(new Blob(["invalid"], { type: "video/webm" })));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(makeSeekableWebm(liveWebm().blob, controller.signal), {
    name: "AbortError",
  });
});
