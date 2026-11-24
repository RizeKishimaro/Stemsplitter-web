import type { AnalysisResult } from "../audio-analysis/analysisClient";

import {
  createBarChunks,
  createSeparationSections,
  type BarBoundary,
  type MusicalChunk,
  type SeparationSection,
  type StemName,
} from "./chunkEngine";
import type { SeparatedSection } from "./separationScheduler";

export type SeparationPlan = {
  bars: MusicalChunk[];
  sections: SeparationSection[];
  totalSections: number;
  duration: number;
  sampleRate: number;
};

export function buildSeparationPlan(
  analysis: AnalysisResult,
  sampleRate: number,
  barsPerSection: 1 | 2 | 4 | 8 = 4,
  overlapSeconds = 1,
): SeparationPlan {
  if (!analysis.downbeats.length) {
    throw new Error("No downbeats available to create separation sections.");
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Invalid audio sample rate.");
  }

  const boundaries: BarBoundary[] = analysis.bars.map((bar) => ({
    number: bar.number,
    time: bar.start,
  }));

  const bars = createBarChunks(
    analysis.duration,
    sampleRate,
    boundaries,
  );

  const sections = createSeparationSections(
    bars,
    sampleRate,
    barsPerSection,
    overlapSeconds,
  );

  if (!sections.length) {
    throw new Error("No separation sections were generated.");
  }

  return {
    bars,
    sections,
    totalSections: sections.length,
    duration: analysis.duration,
    sampleRate,
  };
}

/**
 * Recut already separated PCM against the drums-derived master grid.
 * Source data is copied by its original sample offsets, never by per-stem
 * durations or independently calculated musical positions.
 */
export function assembleMasterTimelineSections(
  sourceSections: SeparatedSection[],
  targetSections: SeparationSection[],
  sampleRate: number,
): SeparatedSection[] {
  if (!sourceSections.length || !targetSections.length) {
    throw new Error("Cannot assemble an empty master timeline.");
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Invalid master timeline sample rate.");
  }

  const orderedSources = sourceSections.slice().sort(
    (a, b) => a.startSample - b.startSample,
  );
  const stemNames: StemName[] = ["drums", "bass", "other", "vocals"];

  // The targets are the single authoritative schedule (built from drum
  // analysis). Reject malformed schedules before copying PCM so a gap,
  // duplicate ID, independently rounded time, or short final range cannot
  // silently turn into a different clip timeline.
  const ids = new Set<string>();
  let previousEndSample: number | undefined;
  targetSections.forEach((target, index) => {
    if (ids.has(target.id)) {
      throw new Error(`Duplicate master section ID ${target.id}.`);
    }
    ids.add(target.id);
    if (target.index !== index) {
      throw new Error(`Invalid master section index for ${target.id}.`);
    }
    if (previousEndSample !== undefined && target.startSample !== previousEndSample) {
      throw new Error(`Gap or overlap in master section schedule at ${target.id}.`);
    }
    if (target.startTime !== target.startSample / sampleRate ||
      target.endTime !== target.endSample / sampleRate) {
      throw new Error(`Master section times do not map to samples in ${target.id}.`);
    }
    if (target.endSample <= target.startSample) {
      throw new Error(`Invalid target sample range in ${target.id}.`);
    }
    previousEndSample = target.endSample;
  });

  for (const source of orderedSources) {
    if (source.sampleRate !== sampleRate ||
      source.endSample - source.startSample <= 0 ||
      source.startTime !== source.startSample / sampleRate ||
      source.endTime !== source.endSample / sampleRate) {
      throw new Error(`Invalid source sample range in ${source.id}.`);
    }
    for (const stem of stemNames) {
      const channels = source.stems[stem];
      if (!channels?.length || channels.some(
        (channel) => channel.length !== source.endSample - source.startSample,
      )) {
        throw new Error(`Invalid ${stem} sample range in ${source.id}.`);
      }
    }
  }

  return targetSections.map((target) => {
    const frameCount = target.endSample - target.startSample;
    if (frameCount <= 0) {
      throw new Error(`Invalid target sample range in ${target.id}.`);
    }

    const intersections = orderedSources
      .map((source) => ({
        source,
        start: Math.max(target.startSample, source.startSample),
        end: Math.min(target.endSample, source.endSample),
      }))
      .filter((range) => range.end > range.start);

    let nextSample = target.startSample;
    for (const range of intersections) {
      if (range.start !== nextSample) {
        throw new Error(
          `Gap or overlap in source samples before ${range.start} for ${target.id}.`,
        );
      }
      nextSample = range.end;
    }
    if (nextSample !== target.endSample) {
      throw new Error(`Source samples do not cover ${target.id}.`);
    }

    const stems = {} as Record<StemName, Float32Array[]>;
    for (const stem of stemNames) {
      const firstChannels = orderedSources[0]?.stems[stem];
      if (!firstChannels?.length) {
        throw new Error(`No separated ${stem} samples are available.`);
      }
      if (orderedSources.some((source) => source.stems[stem].length !== firstChannels.length)) {
        throw new Error(`Inconsistent channel count for ${stem} across source sections.`);
      }

      stems[stem] = Array.from(
        { length: firstChannels.length },
        () => new Float32Array(frameCount),
      );

      for (const { source, start, end } of intersections) {
        const sourceChannels = source.stems[stem];
        if (!sourceChannels?.length) {
          throw new Error(`Section ${source.id} is missing ${stem}.`);
        }
        for (let channel = 0; channel < stems[stem].length; channel++) {
          const sourceChannel = sourceChannels[channel];
          if (!sourceChannel) throw new Error(`Missing ${stem} channel ${channel} in ${source.id}.`);
          const sourceOffset = start - source.startSample;
          const targetOffset = start - target.startSample;
          stems[stem][channel].set(
            sourceChannel.subarray(sourceOffset, sourceOffset + end - start),
            targetOffset,
          );
        }
      }
    }

    return {
      id: target.id,
      index: target.index,
      startBar: target.startBar,
      endBar: target.endBar,
      startTime: target.startSample / sampleRate,
      endTime: target.endSample / sampleRate,
      startSample: target.startSample,
      endSample: target.endSample,
      sampleRate,
      stems,
    };
  });
}
