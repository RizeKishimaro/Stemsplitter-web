

import { detect } from "@audio/beat";
import downbeat from "@audio/mir-downbeat";

type AnalyzeRequest = {
  type: "analyze";
  jobId: string;
  samples: Float32Array;
  sampleRate: number;
  meter: number;
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const request = event.data;

  if (request.type !== "analyze") return;

  const { jobId, samples, sampleRate, meter } = request;

  const send = (message: Record<string, unknown>) => {
    scope.postMessage({ ...message, jobId });
  };

  try {
    if (!samples.length || sampleRate <= 0) {
      throw new Error("Invalid audio samples or sample rate.");
    }

    if (!Number.isInteger(meter) || meter < 2 || meter > 7) {
      throw new Error("Meter must be an integer between 2 and 7.");
    }

    send({
      type: "status",
      stage: "beats",
      message: "Detecting beats and onsets...",
    });

    const beatResult = detect(samples, { fs: sampleRate });

    const beats = Array.from(beatResult.beats);
    const onsets = Array.from(beatResult.onsets);

    if (beats.length < meter * 2) {
      throw new Error("Not enough beats to estimate downbeats.");
    }

    send({
      type: "status",
      stage: "downbeats",
      message: "Estimating musical bar positions...",
    });

    const result = downbeat(samples, {
      beats,
      fs: sampleRate,
      meter,
    });

    const downbeats = Array.from(result.downbeats);

    if (!downbeats.length) {
      throw new Error("No downbeats detected.");
    }

    const bars = downbeats.map((start, index) => {
      const end = downbeats[index + 1] ?? samples.length / sampleRate;

      return {
        number: index + 1,
        start,
        end,
        beats: beats.filter(
          (beat) => beat >= start && beat < end,
        ),
      };
    });

    send({
      type: "complete",
      bpm: beatResult.bpm,
      beatConfidence: beatResult.confidence,
      downbeatConfidence: result.confidence,
      meter: result.meter,
      phase: result.phase,
      beats,
      onsets,
      downbeats,
      bars,
      duration: samples.length / sampleRate,
    });
  } catch (error) {
    send({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
};

export { };
