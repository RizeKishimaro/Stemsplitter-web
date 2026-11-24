

import { useSyncExternalStore } from "react";

import type { AnalysisResult } from "../features/audio-analysis/analysisClient";
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

export type ProjectState = {
  file: File | null;
  audio: AudioBuffer | null;

  analysis: AnalysisResult | null;
  masterTimeline: MasterTimeline | null;
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
