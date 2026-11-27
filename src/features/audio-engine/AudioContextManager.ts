

let context: AudioContext | null = null;
let contextCreationMs = 0;
let lastResumeMs = 0;

export function getAudioContext(): AudioContext {
  if (!context || context.state === "closed") {
    const startedAt = import.meta.env.DEV ? performance.now() : 0;
    context = new AudioContext({
      latencyHint: "interactive",
    });
    if (import.meta.env.DEV) contextCreationMs = performance.now() - startedAt;
  }

  return context;
}

export async function resumeAudioContext() {
  const audioContext = getAudioContext();

  if (audioContext.state !== "running") {
    const startedAt = import.meta.env.DEV ? performance.now() : 0;
    await audioContext.resume();
    if (import.meta.env.DEV) lastResumeMs = performance.now() - startedAt;
  }

  return audioContext;
}

export function getAudioContextDiagnostics() {
  if (!import.meta.env.DEV) return null;
  const audioContext = getAudioContext();
  return {
    state: audioContext.state,
    creationMs: contextCreationMs,
    lastResumeMs,
    baseLatencySeconds: audioContext.baseLatency,
    outputLatencySeconds: audioContext.outputLatency ?? null,
    sampleRate: audioContext.sampleRate,
  };
}

export async function closeAudioContext() {
  if (context && context.state !== "closed") {
    await context.close();
  }

  context = null;
}
