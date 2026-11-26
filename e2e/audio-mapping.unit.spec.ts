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
import {
  buildSectionsFromBeatGrid,
  buildSectionSchedule,
  decodeStemWav,
  fetchSuccessfulJobAudio,
  type BackendJob,
  type BeatGrid,
} from "../src/lib/backendSeparationClient";

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

test("backend PCM WAV stems preserve source rate, channels, and exact frames", () => {
  const samples = [8192, -8192, 16384, -16384];
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const put = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  put(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, 48_000, true);
  view.setUint32(28, 48_000 * 2 * 2, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); put(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  expect(decodeStemWav(bytes, { name: "drums", sampleRate: 48_000, channels: 2, frames: 2 }).map((channel) => [...channel]))
    .toEqual([[0.25, 0.5], [-0.25, -0.5]]);
  expect(() => decodeStemWav(bytes, { name: "drums", sampleRate: 44_100, channels: 2, frames: 2 })).toThrow();
});

test("full-stem backend beat-grid slicing uses identical integer frame boundaries", () => {
  const stemNames = ["drums", "bass", "other", "vocals"] as const;
  const stems = Object.fromEntries(stemNames.map((name) => [name, [Float32Array.from({ length: 10 }, (_, index) => index)]])) as Record<typeof stemNames[number], Float32Array[]>;
  const grid: BeatGrid = {
    schemaVersion: 1,
    jobId: "job-1",
    projectId: "project-1",
    audio: {
      sampleRate: 10, channels: 1, frames: 10, durationSeconds: 1,
      samplePositionUnit: "frames",
      stems: { drums: "/d", bass: "/b", other: "/o", vocals: "/v" },
    },
    analysis: {
      engine: "beat-this-rs", engineVersion: "1", modelVersion: "full", inputStem: "drums",
      bpm: 120, beatsPerBar: 4, beats: [],
      downbeats: [2, 5, 8].map((samplePosition, index) => ({ samplePosition, timeSeconds: samplePosition / 10, bar: index + 1 })),
      metadata: null,
    },
  };
  const sections = buildSectionsFromBeatGrid("job-1", grid, stems, "1bar");
  expect(sections).toHaveLength(4);
  expect(buildSectionSchedule("job-1", 10, 10, [], [2, 5, 8])).toHaveLength(2);
  expect(sections.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([[0, 2], [2, 5], [5, 8], [8, 10]]);
  for (const section of sections) {
    expect(section.endSample - section.startSample).toBe(section.stems.drums[0].length);
    for (const stem of stemNames) {
      expect(section.stems[stem][0].length).toBe(section.endSample - section.startSample);
      expect([...section.stems[stem][0]]).toEqual([...section.stems.drums[0]]);
    }
  }
});

test("segment sizes group the same integer downbeat intervals and preserve a partial final bar", () => {
  const downbeats = [200, 400, 600, 800];
  const schedule = (size: "1bar" | "2bars" | "4bars") =>
    buildSectionSchedule("test", 1_000, 1_000, [], downbeats, size, 4);

  const oneBar = schedule("1bar");
  const twoBars = schedule("2bars");
  const fourBars = schedule("4bars");
  expect(oneBar.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([
    [0, 200], [200, 400], [400, 600], [600, 800], [800, 1_000],
  ]);
  expect(twoBars.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([
    [0, 200], [200, 600], [600, 1_000],
  ]);
  expect(fourBars.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([
    [0, 200], [200, 1_000],
  ]);
  const finalBar = oneBar.at(-1);
  expect(finalBar?.endSample).toBe(1_000);
  expect(finalBar ? finalBar.endSample - finalBar.startSample : 0).toBe(200);
  for (const sections of [oneBar, twoBars, fourBars]) {
    expect(sections[0].startSample).toBe(0);
    expect(sections.at(-1)?.endSample).toBe(1_000);
    for (let index = 1; index < sections.length; index++) {
      expect(sections[index].startSample).toBe(sections[index - 1].endSample);
    }
  }
});

test("irregular or missing downbeats are used as supplied without inventing rounded boundaries", () => {
  const sections = buildSectionSchedule("test", 48_000, 600_000, [], [0, 192_000, 576_000], "1bar", 4);
  expect(sections.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([
    [0, 192_000], [192_000, 576_000], [576_000, 600_000],
  ]);
  expect(sections.every((section) => section.startTime === section.startSample / 48_000 &&
    section.endTime === section.endSample / 48_000)).toBe(true);

  const beatFrames = Array.from({ length: 9 }, (_, index) => index * 48_000);
  const recovered = buildSectionSchedule("test", 48_000, 432_000, beatFrames, [0, 384_000], "1bar", 4);
  expect(recovered.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([
    [0, 192_000], [192_000, 384_000], [384_000, 432_000],
  ]);
});

test("one beat segmentation uses beat frame positions and keeps an incomplete final beat", () => {
  const sections = buildSectionSchedule("test", 1_000, 1_000, [0, 125, 250, 375, 500, 625, 750], [], "beat", 4);
  expect(sections.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([
    [0, 125], [125, 250], [250, 375], [375, 500], [500, 625], [625, 750], [750, 1_000],
  ]);
});

test("successful job loads analysisUrl and project stem URLs without requesting chunks", async () => {
  const projectId = "project-1";
  const jobId = "job-1";
  const stemNames = ["drums", "bass", "other", "vocals"] as const;
  const stemUrls = Object.fromEntries(stemNames.map((stem) => [stem, `/api/v1/projects/${projectId}/stems/${stem}`])) as Record<typeof stemNames[number], string>;
  const grid: BeatGrid = {
    schemaVersion: 1, jobId, projectId,
    audio: { sampleRate: 48_000, channels: 1, frames: 8, durationSeconds: 8 / 48_000, samplePositionUnit: "frames", stems: stemUrls },
    analysis: {
      engine: "beat-this-rs", engineVersion: "1", modelVersion: null, inputStem: "drums", bpm: 120, beatsPerBar: 4,
      beats: [{ timeSeconds: 0, samplePosition: 0 }],
      downbeats: [{ timeSeconds: 0, samplePosition: 0 }, { timeSeconds: 4 / 48_000, samplePosition: 4 }], metadata: null,
    },
  };
  const job: BackendJob = {
    id: jobId, project_id: projectId, status: "SUCCEEDED", progress: 100, error_message: null,
    result_metadata: {
      projectId,
      analysisUrl: `/api/v1/jobs/${jobId}/analysis`,
      stems: Object.fromEntries(stemNames.map((stem) => [stem, { url: stemUrls[stem], sampleRate: 48_000, channels: 1, frames: 8 }])),
    },
  };
  const wav = new ArrayBuffer(44 + 8 * 2);
  const view = new DataView(wav);
  const put = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  put(0, "RIFF"); view.setUint32(4, wav.byteLength - 8, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true); view.setUint32(28, 96_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, "data"); view.setUint32(40, 16, true);
  for (let index = 0; index < 8; index++) view.setInt16(44 + index * 2, index * 100, true);
  const project = {
    project: { id: projectId },
    stems: stemNames.map((name) => ({ name, audioUrl: stemUrls[name], sampleRate: 48_000, channels: 1, frames: 8, durationSeconds: 8 / 48_000, fileSizeBytes: wav.byteLength })),
  };
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === `/api/v1/projects/${projectId}`) return Response.json(project);
    if (path === `/api/v1/jobs/${jobId}/analysis`) return Response.json(grid);
    if (Object.values(stemUrls).includes(path)) return new Response(wav.slice(0), { headers: { "Content-Type": "audio/wav" } });
    return new Response("Not found", { status: 404 });
  };

  const loaded = await fetchSuccessfulJobAudio(job, fetcher, undefined, "1bar");
  expect(loaded.grid).toEqual(grid);
  expect(loaded.sections.map(({ startSample, endSample }) => [startSample, endSample])).toEqual([[0, 4], [4, 8]]);
  expect(requests).toContain(`/api/v1/jobs/${jobId}/analysis`);
  for (const url of Object.values(stemUrls)) expect(requests).toContain(url);
  expect(requests.sort()).toEqual([
    `/api/v1/jobs/${jobId}/analysis`,
    `/api/v1/projects/${projectId}`,
    ...Object.values(stemUrls),
  ].sort());
});
