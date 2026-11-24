
export type StemName = "vocals" | "drums" | "bass" | "other";

export type StemAudio = {
  name: StemName;
  channels: Float32Array[];
};

export type BarBoundary = {
  time: number;
  confidence?: number;
};

export type MusicalChunk = {
  id: string;
  barNumber: number;
  startTime: number;
  endTime: number;
  startSample: number;
  endSample: number;
  duration: number;
  kind: "bar" | "pickup";
  confidence: number;
};

export type StemChunk = {
  stem: StemName;
  chunkId: string;
  channels: Float32Array[];
  startSample: number;
  endSample: number;
};

export type ChunkGroup = {
  id: string;
  startBar: number;
  endBar: number;
  chunkIds: string[];
  startTime: number;
  endTime: number;
};

export type SeparationSection = {
  id: string;
  index: number;
  startBar: number;
  endBar: number;
  startTime: number;
  endTime: number;

  // Exact musical region to retain in the final output.
  startSample: number;
  endSample: number;

  // Larger source region sent to SCNet for context.
  processStartSample: number;
  processEndSample: number;

  // Where the exact region begins inside the processed result.
  trimStartSample: number;
  trimEndSample: number;

  duration: number;
  chunkIds: string[];
  kind: "bars" | "pickup";
};

export type QuantizationResult = {
  onsetTime: number;
  nearestBeatTime: number;
  deviationMs: number;
  status: "aligned" | "early" | "late";
};

const EPSILON = 1e-6;

const STEM_NAMES: StemName[] = [
  "vocals",
  "drums",
  "bass",
  "other",
];

/**
 * Creates one-bar chunks from detected downbeat boundaries.
 *
 * Boundaries are expressed in seconds relative to the
 * beginning of the original audio.
 */
export function createBarChunks(
  duration: number,
  sampleRate: number,
  boundaries: BarBoundary[],
): MusicalChunk[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Invalid audio duration.");
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Invalid sample rate.");
  }

  if (!boundaries.length) {
    throw new Error("No downbeat boundaries were provided.");
  }

  const sorted = boundaries
    .filter(
      (item) =>
        Number.isFinite(item.time) &&
        item.time >= 0 &&
        item.time < duration,
    )
    .slice()
    .sort((a, b) => a.time - b.time);

  // Remove duplicate boundaries.
  const unique: BarBoundary[] = [];

  for (const boundary of sorted) {
    const previous = unique[unique.length - 1];

    if (
      previous &&
      Math.abs(previous.time - boundary.time) < EPSILON
    ) {
      previous.confidence = Math.max(
        previous.confidence ?? 0,
        boundary.confidence ?? 0,
      );
      continue;
    }

    unique.push({ ...boundary });
  }

  if (!unique.length) {
    throw new Error("No valid downbeat boundaries were detected.");
  }

  const chunks: MusicalChunk[] = [];

  // Preserve audio before the first detected downbeat.
  if (unique[0].time > EPSILON) {
    const endSample = Math.round(
      unique[0].time * sampleRate,
    );

    chunks.push({
      id: "pickup",
      barNumber: 0,
      startTime: 0,
      endTime: endSample / sampleRate,
      startSample: 0,
      endSample,
      duration: endSample / sampleRate,
      kind: "pickup",
      confidence: 1,
    });
  }

  for (let i = 0; i < unique.length; i++) {
    const start = unique[i];
    const rawEndTime = unique[i + 1]?.time ?? duration;

    if (rawEndTime <= start.time) continue;

    const startSample = Math.max(
      0,
      Math.round(start.time * sampleRate),
    );

    const endSample = Math.min(
      Math.round(duration * sampleRate),
      Math.round(rawEndTime * sampleRate),
    );

    if (endSample <= startSample) continue;

    const startTime = startSample / sampleRate;
    const endTime = endSample / sampleRate;

    chunks.push({
      id: `bar-${i + 1}`,
      barNumber: i + 1,
      startTime,
      endTime,
      startSample,
      endSample,
      duration: endTime - startTime,
      kind: "bar",
      confidence: start.confidence ?? 0,
    });
  }

  return chunks;
}

/**
 * Groups adjacent bars into musical phrases.
 */
export function groupBars(
  chunks: MusicalChunk[],
  barsPerGroup: 1 | 2 | 4 | 8,
): ChunkGroup[] {
  if (!chunks.length) return [];

  const bars = chunks.filter(
    (chunk) => chunk.kind === "bar",
  );

  const groups: ChunkGroup[] = [];

  for (let i = 0; i < bars.length; i += barsPerGroup) {
    const selected = bars.slice(i, i + barsPerGroup);

    if (!selected.length) continue;

    const first = selected[0];
    const last = selected[selected.length - 1];

    groups.push({
      id: `phrase-${groups.length + 1}`,
      startBar: first.barNumber,
      endBar: last.barNumber,
      chunkIds: selected.map((chunk) => chunk.id),
      startTime: first.startTime,
      endTime: last.endTime,
    });
  }

  return groups;
}

