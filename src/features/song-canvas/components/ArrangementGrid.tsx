

import type { CSSProperties, MouseEvent } from "react";

import { useProjectStore } from "../../../stores/project.store";
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
  type TransportState,
} from "../../../stores/transport.store";

import type { TrackType } from "./TrackHeader";
import type { StemName } from "../../stem-separation/chunkEngine";

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

function getWaveformPath(
  channel: Float32Array,
  width = 180,
  height = 44,
  samples = 90,
): string {
  if (!channel.length) return "";

  const center = height / 2;
  const step = channel.length / samples;
  const points: string[] = [];

  for (let i = 0; i < samples; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(
      channel.length,
      Math.max(start + 1, Math.floor((i + 1) * step)),
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

  return points.join(" ");
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
function getClipPlayhead(
  clip: AudioClip,
  transport: TransportState,
): number | null {
  const isInPlaybackSession =
    transport.playingClipIds.includes(clip.id);

  if (!isInPlaybackSession) return null;

  if (!transport.isPlaying && !transport.isPaused) {
    return null;
  }

  const clipDuration = clip.endTime - clip.startTime;

  if (clipDuration <= 0) return null;

  const elapsed = transport.currentTime - clip.startTime;

  // The clip has not started yet.
  if (elapsed < 0) return null;

  // Looping clips wrap their visual playhead.
  if (clip.loopEnabled) {
    return (elapsed % clipDuration) / clipDuration;
  }

  // Non-looping clips stop showing the playhead after their end.
  if (elapsed > clipDuration) return null;

  return Math.min(1, elapsed / clipDuration);
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

  const clipAudio = channel.subarray(
    clip.sourceStartSample,
    clip.sourceEndSample,
  );

  const path = getWaveformPath(clipAudio);

  const sectionDuration = sectionEnd - sectionStart;

  if (sectionDuration <= 0) return null;

  const leftPercent =
    ((clip.startTime - sectionStart) / sectionDuration) * 100;

  const widthPercent =
    ((clip.endTime - clip.startTime) / sectionDuration) * 100;

  const playheadProgress = getClipPlayhead(
    clip,
    transport,
  );

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
      {playheadProgress !== null && (
        <div
          className="arrangement-clip__playhead"
          style={{
            left: `${playheadProgress * 100}%`,
          }}
        />
      )}

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
}: {
  type: TrackType;
  clips: AudioClip[];
  sections: ReturnType<typeof useProjectStore>["completedSections"];
  selectedClipId: string | null;
  transport: TransportState;
  rowCount: number;
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

/**
 * Main arrangement grid.
 */
export function ArrangementGrid() {
  const project = useProjectStore();
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
          />
        ))}
      </div>
    </section>
  );
}
