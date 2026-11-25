import { expect, test } from "@playwright/test";

import {
  mapTimelineToClipSource,
  sourceRangeMatchesTimeline,
} from "../src/features/audio-engine/sourceMapping";
import {
  getTransportSnapshot,
  publishTransportFrame,
  resetTransport,
  subscribeTransport,
  subscribeTransportFrames,
  updateTransport,
} from "../src/stores/transport.store";
import { decodeFloatWav, sha256Hex } from "../src/lib/backendSeparationClient";

test("timeline-to-buffer mapping uses clip source origin and buffer sample rate at 1x", () => {
  const mapping = mapTimelineToClipSource({
    timelinePosition: 12.5,
    clipStartTime: 10,
    sourceStartSample: 48_000,
    bufferSampleRate: 48_000,
    bufferLength: 192_000,
  });
  expect(mapping).toEqual({
    sourceOffsetSamples: 168_000,
    sourceOffsetSeconds: 3.5,
  });
});

test("split clip mapping begins at the split source frame and handles rate conversion", () => {
  const mapping = mapTimelineToClipSource({
    timelinePosition: 5.25,
    clipStartTime: 5,
    sourceStartSample: 22_050,
    bufferSampleRate: 44_100,
    bufferLength: 88_200,
  });
  expect(mapping).toEqual({
    sourceOffsetSamples: 33_075,
    sourceOffsetSeconds: 0.75,
  });
});

test("source range duration must match timeline within one buffer sample", () => {
  expect(sourceRangeMatchesTimeline(0, 48_000, 0, 1, 48_000)).toBe(true);
  expect(sourceRangeMatchesTimeline(0, 47_000, 0, 1, 48_000)).toBe(false);
  expect(sourceRangeMatchesTimeline(100, 50, 0, 1, 48_000)).toBe(false);
});

test("visual frame ticks do not broadcast full transport state", () => {
  resetTransport();
  let transportNotifications = 0;
  let frameNotifications = 0;
  const stopTransport = subscribeTransport(() => transportNotifications++);
  const stopFrames = subscribeTransportFrames(() => frameNotifications++);
  updateTransport({ isPlaying: true, currentTime: 3 });
  const fullStateNotifications = transportNotifications;
  publishTransportFrame(3.016);
  publishTransportFrame(3.032);
  expect(transportNotifications).toBe(fullStateNotifications);
  expect(frameNotifications).toBe(3);
  expect(getTransportSnapshot().currentTime).toBe(3.032);
  stopTransport();
  stopFrames();
  resetTransport();
});

test("backend float WAV chunks preserve source rate, channels, and exact frames", () => {
  const samples = [0.25, -0.25, 0.5, -0.5];
  const bytes = new ArrayBuffer(44 + samples.length * 4);
  const view = new DataView(bytes);
  const put = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  put(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, 2, true); view.setUint32(24, 48_000, true);
  view.setUint32(28, 48_000 * 2 * 4, true); view.setUint16(32, 8, true);
  view.setUint16(34, 32, true); put(36, "data"); view.setUint32(40, samples.length * 4, true);
  samples.forEach((sample, index) => view.setFloat32(44 + index * 4, sample, true));
  const descriptor = { url: "/chunk.wav", channels: 2, sample_rate: 48_000, frame_count: 2, audio_format: "wav" as const, sha256: "00".repeat(32), byte_length: bytes.byteLength };
  const chunk = {
    job_id: "job", chunk_id: "chunk", chunk_index: 0, bar_number: 1,
    start_seconds: 0, end_seconds: 2 / 48_000, duration_seconds: 2 / 48_000,
    source_sample_start: 0, source_sample_end: 2, sample_rate: 48_000,
    stems: { drums: descriptor, bass: descriptor, other: descriptor, vocals: descriptor }, status: "COMPLETED" as const,
  };
  expect(decodeFloatWav(bytes, "drums", chunk).map((channel) => [...channel]))
    .toEqual([[0.25, 0.5], [-0.25, -0.5]]);
  expect(() => decodeFloatWav(bytes, "drums", { ...chunk, sample_rate: 44_100 })).toThrow();
});

test("chunk SHA-256 uses the byte-level manifest checksum format", async () => {
  const bytes = new TextEncoder().encode("abc").buffer;
  await expect(sha256Hex(bytes)).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
