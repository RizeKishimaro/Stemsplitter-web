export type BeatAnalysisEvent = {
  time_seconds: number;
  sample_position: number;
  beat_number_in_bar?: number | null;
};

export type BeatAnalysisResult = {
  bpm: number | null;
  beats: BeatAnalysisEvent[];
  downbeats: Array<Omit<BeatAnalysisEvent, "beat_number_in_bar">>;
  input_stem: "drums" | "mix";
  sample_rate: number;
  source_frame_count: number;
  detection_engine: string;
  engine_version: string;
  model_version: string | null;
  analysis_metadata: Record<string, unknown>;
};

type BeatAnalysisJob = {
  id: string;
  separation_job_id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  error_message: string | null;
  result: BeatAnalysisResult | null;
};

const API_BASE = import.meta.env.VITE_RUST_API_URL ?? "http://localhost:8787";

async function readAnalysis(jobId: string): Promise<BeatAnalysisJob> {
  const response = await fetch(`${API_BASE}/api/v1/jobs/${encodeURIComponent(jobId)}/beat-analysis`);
  if (!response.ok) throw new Error(`Beat analysis request failed (${response.status}).`);
  return response.json() as Promise<BeatAnalysisJob>;
}

export async function runBackendBeatAnalysis(
  separationJobId: string,
  signal?: AbortSignal,
): Promise<BeatAnalysisResult> {
  const create = await fetch(
    `${API_BASE}/api/v1/jobs/${encodeURIComponent(separationJobId)}/beat-analysis`,
    { method: "POST", signal },
  );
  if (!create.ok) {
    const message = await create.text();
    throw new Error(`Could not start beat analysis (${create.status}): ${message}`);
  }
  let job = await create.json() as BeatAnalysisJob;
  while (job.status === "QUEUED" || job.status === "RUNNING") {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 750);
      signal?.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(new DOMException("Beat analysis cancelled", "AbortError"));
      }, { once: true });
    });
    job = await readAnalysis(separationJobId);
  }
  if (job.status !== "SUCCEEDED" || !job.result) {
    throw new Error(job.error_message || "Beat analysis did not complete.");
  }
  return job.result;
}
