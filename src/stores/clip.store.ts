
import { useSyncExternalStore } from "react";

import type { StemName } from "../features/stem-separation/chunkEngine";
import type { SeparatedSection } from "../features/stem-separation/separationScheduler";

export type AudioClip = {
  id: string;
  stem: StemName;
  sectionId: string;
  sourceStartSample: number;
  sourceEndSample: number;
  startTime: number;
  endTime: number;
  parentClipId: string | null;
  childClipIds: string[];
  splitDepth: number;
  active: boolean;
  loopEnabled: boolean;
};

export type ClipState = {
  clips: Record<string, AudioClip>;
  selectedClipId: string | null;
};

let state: ClipState = {
  clips: {},
  selectedClipId: null,
};

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

function updateState(partial: Partial<ClipState>) {
  state = { ...state, ...partial };
  emit();
}

export function getClipState() {
  return state;
}

export function subscribeClips(listener: Listener) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useClipStore() {
  return useSyncExternalStore(
    subscribeClips,
    getClipState,
    getClipState,
  );
}

/**
 * Register each completed section as four independent stem clips.
 * Existing clips are preserved when additional sections arrive.
 */
export function registerSectionClips(
  section: SeparatedSection,
) {

  const clips = { ...state.clips };
  let changed = false;

  const stems: StemName[] = [
    "drums",
    "bass",
    "other",
    "vocals",
  ];

  for (const stem of stems) {
    const id = `${stem}:${section.id}`;

    if (clips[id]) continue;

    const channels = section.stems[stem];

    if (!channels?.length || !channels[0]?.length) continue;

    clips[id] = {
      id,
      stem,
      sectionId: section.id,

      sourceStartSample: 0,
      sourceEndSample: channels[0].length,

      startTime: section.startTime,
      endTime: section.endTime,

      parentClipId: null,
      childClipIds: [],
      splitDepth: 0,

      active: true,
      loopEnabled: true,
    };

    changed = true;
  }

  if (changed) updateState({ clips });
}

/**
 * Select an individual clip.
 */
export function selectClip(clipId: string | null) {
  if (clipId && !state.clips[clipId]?.active) return;

  updateState({ selectedClipId: clipId });
}

/**
 * Split a clip into two independent clips.
 *
 * The source audio is not copied or modified.
 * Both children reference different ranges of the same source.
 */
export function splitClip(clipId: string): string[] {
  const original = state.clips[clipId];

  if (!original?.active) return [];

  const sampleLength =
    original.sourceEndSample - original.sourceStartSample;

  if (sampleLength < 2) return [];

  const middleSample =
    original.sourceStartSample + Math.floor(sampleLength / 2);

  const timeRatio =
    (middleSample - original.sourceStartSample) / sampleLength;

  const middleTime =
    original.startTime +
    (original.endTime - original.startTime) * timeRatio;

  const splitId = `${original.id}:split:${original.splitDepth + 1}:${middleSample}`;

  const leftId = `${splitId}:left`;
  const rightId = `${splitId}:right`;

  // Avoid duplicate split operations.
  if (state.clips[leftId] || state.clips[rightId]) return [];

  const leftClip: AudioClip = {
    ...original,
    id: leftId,
    sourceEndSample: middleSample,
    endTime: middleTime,
    parentClipId: original.id,
    childClipIds: [],
    splitDepth: original.splitDepth + 1,
    active: true,
  };

  const rightClip: AudioClip = {
    ...original,
    id: rightId,
    sourceStartSample: middleSample,
    startTime: middleTime,
    parentClipId: original.id,
    childClipIds: [],
    splitDepth: original.splitDepth + 1,
    active: true,
  };

  const clips = {
    ...state.clips,

    [original.id]: {
      ...original,
      active: false,
      childClipIds: [leftId, rightId],
    },

    [leftId]: leftClip,
    [rightId]: rightClip,
  };

  updateState({
    clips,
    selectedClipId: leftId,
  });

  return [leftId, rightId];
}

/**
 * Recombine two sibling clips into their previous parent clip.
 *
 * Only works when both children are active.
 */
export function linkClips(clipId: string): boolean {
  const clip = state.clips[clipId];

  if (!clip?.active || !clip.parentClipId) return false;

  const parent = state.clips[clip.parentClipId];

  if (!parent || parent.active) return false;

  const children = parent.childClipIds.map(
    (id) => state.clips[id],
  );

  if (
    children.length !== 2 ||
    children.some((child) => !child?.active)
  ) {
    return false;
  }

  const [left, right] = children;

  if (
    left.sourceEndSample !== right.sourceStartSample ||
    Math.abs(left.endTime - right.startTime) > 0.000001
  ) {
    return false;
  }

  const clips = { ...state.clips };

  clips[left.id] = {
    ...left,
    active: false,
  };

  clips[right.id] = {
    ...right,
    active: false,
  };

  clips[parent.id] = {
    ...parent,
    active: true,
    childClipIds: [],
  };

  updateState({
    clips,
    selectedClipId: parent.id,
  });

  return true;
}

export function setClipLoop(
  clipId: string,
  enabled: boolean,
) {
  const clip = state.clips[clipId];

  if (!clip) return;

  updateState({
    clips: {
      ...state.clips,
      [clipId]: {
        ...clip,
        loopEnabled: enabled,
      },
    },
  });
}

/** Move an active clip while preserving its length and source sample range. */
export function setClipStartTime(clipId: string, startTime: number) {
  const clip = state.clips[clipId];
  if (!clip?.active || !Number.isFinite(startTime)) return;

  const duration = clip.endTime - clip.startTime;
  updateState({
    clips: {
      ...state.clips,
      [clipId]: {
        ...clip,
        startTime,
        endTime: startTime + duration,
      },
    },
  });
}

/**
 * Get active clips for a particular stem.
 */
export function getActiveClips(stem: StemName) {
  return Object.values(state.clips)
    .filter((clip) => clip.active && clip.stem === stem)
    .sort((a, b) => {
      if (a.startTime !== b.startTime) {
        return a.startTime - b.startTime;
      }

      return a.sourceStartSample - b.sourceStartSample;
    });
}

/**
 * Determine whether a clip can be recombined.
 */
export function canLinkClip(clipId: string): boolean {
  const clip = state.clips[clipId];

  if (!clip?.active || !clip.parentClipId) return false;

  const parent = state.clips[clip.parentClipId];

  if (!parent || parent.active) return false;

  return (
    parent.childClipIds.length === 2 &&
    parent.childClipIds.every(
      (id) => state.clips[id]?.active,
    )
  );
}

/**
 * Reset clip editing state.
 */
export function resetClips() {
  state = {
    clips: {},
    selectedClipId: null,
  };

  emit();
}

export function restoreClipSnapshot(clips: Record<string, AudioClip>) {
  state = { clips, selectedClipId: null };
  emit();
}
