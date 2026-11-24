import { expect, test } from "@playwright/test";

import {
  mapTimelineToClipSource,
  sourceRangeMatchesTimeline,
} from "../src/features/audio-engine/sourceMapping";

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
