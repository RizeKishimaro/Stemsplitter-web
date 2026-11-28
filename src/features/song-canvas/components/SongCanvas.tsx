import { useState } from "react";
import { useProjectStoreSelector, setBeatSnapMode, setDownbeatPhaseOffsetSamples } from "../../../stores/project.store";
import { changeArrangementSegmentSize, type ArrangementSegmentSize } from "../../../lib/backendSeparationClient";
import { GridBackground } from "./GridBackground";
import { TrackHeader, type TrackType } from "./TrackHeader";
import { ArrangementGrid } from "./ArrangementGrid";

import "./SongCanvas.css";
import "./TrackHeader.css";

// UI copy: set to true to bring back the Snap / Segment / Downbeat phase debug bar.
const SHOW_DEBUG_TOOLS = false;

const trackTypes: TrackType[] = ["drums", "bass", "other", "vocals"];

type SongCanvasProps = {
  processingMessage: string;
  processingProgress: number | null;
};

export function SongCanvas({ processingMessage, processingProgress }: SongCanvasProps) {
  const [settingsMessage, setSettingsMessage] = useState("");
  const project = useProjectStoreSelector((state) => ({
    file: state.file,
    masterTimeline: state.masterTimeline,
    beatSnapMode: state.beatSnapMode,
    downbeatPhaseOffsetSamples: state.downbeatPhaseOffsetSamples,
    segmentSize: state.segmentSize,
    status: state.status,
    error: state.error,
  }));

  return (
    <section className="song-canvas">
      <GridBackground />
      {SHOW_DEBUG_TOOLS && (
      <div className="beat-grid-tools" aria-label="Timeline settings">
        <label>
          <span>Snap</span>
          <select
            aria-label="Beat grid snap mode"
            value={project.beatSnapMode}
            disabled={!project.masterTimeline}
            onChange={(event) => setBeatSnapMode(event.target.value as "off" | "beat" | "bar")}
          >
            <option value="off">Off</option>
            <option value="beat">Beat</option>
            <option value="bar">Bar</option>
          </select>
        </label>
        <label>
          <span>Segment</span>
          <select
            aria-label="Arrangement segment size"
            value={project.segmentSize}
            disabled={!project.masterTimeline}
            onChange={(event) => {
              const segmentSize = event.target.value as ArrangementSegmentSize;
              void changeArrangementSegmentSize(segmentSize)
                .then(() => setSettingsMessage(`Arrangement updated to ${segmentLabel(segmentSize)}.`))
                .catch((error: unknown) => setSettingsMessage(error instanceof Error ? error.message : String(error)));
            }}
          >
            <option value="1bar">1 bar</option>
            <option value="2bars">2 bars</option>
            <option value="4bars">4 bars</option>
            <option value="beat">1 beat</option>
          </select>
        </label>
        <label>
          <span>Downbeat phase</span>
          <input
            key={`${project.file?.name ?? ""}:${project.masterTimeline?.sampleRate ?? 0}:${project.downbeatPhaseOffsetSamples}`}
            aria-label="Downbeat phase adjustment in milliseconds"
            type="number"
            step="0.1"
            defaultValue={project.masterTimeline
              ? (project.downbeatPhaseOffsetSamples / project.masterTimeline.sampleRate * 1000).toFixed(1)
              : "0.0"}
            disabled={!project.masterTimeline}
            onBlur={(event) => {
              const milliseconds = Number.parseFloat(event.currentTarget.value);
              if (Number.isFinite(milliseconds) && project.masterTimeline) {
                setDownbeatPhaseOffsetSamples(Math.round(milliseconds * project.masterTimeline.sampleRate / 1000));
              }
            }}
          />
          <span>ms</span>
        </label>
        <span className="beat-grid-tools__defaults" aria-label="Processing defaults">
          4/4 · Drums lead
        </span>
        {settingsMessage && <span className="beat-grid-tools__message" role="status">{settingsMessage}</span>}
      </div>
      )}

      {project.status === "separating" && (
        <div className="song-canvas__processing" role="status" aria-live="polite">
          <span>{processingMessage || "Processing audio…"}</span>
          {processingProgress !== null && (
            <>
              <progress max={100} value={processingProgress} aria-label="Backend processing progress" />
              <span>{Math.round(processingProgress)}%</span>
            </>
          )}
        </div>
      )}
      {project.status === "error" && project.error && (
        <div className="song-canvas__processing song-canvas__processing--error" role="alert">
          {project.error}
        </div>
      )}

      <div className="song-canvas__content">
        <div className="song-canvas__tracks">
          {trackTypes.map((type) => <TrackHeader key={type} type={type} />)}
        </div>
        <div
          className="arrangement-scroll"
          onScroll={(event) => {
            // UI copy: only show the header's bottom line once the rows have scrolled.
            event.currentTarget.parentElement?.classList.toggle(
              "is-scrolled",
              event.currentTarget.scrollTop > 0,
            );
          }}
        >
          <div className="arrangement-scroll__content">
            <ArrangementGrid
              processingProgress={processingProgress}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function segmentLabel(size: ArrangementSegmentSize) {
  if (size === "beat") return "one beat per segment";
  return `${size[0]} ${size[0] === "1" ? "bar" : "bars"} per segment`;
}
