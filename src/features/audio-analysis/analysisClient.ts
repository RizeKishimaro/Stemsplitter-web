export type BarAnalysis = {
  number: number;
  start: number;
  end: number;
  beats: number[];
};

export type AnalysisResult = {
  bpm: number;
  beatConfidence: number;
  downbeatConfidence: number;
  meter: number;
  phase: number;
  beats: number[];
  onsets: number[];
  downbeats: number[];
  bars: BarAnalysis[];
  duration: number;
};

type WorkerResponse =
  | {
    type: "status";
    jobId: string;
    stage: string;
    message: string;
  }
  | ({
    type: "complete";
    jobId: string;
  } & AnalysisResult)
  | {
    type: "error";
    jobId: string;
    message: string;
  };

type AnalysisCallbacks = {
  onStatus?: (stage: string, message: string) => void;
  onComplete: (result: AnalysisResult) => void;
  onError: (message: string) => void;
};

export function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  meter: number,
  callbacks: AnalysisCallbacks,
) {
  const worker = new Worker(
    new URL("../../workers/analysis.worker.ts", import.meta.url),
    { type: "module" },
  );

  const jobId = crypto.randomUUID();

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;

    if (response.jobId !== jobId) return;

    switch (response.type) {
      case "status":
        callbacks.onStatus?.(response.stage, response.message);
        break;

      case "complete": {
        const result: AnalysisResult = {
          bpm: response.bpm,
          beatConfidence: response.beatConfidence,
          downbeatConfidence: response.downbeatConfidence,
          meter: response.meter,
          phase: response.phase,
          beats: response.beats,
          onsets: response.onsets,
          downbeats: response.downbeats,
          bars: response.bars,
          duration: response.duration,
        };
        callbacks.onComplete(result);
        worker.terminate();
        break;
      }

      case "error":
        callbacks.onError(response.message);
        worker.terminate();
        break;
    }
  };

  worker.onerror = (event) => {
    callbacks.onError(event.message || "Audio analysis worker failed.");
    worker.terminate();
  };

  // Copy the samples so transferring them won't detach the original buffer.
  const samplesCopy = samples.slice();

  worker.postMessage(
    {
      type: "analyze",
      jobId,
      samples: samplesCopy,
      sampleRate,
      meter,
    },
    [samplesCopy.buffer],
  );

  // Calling this terminates the analysis job.
  return () => worker.terminate();
}
