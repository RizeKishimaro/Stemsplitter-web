export type ClipSourceMappingInput = {
  timelinePosition: number;
  clipStartTime: number;
  sourceStartSample: number;
  bufferSampleRate: number;
  bufferLength: number;
};

export type ClipSourceMapping = {
  sourceOffsetSamples: number;
  sourceOffsetSeconds: number;
};

/**
 * Map a global timeline position into a section-local AudioBuffer coordinate.
 * `sourceStartSample` is the buffer frame corresponding to `clipStartTime`;
 * buffer-local frames are advanced using the buffer clock, never by changing
 * playback rate to compensate for a mismatched clip duration.
 */
export function mapTimelineToClipSource({
  timelinePosition,
  clipStartTime,
  sourceStartSample,
  bufferSampleRate,
  bufferLength,
}: ClipSourceMappingInput): ClipSourceMapping | null {
  if (![timelinePosition, clipStartTime, sourceStartSample, bufferSampleRate, bufferLength]
    .every(Number.isFinite) || bufferSampleRate <= 0 || bufferLength <= 0) {
    return null;
  }

  const sourceOffsetSamples = sourceStartSample +
    Math.max(0, timelinePosition - clipStartTime) * bufferSampleRate;
  if (sourceOffsetSamples < 0) return null;

  return {
    sourceOffsetSamples,
    sourceOffsetSeconds: sourceOffsetSamples / bufferSampleRate,
  };
}

/** Return true when source frames span the clip's timeline duration at 1×. */
export function sourceRangeMatchesTimeline(
  sourceStartSample: number,
  sourceEndSample: number,
  timelineStart: number,
  timelineEnd: number,
  sampleRate: number,
): boolean {
  if (![sourceStartSample, sourceEndSample, timelineStart, timelineEnd, sampleRate]
    .every(Number.isFinite) || sampleRate <= 0) {
    return false;
  }
  const sourceDuration = (sourceEndSample - sourceStartSample) / sampleRate;
  const timelineDuration = timelineEnd - timelineStart;
  return sourceEndSample > sourceStartSample && timelineDuration > 0 &&
    Math.abs(sourceDuration - timelineDuration) <= 1 / sampleRate;
}
