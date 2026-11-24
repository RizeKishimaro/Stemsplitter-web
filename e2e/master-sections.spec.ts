import { expect, test } from "@playwright/test";

import type { SeparationSection, StemName } from "../src/features/stem-separation/chunkEngine";
import { assembleMasterTimelineSections } from "../src/features/stem-separation/separationPlan";
import type { SeparatedSection } from "../src/features/stem-separation/separationScheduler";
import { getClipState, registerSectionClips, resetClips } from "../src/stores/clip.store";

const sampleRate = 10;
const stems: StemName[] = ["drums", "bass", "other", "vocals"];

function section(id: string, index: number, startSample: number, endSample: number): SeparationSection {
  return {
    id, index, startBar: index * 2 + 1, endBar: index * 2 + 2,
    startSample, endSample,
    startTime: startSample / sampleRate, endTime: endSample / sampleRate,
    processStartSample: startSample, processEndSample: endSample,
    trimStartSample: 0, trimEndSample: endSample - startSample,
    duration: (endSample - startSample) / sampleRate,
    chunkIds: [id], kind: "bars",
  };
}

function separated(id: string, index: number, startSample: number, endSample: number): SeparatedSection {
  const frames = endSample - startSample;
  const audio = Object.fromEntries(stems.map((stem, stemIndex) => [stem, [
    Float32Array.from({ length: frames }, (_, frame) => startSample + frame + stemIndex / 10),
    Float32Array.from({ length: frames }, (_, frame) => startSample + frame + stemIndex / 10 + 0.01),
  ]])) as Record<StemName, Float32Array[]>;
  return {
    id, index, startBar: index * 2 + 1, endBar: index * 2 + 2,
    startSample, endSample,
    startTime: startSample / sampleRate, endTime: endSample / sampleRate,
    sampleRate, stems: audio,
  };
}

test("drum master boundaries recut every stereo stem, including a partial final section", () => {
  const output = assembleMasterTimelineSections(
    [separated("source-a", 0, 0, 5), separated("source-b", 1, 5, 10)],
    [section("master-0", 0, 0, 3), section("master-1", 1, 3, 8), section("master-2", 2, 8, 10)],
    sampleRate,
  );

  expect(output.map(({ id, index, startSample, endSample }) => ({ id, index, startSample, endSample }))).toEqual([
    { id: "master-0", index: 0, startSample: 0, endSample: 3 },
    { id: "master-1", index: 1, startSample: 3, endSample: 8 },
    { id: "master-2", index: 2, startSample: 8, endSample: 10 },
  ]);
  for (const result of output) {
    expect(result.startTime).toBe(result.startSample / sampleRate);
    expect(result.endTime).toBe(result.endSample / sampleRate);
    for (const stem of stems) {
      expect(result.stems[stem]).toHaveLength(2);
      expect(result.stems[stem].every((channel) => channel.length === result.endSample - result.startSample)).toBe(true);
      expect(result.stems[stem][0][0]).toBe(Math.fround(result.startSample + stems.indexOf(stem) / 10));
    }
  }
  expect(output.at(-1)?.endSample - output.at(-1)!.startSample).toBe(2);
});

test("master schedule rejects gaps and source sections with inconsistent stereo lengths", () => {
  expect(() => assembleMasterTimelineSections(
    [separated("source", 0, 0, 10)],
    [section("master-0", 0, 0, 3), section("master-1", 1, 4, 10)],
    sampleRate,
  )).toThrow(/Gap or overlap in master section schedule/);

  const invalid = separated("source", 0, 0, 10);
  invalid.stems.vocals[1] = new Float32Array(9);
  expect(() => assembleMasterTimelineSections(
    [invalid], [section("master-0", 0, 0, 10)], sampleRate,
  )).toThrow(/Invalid vocals sample range/);
});

test("master schedule rejects duplicate IDs and inconsistent output channel counts", () => {
  expect(() => assembleMasterTimelineSections(
    [separated("source", 0, 0, 10)],
    [section("same", 0, 0, 5), section("same", 1, 5, 10)],
    sampleRate,
  )).toThrow(/Duplicate master section ID/);

  const second = separated("source-b", 1, 5, 10);
  second.stems.other = [second.stems.other[0]];
  expect(() => assembleMasterTimelineSections(
    [separated("source-a", 0, 0, 5), second],
    [section("master", 0, 0, 10)],
    sampleRate,
  )).toThrow(/Inconsistent channel count for other/);
});

test("section registration is idempotent and registers four clips on identical boundaries", () => {
  resetClips();
  const result = assembleMasterTimelineSections(
    [separated("source", 0, 0, 10)],
    [section("master-section", 0, 2, 7)],
    sampleRate,
  )[0];

  registerSectionClips(result);
  registerSectionClips(result);
  const registered = Object.values(getClipState().clips);
  expect(registered).toHaveLength(4);
  expect(registered.map((clip) => clip.sectionId)).toEqual(Array(4).fill("master-section"));
  expect(registered.every((clip) => clip.startTime === 0.2 && clip.endTime === 0.7)).toBe(true);
  expect(registered.every((clip) => clip.sourceStartSample === 0 && clip.sourceEndSample === 5)).toBe(true);
  resetClips();
});
