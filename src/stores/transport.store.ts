

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

function emit() {
  listeners.forEach(listener => listener());
}

export function getTransportState() {
  return state;
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
  emit();
}

export function resetTransport() {
  state = { ...initialState };
  emit();
}

