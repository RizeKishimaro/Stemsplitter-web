

import { useCallback, useSyncExternalStore, type CSSProperties, type MouseEvent } from "react";

import {
  setTimelineMarkerPosition,
  type BeatSnapMode,
  type TimelineMarkerKind,
  useProjectStore,
  useProjectStoreSelector,
} from "../../../stores/project.store";
import { audioEngine } from "../../audio-engine/AudioEngine";

import {
  useClipStore,
  splitClip,
  linkClips,
  selectClip,
  canLinkClip,
  setClipLoop,
  type AudioClip,
} from "../../../stores/clip.store";

import {
  useTransportStore,
  getTransportFramePosition,
  subscribeTransportFrames,
  type TransportState,
} from "../../../stores/transport.store";

import type { TrackType } from "./TrackHeader";
import type { StemName } from "../../stem-separation/chunkEngine";
import { markArrangementRender } from "./arrangementMetrics";

import "./ArrangementGrid.css";

const TRACKS: TrackType[] = [
  "drums",
  "bass",
  "other",
  "vocals",
];

const TRACK_LABELS: Record<TrackType, string> = {
  drums: "DRUMS",
  bass: "BASS",
  other: "OTHER",
  vocals: "VOCALS",
};

const waveformCache = new WeakMap<Float32Array, Map<string, string>>();

function getWaveformPath(
  channel: Float32Array,
  width = 180,
  height = 44,
  samples = 90,
  rangeStart = 0,
  rangeEnd = channel.length,
): string {
  if (!channel.length || rangeEnd <= rangeStart) return "";
  const cacheKey = `${width}:${height}:${samples}:${rangeStart}:${rangeEnd}`;
  let paths = waveformCache.get(channel);
  if (!paths) {
    paths = new Map();
    waveformCache.set(channel, paths);
  }
  const cached = paths.get(cacheKey);
  if (cached) return cached;

  const center = height / 2;
  const step = (rangeEnd - rangeStart) / samples;
  const points: string[] = [];

  for (let i = 0; i < samples; i++) {
    const start = rangeStart + Math.floor(i * step);
    const end = Math.min(
      rangeEnd,
      Math.max(start + 1, rangeStart + Math.floor((i + 1) * step)),
    );

    let peak = 0;

    for (let j = start; j < end; j++) {
      peak = Math.max(peak, Math.abs(channel[j]));
    }

    const x = (i / samples) * width;
    const amplitude = Math.max(1, peak * center * 0.9);

    points.push(
      `M ${x.toFixed(2)} ${(center - amplitude).toFixed(2)}`,
      `L ${x.toFixed(2)} ${(center + amplitude).toFixed(2)}`,
    );
  }

  const path = points.join(" ");
  paths.set(cacheKey, path);
  return path;
}

/**
 * Individual clip controls.
 *
 * Every clip can play or pause independently.
 * Global pause/resume is handled by the main transport.
 */
function ClipControls({
  clip,
  transport,
}: {
  clip: AudioClip;
  transport: TransportState;
}) {
  const canLink = canLinkClip(clip.id);

  const isInPlaybackSession =
    transport.playingClipIds.includes(clip.id);

  const isPlaying =
    transport.isPlaying && isInPlaybackSession;

  const handlePlay = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    selectClip(clip.id);

    void audioEngine.toggleClip(clip.id);
  };

  const handleSplit = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    selectClip(clip.id);
    splitClip(clip.id);
  };

  const handleLink = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (canLink) {
      linkClips(clip.id);
    }
  };

  const handleLoop = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const enabled = !clip.loopEnabled;
    setClipLoop(clip.id, enabled);
    audioEngine.setClipLoop(clip.id, enabled);
  };

  return (
    <div
      className="arrangement-clip__controls"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`clip-control ${isInPlaybackSession ? "is-active" : ""}`}
        title={
          isPlaying
            ? "Pause this clip"
            : isInPlaybackSession
              ? "Remove clip from paused playback"
              : "Play this clip"
        }
        aria-label={
          isPlaying
            ? "Pause clip"
            : "Play clip"
        }
        aria-pressed={isInPlaybackSession}
        onClick={handlePlay}
      >
        {isPlaying ? "Ⅱ" : "▶"}
      </button>

      <button
        type="button"
        className="clip-control"
        title="Cut clip in half"
        aria-label="Cut clip in half"
        onClick={handleSplit}
      >
        <span className="clip-icon">✂</span>
      </button>

      <button
        type="button"
        className="clip-control"
        title={
          canLink
            ? "Link clips"
            : "Select a sibling clip to link"
        }
        aria-label="Link clips"
        disabled={!canLink}
        onClick={handleLink}
      >
        <span className="clip-icon">↔</span>
      </button>

      <button
        type="button"
        className={`clip-control ${clip.loopEnabled ? "is-active" : ""}`}
        title={
          clip.loopEnabled
            ? "Disable loop"
            : "Enable loop"
        }
        aria-label={
          clip.loopEnabled
            ? "Disable clip loop"
            : "Enable clip loop"
        }
        aria-pressed={clip.loopEnabled}
        onClick={handleLoop}
      >
        <span className="clip-icon">↻</span>
      </button>
    </div>
  );
}