/**
 * Creates processing sections from musical chunks.
 *
 * Each section contains a core region and optional overlap
 * around its edges. The overlap gives the model extra context.
 *
 * Only the core region should be placed in the arrangement.
 */
export function createSeparationSections(
  chunks: MusicalChunk[],
  sampleRate: number,
  barsPerSection: 1 | 2 | 4 | 8 = 4,
  overlapSeconds = 1,
): SeparationSection[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Invalid sample rate.");
  }

  if (
    !Number.isFinite(overlapSeconds) ||
    overlapSeconds < 0
  ) {
    throw new Error("Invalid overlap duration.");
  }

  if (!chunks.length) return [];

  const overlapSamples = Math.round(
    overlapSeconds * sampleRate,
  );

  const sections: SeparationSection[] = [];

  // Keep any intro/pickup as its own section.
  const pickup = chunks.find(
    (chunk) => chunk.kind === "pickup",
  );

  if (pickup) {
    sections.push({
      id: "section-pickup",
      index: 0,
      startBar: 0,
      endBar: 0,
      startTime: pickup.startTime,
      endTime: pickup.endTime,
      startSample: pickup.startSample,
      endSample: pickup.endSample,
      processStartSample: Math.max(
        0,
        pickup.startSample - overlapSamples,
      ),
      processEndSample: pickup.endSample + overlapSamples,
      trimStartSample:
        pickup.startSample -
        Math.max(0, pickup.startSample - overlapSamples),
      trimEndSample:
        pickup.endSample -
        Math.max(0, pickup.startSample - overlapSamples),
      duration: pickup.duration,
      chunkIds: [pickup.id],
      kind: "pickup",
    });
  }

  const bars = chunks
    .filter((chunk) => chunk.kind === "bar")
    .sort((a, b) => a.barNumber - b.barNumber);

  for (
    let i = 0;
    i < bars.length;
    i += barsPerSection
  ) {
    const selected = bars.slice(i, i + barsPerSection);

    if (!selected.length) continue;

    const first = selected[0];
    const last = selected[selected.length - 1];

    const startSample = first.startSample;
    const endSample = last.endSample;

    const processStartSample = Math.max(
      0,
      startSample - overlapSamples,
    );

    const processEndSample =
      endSample + overlapSamples;

    sections.push({
      id: `section-${sections.length + 1}`,
      index: sections.length,
      startBar: first.barNumber,
      endBar: last.barNumber,
      startTime: first.startTime,
      endTime: last.endTime,
      startSample,
      endSample,
      processStartSample,
      processEndSample,
      trimStartSample:
        startSample - processStartSample,
      trimEndSample:
        endSample - processStartSample,
      duration: last.endTime - first.startTime,
      chunkIds: selected.map((chunk) => chunk.id),
      kind: "bars",
    });
  }

  return sections;
}

/**
 * Creates synchronized references into each separated stem.
 * No audio data is copied.
 */
export function createStemChunks(
  stems: StemAudio[],
  chunks: MusicalChunk[],
): StemChunk[] {
  const output: StemChunk[] = [];

  for (const stem of stems) {
    for (const chunk of chunks) {
      const channels = stem.channels.map((channel) =>
        channel.subarray(
          chunk.startSample,
          Math.min(chunk.endSample, channel.length),
        ),
      );

      output.push({
        stem: stem.name,
        chunkId: chunk.id,
        channels,
        startSample: chunk.startSample,
        endSample: chunk.endSample,
      });
    }
  }

  return output;
}

/**
 * Creates a typed stem map from a separation result.
 */
export function normalizeStems(
  stems: Record<string, Float32Array[]>,
): StemAudio[] {
  return STEM_NAMES.map((name) => {
    const channels = stems[name];

    if (!channels?.length) {
      throw new Error(
        `Missing "${name}" stem in separation result.`,
      );
    }

    return {
      name,
      channels,
    };
  });
}

/**
 * Checks detected onsets against a beat grid.
 * Does not move or modify audio.
 */
export function checkDrumQuantization(
  onsets: number[],
  beatTimes: number[],
  toleranceMs = 35,
): QuantizationResult[] {
  if (!beatTimes.length) return [];

  const sortedBeats = [...beatTimes].sort(
    (a, b) => a - b,
  );

  return onsets.map((onsetTime) => {
    let nearest = sortedBeats[0];

    for (const beat of sortedBeats) {
      if (
        Math.abs(beat - onsetTime) <
        Math.abs(nearest - onsetTime)
      ) {
        nearest = beat;
      }
    }

    const differenceMs =
      (onsetTime - nearest) * 1000;

    return {
      onsetTime,
      nearestBeatTime: nearest,
      deviationMs: differenceMs,
      status:
        Math.abs(differenceMs) <= toleranceMs
          ? "aligned"
          : differenceMs < 0
            ? "early"
            : "late",
    };
  });
}
