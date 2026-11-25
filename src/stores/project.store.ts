

import { useEffect, useState, useSyncExternalStore } from "react";

import type { AnalysisResult } from "../features/audio-analysis/analysisClient";
import type { BeatAnalysisResult } from "../features/beat-analysis/beatAnalysisClient";
import type {
  SeparationSection,
  StemName,
} from "../features/stem-separation/chunkEngine";
import type {
  SeparatedSection,
} from "../features/stem-separation/separationScheduler";

export type ProjectStatus =
  | "idle"
  | "imported"
  | "analyzing"
  | "ready"
  | "separating"
  | "complete"
  | "error";

export type MasterTimeline = {
  originSample: 0;
  sampleRate: number;
  bpm: number;
  meter: number;
  beatSamples: number[];
  downbeatSamples: number[];
  bars: Array<{
    number: number;
    startSample: number;
    endSample: number;
  }>;
};

export type BeatSnapMode = "off" | "beat" | "bar";

export type BeatMarkerGrid = {
  sampleRate: number;
  bpm: number | null;
  beatSamples: number[];
  downbeatSamples: number[];
  engine: string;
  engineVersion: string;
  modelVersion: string | null;
  inputStem: string;
};

export type ProjectState = {
  file: File | null;
  audio: AudioBuffer | null;

  analysis: AnalysisResult | null;
  masterTimeline: MasterTimeline | null;
  beatMarkerGrid: BeatMarkerGrid | null;
  /** Manual marker adjustments remain separate from detector output. */
  timelineCorrections: Record<string, number>;
  beatSnapMode: BeatSnapMode;
  downbeatPhaseOffsetSamples: number;
  sections: SeparationSection[];

  completedSections: Record<string, SeparatedSection>;
  sectionProgress: Record<string, number>;
  sectionErrors: Record<string, string>;

  status: ProjectStatus;
  error: string | null;
};

const initialState: ProjectState = {
  file: null,
  audio: null,
  analysis: null,
  masterTimeline: null,
  beatMarkerGrid: null,
  timelineCorrections: {},
  beatSnapMode: "off",
  downbeatPhaseOffsetSamples: 0,
  sections: [],
  completedSections: {},
  sectionProgress: {},
  sectionErrors: {},
  status: "idle",
  error: null,
};

let state: ProjectState = initialState;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

function updateState(partial: Partial<ProjectState>) {
  state = { ...state, ...partial };
  emit();
}

export function getProjectState(): ProjectState {
  return state;
}

export function subscribeProject(listener: Listener) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useProjectStore() {
  return useSyncExternalStore(
    subscribeProject,
    getProjectState,
    getProjectState,
  );
}

function shallowEqual(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  return aKeys.length === Object.keys(bRecord).length &&
    aKeys.every((key) => Object.is(aRecord[key], bRecord[key]));
}

/** Subscribe to a stable projection so unrelated progress events do not rerender a screen. */
export function useProjectStoreSelector<T>(selector: (value: ProjectState) => T): T {
  const [selected, setSelected] = useState(() => selector(state));
  useEffect(() => {
    const refresh = () => setSelected((previous) => {
      const next = selector(state);
      return shallowEqual(previous, next) ? previous : next;
    });
    refresh();
    return subscribeProject(refresh);
  }, [selector]);
  return selected;
}

// Import original audio.
export function setImportedAudio(file: File, audio: AudioBuffer) {
  state = {
    ...initialState,
    file,
    audio,
    status: "imported",
  };

  emit();
}

export function restoreProjectSnapshot(
  file: File,
  audio: AudioBuffer,
  saved: Omit<ProjectState, "file" | "audio" | "completedSections" | "sectionProgress" | "sectionErrors" | "error">,
  completedSections: SeparatedSection[],
) {
  const completedById = Object.fromEntries(completedSections.map((section) => [section.id, section]));
  state = {
    ...initialState,
    ...saved,
    file,
    audio,
    completedSections: completedById,
    sectionProgress: Object.fromEntries(saved.sections.map((section) => [section.id, completedById[section.id] ? 100 : 0])),
    sectionErrors: {},
    error: null,
  };
  emit();
}

// Analysis lifecycle.
export function setProjectStatus(status: ProjectStatus) {
  updateState({ status, error: null });
}

export function setAnalysisResult(analysis: AnalysisResult) {
  updateState({
    analysis,
    status: "ready",
    error: null,
  });
}

export type TimelineMarkerKind = "beat" | "downbeat";

export function setTimelineMarkerPosition(
  kind: TimelineMarkerKind,
  detectedSample: number,
  correctedSample: number,
) {
  if (!Number.isSafeInteger(detectedSample) || !Number.isSafeInteger(correctedSample)) return;
  const key = `${kind}:${detectedSample}`;
  updateState({
    timelineCorrections: {
      ...state.timelineCorrections,
      [key]: correctedSample,
    },
  });
}

export function getTimelineMarkerSample(
  kind: TimelineMarkerKind,
  detectedSample: number,
) {
  return state.timelineCorrections[`${kind}:${detectedSample}`] ?? detectedSample;
}

export function setBeatSnapMode(beatSnapMode: BeatSnapMode) {
  updateState({ beatSnapMode });
}

export function setDownbeatPhaseOffsetSamples(downbeatPhaseOffsetSamples: number) {
  if (!Number.isSafeInteger(downbeatPhaseOffsetSamples)) return;
  updateState({ downbeatPhaseOffsetSamples });
}