/**
 * Calculate the playhead position inside an individual clip.
 *
 * The position always comes from the shared global transport clock.
 */
function useClipPlayheadProgress(clip: AudioClip, transport: TransportState) {
  const isInPlaybackSession =
    transport.playingClipIds.includes(clip.id);
  const clipDuration = clip.endTime - clip.startTime;
  const getSnapshot = useCallback(() => {
    if (!isInPlaybackSession || (!transport.isPlaying && !transport.isPaused) || clipDuration <= 0) return null;
    const elapsed = getTransportFramePosition() - clip.startTime;
    if (elapsed < 0 || (!clip.loopEnabled && elapsed > clipDuration)) return null;
    return clip.loopEnabled ? (elapsed % clipDuration) / clipDuration : Math.min(1, elapsed / clipDuration);
  }, [clip.startTime, clipDuration, clip.loopEnabled, isInPlaybackSession, transport.isPlaying, transport.isPaused]);
  return useSyncExternalStore(subscribeTransportFrames, getSnapshot, getSnapshot);
}

function ClipPlayhead({ clip, transport }: { clip: AudioClip; transport: TransportState }) {
  const progress = useClipPlayheadProgress(clip, transport);
  if (progress === null) return null;
  return <div className="arrangement-clip__playhead" style={{ left: `${progress * 100}%` }} />;
}

/**
 * Individual waveform clip.
 */
function SectionClip({
  clip,
  sectionStart,
  sectionEnd,
  channels,
  transport,
}: {
  clip: AudioClip;
  sectionStart: number;
  sectionEnd: number;
  channels: Float32Array[];
  transport: TransportState;
}) {
  const channel = channels[0];

  if (!channel) return null;

  const path = getWaveformPath(channel, 180, 44, 90, clip.sourceStartSample, clip.sourceEndSample);

  const sectionDuration = sectionEnd - sectionStart;

  if (sectionDuration <= 0) return null;

  const leftPercent =
    ((clip.startTime - sectionStart) / sectionDuration) * 100;

  const widthPercent =
    ((clip.endTime - clip.startTime) / sectionDuration) * 100;

  return (
    <div
      className={`arrangement-clip arrangement-clip--${clip.stem} ${clip.parentClipId
          ? "arrangement-clip--split"
          : ""
        }`}
      data-clip-id={clip.id}
      onClick={() => selectClip(clip.id)}
      style={{
        left: `${leftPercent}%`,
        width: `${widthPercent}%`,
      }}
      title={`${clip.stem.toUpperCase()} · ${clip.startTime.toFixed(2)}s–${clip.endTime.toFixed(2)}s`}
    >
      <ClipPlayhead clip={clip} transport={transport} />

      <svg
        className="arrangement-clip__waveform"
        viewBox="0 0 180 44"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={path} />
      </svg>

      <span className="arrangement-clip__label">
        {clip.splitDepth > 0
          ? `1/${2 ** clip.splitDepth}`
          : `${clip.startTime.toFixed(1)}s`}
      </span>

      <ClipControls
        clip={clip}
        transport={transport}
      />
    </div>
  );
}

