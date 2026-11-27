

import { useSyncExternalStore } from "react";

export type PlaybackMode = "arrangement" | "clip" | null;

export type TransportState = {
  isPlaying: boolean;
  isPaused: boolean;
  currentTime: number;
  duration: number;
  mode: PlaybackMode;
  activeClipId: string | null;
  playingClipIds: string[];
};

const initialState: TransportState = {
  isPlaying: false,
  isPaused: false,
  currentTime: 0,
  duration: 0,
  mode: null,
  activeClipId: null,
  playingClipIds: [],
};

let state = initialState;
const listeners = new Set<() => void>();
const frameListeners = new Set<() => void>();
const frameRenderers = new Set<(position: number) => void>();
let framePosition = 0;

function publishFrame(position: number) {
  framePosition = position;
  frameListeners.forEach(listener => listener());
  frameRenderers.forEach(render => render(position));
}

function emit() {
  listeners.forEach(listener => listener());
}

export function getTransportState() {
  return state;
}

export function getTransportSnapshot() {
  return { ...state, currentTime: framePosition };
}

export function subscribeTransport(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTransportStore() {
  return useSyncExternalStore(
    subscribeTransport,
    getTransportState,
    getTransportState,
  );
}

export function updateTransport(
  partial: Partial<TransportState>,
) {
  state = { ...state, ...partial };
  if (partial.currentTime !== undefined) {
    publishFrame(partial.currentTime);
  }
  emit();
}

/** High-frequency visual clock. Audio playback itself remains driven by AudioContext. */
export function publishTransportFrame(position: number) {
  if (!Number.isFinite(position) || position === framePosition) return;
  publishFrame(position);
}

export function subscribeTransportFrames(listener: () => void) {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

/** Direct DOM render callbacks for high-frequency visuals that should not rerender React. */
export function registerTransportFrameRenderer(render: (position: number) => void) {
  frameRenderers.add(render);
  render(framePosition);
  return () => frameRenderers.delete(render);
}

export function getTransportFramePosition() { return framePosition; }

export function useTransportPosition() {
  return useSyncExternalStore(
    subscribeTransportFrames,
    getTransportFramePosition,
    () => framePosition,
  );
}

export function resetTransport() {
  state = { ...initialState };
  publishFrame(0);
  emit();
}