/** Import backend detector timestamps while keeping the arrangement grid untouched. */
export function setExternalBeatMarkerGrid(result: BeatAnalysisResult, sourceSampleRate?: number) {
  const sampleRate = state.masterTimeline?.sampleRate ?? sourceSampleRate;
  if (!sampleRate) throw new Error("Import audio before applying backend beat analysis.");
  updateState({
    beatMarkerGrid: {
      sampleRate,
      bpm: result.bpm,
      beatSamples: result.beats.map((beat) => Math.round(beat.time_seconds * sampleRate)),
      downbeatSamples: result.downbeats.map((beat) => Math.round(beat.time_seconds * sampleRate)),
      engine: result.detection_engine,
      engineVersion: result.engine_version,
      modelVersion: result.model_version,
      inputStem: result.input_stem,
    },
  });
}

// Separation plan.
export function setSeparationPlan(sections: SeparationSection[]) {
  const sectionProgress: Record<string, number> = {};

  for (const section of sections) {
    sectionProgress[section.id] = 0;
  }

  updateState({
    sections,
    completedSections: {},
    sectionProgress,
    sectionErrors: {},
    status: "separating",
    error: null,
  });
}

/** Publish the backend's durable sample schedule before chunks finish, so bars can show pending state. */
export function setBackendChunkSchedule(
  jobId: string,
  boundaries: Array<{ index: number; bar_number: number | null; start_sample: number; end_sample: number; sample_rate: number }>,
) {
  const sections: SeparationSection[] = boundaries.map((boundary) => {
    const id = `${jobId.replaceAll("-", "")}-${String(boundary.index).padStart(6, "0")}`;
    return {
      id,
      index: boundary.index,
      startBar: boundary.bar_number ?? 0,
      endBar: boundary.bar_number === null ? 0 : boundary.bar_number + 1,
      startTime: boundary.start_sample / boundary.sample_rate,
      endTime: boundary.end_sample / boundary.sample_rate,
      startSample: boundary.start_sample,
      endSample: boundary.end_sample,
      processStartSample: boundary.start_sample,
      processEndSample: boundary.end_sample,
      trimStartSample: 0,
      trimEndSample: 0,
      duration: (boundary.end_sample - boundary.start_sample) / boundary.sample_rate,
      chunkIds: [id],
      kind: boundary.bar_number === null ? "pickup" : "bars",
    };
  });
  const sectionProgress = Object.fromEntries(sections.map((section) => [section.id, state.completedSections[section.id] ? 100 : state.sectionProgress[section.id] ?? 0]));
  updateState({ sections, sectionProgress, status: "separating", error: null });
}

// Progress for the currently processing section.
export function setSectionProgress(
  sectionId: string,
  percentage: number,
) {
  updateState({
    sectionProgress: {
      ...state.sectionProgress,
      [sectionId]: Math.max(0, Math.min(100, percentage)),
    },
  });
}

// Publish completed audio immediately.
export function addSeparatedSection(section: SeparatedSection) {
  updateState({
    completedSections: {
      ...state.completedSections,
      [section.id]: section,
    },
    sectionProgress: {
      ...state.sectionProgress,
      [section.id]: 100,
    },
    sectionErrors: {
      ...state.sectionErrors,
      [section.id]: "",
    },
  });
}

/** Replace progressive processing sections with drums-grid arrangement sections. */
export function setMasterTimelineSections(
  analysis: AnalysisResult,
  sections: SeparationSection[],
  completedSections: SeparatedSection[],
) {
  const completedById = Object.fromEntries(
    completedSections.map((section) => [section.id, section]),
  );
  const sectionProgress = Object.fromEntries(
    sections.map((section) => [section.id, 100]),
  );
  const sampleRate = completedSections[0]?.sampleRate;
  if (!sampleRate) {
    throw new Error("Cannot establish a master timeline without a sample rate.");
  }

  const durationSample = Math.round(analysis.duration * sampleRate);
  const bars = analysis.bars.map((bar, index) => ({
    number: bar.number,
    startSample: Math.round(bar.start * sampleRate),
    endSample: Math.round((analysis.bars[index + 1]?.start ?? analysis.duration) * sampleRate),
  }));

  updateState({
    analysis,
    masterTimeline: {
      originSample: 0,
      sampleRate,
      bpm: analysis.bpm,
      meter: analysis.meter,
      beatSamples: analysis.beats.map((beat) => Math.round(beat * sampleRate)),
      downbeatSamples: analysis.downbeats.map((beat) => Math.round(beat * sampleRate)),
      bars: bars.map((bar) => ({
        ...bar,
        endSample: Math.min(durationSample, bar.endSample),
      })),
    },
    beatMarkerGrid: {
      sampleRate,
      bpm: analysis.bpm,
      beatSamples: analysis.beats.map((beat) => Math.round(beat * sampleRate)),
      downbeatSamples: analysis.downbeats.map((beat) => Math.round(beat * sampleRate)),
      engine: "browser-analysis",
      engineVersion: "local",
      modelVersion: null,
      inputStem: "drums",
    },
    sections,
    completedSections: completedById,
    sectionProgress,
    sectionErrors: {},
    error: null,
  });
}

// Individual section failure.
export function setSectionError(
  sectionId: string,
  message: string,
) {
  updateState({
    sectionErrors: {
      ...state.sectionErrors,
      [sectionId]: message,
    },
  });
}

export function setProjectError(message: string) {
  updateState({
    status: "error",
    error: message,
  });
}

// Called when every section has completed.
export function finishSeparation() {
  updateState({
    status: "complete",
  });
}

// Retrieve completed audio for one stem, ordered by timeline.
export function getCompletedStemSections(stem: StemName) {
  return Object.values(state.completedSections)
    .filter((section) => section.stems[stem]?.length)
    .sort((a, b) => a.startTime - b.startTime);
}

// Reset the project.
export function resetProject() {
  state = { ...initialState };
  emit();
}