function BeatMarkers({
  startSample,
  endSample,
  sampleRate,
  beats,
  downbeats,
  snapMode,
  snapTargets,
}: {
  startSample: number;
  endSample: number;
  sampleRate: number;
  beats: Array<{ original: number; sample: number }>;
  downbeats: Array<{ original: number; sample: number; bar: number }>;
  snapMode: BeatSnapMode;
  snapTargets: number[];
}) {
  const duration = endSample - startSample;
  if (duration <= 0 || sampleRate <= 0) return null;

  const renderMarker = (
    kind: TimelineMarkerKind,
    originalSample: number,
    sample: number,
    label?: string,
  ) => {
    if (sample < startSample || sample >= endSample) return null;
    const leftPercent = ((sample - startSample) / duration) * 100;
    const time = (pointerX: number, row: HTMLElement) => {
      const bounds = row.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (pointerX - bounds.left) / bounds.width));
      const target = Math.round(startSample + ratio * duration);
      const snappedTarget = snapMode === "off" || !snapTargets.length
        ? target
        : snapTargets.reduce((closest, candidate) =>
            Math.abs(candidate - target) < Math.abs(closest - target) ? candidate : closest,
          snapTargets[0]);
      setTimelineMarkerPosition(
        kind,
        originalSample,
        Math.max(startSample, Math.min(endSample - 1, snappedTarget)),
      );
    };
    return (
      <button
        key={`${kind}:${originalSample}`}
        type="button"
        className={`timeline-marker timeline-marker--${kind}`}
        style={{ left: `${leftPercent}%` }}
        role="slider"
        aria-label={label ? `Bar ${label} downbeat marker` : "Beat marker"}
        aria-valuemin={startSample}
        aria-valuemax={endSample}
        aria-valuenow={sample}
        title={label ? `Bar ${label} · drag to adjust` : `Beat · drag to adjust`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.buttons !== 1) return;
          const row = event.currentTarget.closest(".arrangement-row");
          if (row instanceof HTMLElement) time(event.clientX, row);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.shiftKey ? sampleRate : Math.max(1, Math.round(sampleRate / 100));
          setTimelineMarkerPosition(
            kind,
            originalSample,
            Math.max(startSample, Math.min(endSample - 1, sample + (event.key === "ArrowRight" ? step : -step))),
          );
        }}
      >
        {label && <span className="timeline-marker__label">{label}</span>}
      </button>
    );
  };

  return (
    <div className="timeline-markers" aria-label="Master beat grid">
      {beats.map((beat) => renderMarker("beat", beat.original, beat.sample))}
      {downbeats.map((beat) => renderMarker("downbeat", beat.original, beat.sample, String(beat.bar)))}
    </div>
  );
}

/**
 * One arrangement column.
 */
function TrackColumn({
  type,
  clips,
  sections,
  selectedClipId,
  transport,
  rowCount,
  beats,
  downbeats,
  sampleRate,
  snapMode,
  snapTargets,
}: {
  type: TrackType;
  clips: AudioClip[];
  sections: ReturnType<typeof useProjectStore>["completedSections"];
  selectedClipId: string | null;
  transport: TransportState;
  rowCount: number;
  beats: Array<{ original: number; sample: number }>;
  downbeats: Array<{ original: number; sample: number; bar: number }>;
  sampleRate: number;
  snapMode: BeatSnapMode;
  snapTargets: number[];
}) {
  const stem = type as StemName;

  const clipsByRow = new Map<number, AudioClip[]>();

  for (const clip of clips) {
    const section = sections[clip.sectionId];

    if (!section) continue;

    const row = section.index + 1;
    const rowClips = clipsByRow.get(row) ?? [];

    rowClips.push(clip);
    clipsByRow.set(row, rowClips);
  }

  return (
    <div
      className={`arrangement-track arrangement-track--${type}`}
      aria-label={`${TRACK_LABELS[type]} arrangement`}
    >
      {Array.from(
        { length: rowCount },
        (_, index) => {
          const row = index + 1;
          const rowClips = clipsByRow.get(row) ?? [];

          return (
            <div
              className="arrangement-row"
              key={row}
            >
              {projectMarkerSection(sections, clipsByRow, row, beats, downbeats, sampleRate, snapMode, snapTargets)}
              {rowClips.map((clip) => {
                const section = sections[clip.sectionId];

                if (!section) return null;

                return (
                  <div
                    className={
                      selectedClipId === clip.id
                        ? "arrangement-clip-wrapper is-selected"
                        : "arrangement-clip-wrapper"
                    }
                    key={clip.id}
                  >
                    <SectionClip
                      clip={clip}
                      sectionStart={section.startTime}
                      sectionEnd={section.endTime}
                      channels={section.stems[stem]}
                      transport={transport}
                    />
                  </div>
                );
              })}
            </div>
          );
        },
      )}
    </div>
  );
}

