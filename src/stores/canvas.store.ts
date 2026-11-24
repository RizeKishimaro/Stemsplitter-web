
import { useSyncExternalStore } from "react";

export type CanvasTrack =
  | "drums"
  | "bass"
  | "other"
  | "vocals";

export type CanvasState = {
  selectedTrack: CanvasTrack | null;
  visibleTracks: Record<CanvasTrack, boolean>;
};

const initialState: CanvasState = {
  selectedTrack: null,
  visibleTracks: {
    drums: true,
    bass: true,
    other: true,
    vocals: true,
  },
};

let state: CanvasState = initialState;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function getCanvasState() {
  return state;
}

export function subscribeCanvas(listener: Listener) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function useCanvasStore() {
  return useSyncExternalStore(
    subscribeCanvas,
    getCanvasState,
    getCanvasState,
  );
}

export function selectTrack(track: CanvasTrack | null) {
  state = {
    ...state,
    selectedTrack: track,
  };

  emit();
}

export function toggleTrackVisibility(track: CanvasTrack) {
  state = {
    ...state,
    visibleTracks: {
      ...state.visibleTracks,
      [track]: !state.visibleTracks[track],
    },
  };

  emit();
}

export function setTrackVisibility(
  track: CanvasTrack,
  visible: boolean,
) {
  state = {
    ...state,
    visibleTracks: {
      ...state.visibleTracks,
      [track]: visible,
    },
  };

  emit();
}

export function resetCanvas() {
  state = { ...initialState };
  emit();
}

