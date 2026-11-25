

import { useState } from "react";
import { useProjectStoreSelector, setBeatSnapMode, setDownbeatPhaseOffsetSamples } from "../../../stores/project.store";
import { setExternalBeatMarkerGrid } from "../../../stores/project.store";
import { runBackendBeatAnalysis } from "../../beat-analysis/beatAnalysisClient";
import type { AnalysisStrategy } from "../../../lib/backendSeparationClient";
import { GridBackground } from "./GridBackground";
import { TrackHeader, type TrackType } from "./TrackHeader";
import { ArrangementGrid } from "./ArrangementGrid";

import "./SongCanvas.css";
import "./TrackHeader.css";

const trackTypes: TrackType[] = [
  "drums",
  "bass",
  "other",
  "vocals",
];

type SongCanvasProps = { onBackendSeparation: (strategy: AnalysisStrategy, beatsPerBar: number, report: (message: string) => void) => Promise<void> };

export function SongCanvas({ onBackendSeparation }: SongCanvasProps) {
  const [separationJobId, setSeparationJobId] = useState("");
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [analysisStrategy, setAnalysisStrategy] = useState<AnalysisStrategy>("drums_first");
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [backendBusy, setBackendBusy] = useState(false);
  const project = useProjectStoreSelector((state) => ({
    file: state.file,
    audio: state.audio,
    masterTimeline: state.masterTimeline,
    beatSnapMode: state.beatSnapMode,
    downbeatPhaseOffsetSamples: state.downbeatPhaseOffsetSamples,
  }));

  async function handleBackendAnalysis() {
    if (!separationJobId.trim()) return;
    setAnalysisBusy(true);
    setAnalysisMessage("Analyzing drums…");
    try {
      const result = await runBackendBeatAnalysis(separationJobId.trim());
      setExternalBeatMarkerGrid(result);
      const bpm = result.bpm === null ? "BPM unavailable" : `${result.bpm.toFixed(1)} BPM`;
      setAnalysisMessage(`${bpm} · ${result.beats.length} beats · ${result.downbeats.length} downbeats · ${result.detection_engine} ${result.engine_version}`);
    } catch (error) {
      setAnalysisMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAnalysisBusy(false);
    }
  }

  async function handleBackendSeparation() {
    setBackendBusy(true);
    setAnalysisMessage("Uploading audio to HTDemucs…");
    try {
      await onBackendSeparation(analysisStrategy, beatsPerBar, setAnalysisMessage);
    } catch (error) {
      setAnalysisMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBackendBusy(false);
    }
  }

  return (
    <section className="song-canvas">
      <GridBackground />
      <div className="beat-grid-tools" aria-label="Beat grid editing">
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
        <form
          className="beat-grid-tools__backend"
          onSubmit={(event) => {
            event.preventDefault();
            void handleBackendAnalysis();
          }}
        >
          <label>
            <span>HTDemucs job</span>
            <input
              aria-label="HTDemucs separation job ID"
              type="text"
              value={separationJobId}
              onChange={(event) => setSeparationJobId(event.target.value)}
              placeholder="job UUID"
              disabled={analysisBusy}
            />
          </label>
          <button type="submit" disabled={analysisBusy || !project.masterTimeline || !separationJobId.trim()}>
            {analysisBusy ? "Analyzing…" : "Analyze drums"}
          </button>
        </form>
        {project.file && project.audio && <div className="beat-grid-tools__backend">
          <label>
            <span>HTDemucs analysis</span>
            <select aria-label="HTDemucs analysis strategy" value={analysisStrategy} disabled={backendBusy}
              onChange={(event) => setAnalysisStrategy(event.target.value as AnalysisStrategy)}>
              <option value="drums_first">Drums first</option>
              <option value="mix_first">Mix first</option>
            </select>
          </label>
          <label>
            <span>Meter</span>
            <select aria-label="Analysis time signature" value={beatsPerBar} disabled={backendBusy}
              onChange={(event) => setBeatsPerBar(Number(event.target.value))}>
              <option value={4}>4/4</option>
              <option value={3}>3/4</option>
            </select>
          </label>
          <button type="button" disabled={backendBusy} onClick={() => void handleBackendSeparation()}>
            {backendBusy ? "Connecting…" : "Separate with HTDemucs"}
          </button>
        </div>}
        {analysisMessage && <span className="beat-grid-tools__message" role="status">{analysisMessage}</span>}
      </div>

      <div className="song-canvas__content">
        {/* Fixed track headers */}
        <div className="song-canvas__tracks">
          {trackTypes.map((type) => (
            <TrackHeader key={type} type={type} />
          ))}
        </div>

        <div className="arrangement-scroll">
          <div className="arrangement-scroll__content">
            <ArrangementGrid />
          </div>
        </div>
      </div>
    </section>
  );
}