function projectMarkerSection(
  sections: ReturnType<typeof useProjectStore>["completedSections"],
  clipsByRow: Map<number, AudioClip[]>,
  row: number,
  beats: Array<{ original: number; sample: number }>,
  downbeats: Array<{ original: number; sample: number; bar: number }>,
  sampleRate: number,
  snapMode: BeatSnapMode,
  snapTargets: number[],
) {
  const clip = clipsByRow.get(row)?.[0];
  const section = clip ? sections[clip.sectionId] : null;
  if (!section) return null;
  return (
    <BeatMarkers
      startSample={section.startSample}
      endSample={section.endSample}
      sampleRate={sampleRate}
      beats={beats}
      downbeats={downbeats}
      snapMode={snapMode}
      snapTargets={snapTargets}
    />
  );
}

/**
 * Main arrangement grid.
 */
export function ArrangementGrid() {
  markArrangementRender();
  const project = useProjectStoreSelector((state) => ({
    sections: state.sections,
    completedSections: state.completedSections,
    masterTimeline: state.masterTimeline,
    beatMarkerGrid: state.beatMarkerGrid,
    timelineCorrections: state.timelineCorrections,
    downbeatPhaseOffsetSamples: state.downbeatPhaseOffsetSamples,
    beatSnapMode: state.beatSnapMode,
  }));
  const clipState = useClipStore();
  const transport = useTransportStore();

  const activeClips = Object.values(
    clipState.clips,
  ).filter(clip => clip.active);

  const rowCount = Math.max(
    9,
    project.sections.length,
    Object.keys(project.completedSections).length,
  );
  const timeline = project.masterTimeline;
  const markerGrid = project.beatMarkerGrid ?? (timeline ? {
    sampleRate: timeline.sampleRate,
    beatSamples: timeline.beatSamples,
    downbeatSamples: timeline.downbeatSamples,
  } : null);
  const beats = markerGrid?.beatSamples.map((original) => ({
    original,
    sample: project.timelineCorrections[`beat:${original}`] ?? original,
  })) ?? [];
  const downbeats = markerGrid?.downbeatSamples.map((original, index) => ({
    original,
    sample: project.timelineCorrections[`downbeat:${original}`]
      ?? original + project.downbeatPhaseOffsetSamples,
    bar: index + 1,
  })) ?? [];
  const snapTargets = project.beatSnapMode === "bar"
    ? downbeats.map((beat) => beat.sample)
    : beats.map((beat) => beat.sample);

  return (
    <section
      className="arrangement-grid"
      aria-label="Song arrangement"
      style={{
        "--arrangement-rows": rowCount,
      } as CSSProperties}
    >
      <div
        className="arrangement-grid__row-numbers"
        aria-hidden="true"
      >
        {Array.from(
          { length: rowCount },
          (_, index) => (
            <span key={index}>
              {String(index + 1).padStart(2, "0")}
            </span>
          ),
        )}
      </div>

      <div className="arrangement-grid__columns">
        {TRACKS.map((track) => (
          <TrackColumn
            key={track}
            type={track}
            clips={activeClips.filter(
              clip => clip.stem === track,
            )}
    sections={project.completedSections}
            selectedClipId={clipState.selectedClipId}
            transport={transport}
            rowCount={rowCount}
            beats={beats}
            downbeats={downbeats}
            sampleRate={markerGrid?.sampleRate ?? 0}
            snapMode={project.beatSnapMode}
            snapTargets={snapTargets}
          />
        ))}
      </div>
    </section>
  );
}
