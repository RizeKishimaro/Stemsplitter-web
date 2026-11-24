

let context: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!context || context.state === "closed") {
    context = new AudioContext({
      latencyHint: "interactive",
    });
  }

  return context;
}

export async function resumeAudioContext() {
  const audioContext = getAudioContext();

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }

  return audioContext;
}

export async function closeAudioContext() {
  if (context && context.state !== "closed") {
    await context.close();
  }

  context = null;
}
