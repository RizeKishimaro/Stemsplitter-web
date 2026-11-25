import { API_BASE_URL } from "./api";
import { audioEngine } from "../features/audio-engine/AudioEngine";
import type { SeparatedSection } from "../features/stem-separation/separationScheduler";
import { registerSectionClips } from "../stores/clip.store";
import { addSeparatedSection, finishSeparation, setBackendChunkSchedule, setExternalBeatMarkerGrid, setProjectStatus, setSectionProgress } from "../stores/project.store";
import type { BeatAnalysisResult } from "../features/beat-analysis/beatAnalysisClient";
import {
  deleteLocalChunkStem,
  getLocalChunkRecord,
  getLocalChunkStem,
  markLocalChunkPersisted,
  persistLocalChunkStem,
  saveBackendJobId,
  ACTIVE_LOCAL_PROJECT_ID,
  type LocalChunkManifest,
} from "./localProjectStore";

export type AnalysisStrategy = "mix_first" | "drums_first";
const BACKEND_API_BASE = (import.meta.env?.VITE_RUST_API_URL ?? API_BASE_URL).replace(/\/+$/, "");

export type BackendChunkCompleted = {
  job_id: string;
  chunk_id: string;
  chunk_index: number;
  bar_number: number | null;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  source_sample_start: number;
  source_sample_end: number;
  sample_rate: number;
  stems: Record<"drums" | "bass" | "other" | "vocals", { url: string; channels: number; sample_rate: number; frame_count: number; audio_format: "wav"; sha256: string; byte_length: number }>;
  status: "COMPLETED";
};

type BackendEvent = {
  event?: string;
  status?: string;
  progress?: number;
  message?: string;
  chunk?: BackendChunkCompleted | {
    analysis: BeatAnalysisResult & { sample_rate: number };
    boundaries: Array<{ index: number; bar_number: number | null; start_sample: number; end_sample: number; sample_rate: number }>;
  };
};

export type BackendSeparationCallbacks = {
  onChunk?: (section: SeparatedSection, metadata: BackendChunkCompleted) => void;
  onProgress?: (event: BackendEvent) => void;
  onComplete?: (manifest: unknown[]) => void;
  onError?: (error: Error) => void;
};

function apiUrl(path: string) {
  const base = BACKEND_API_BASE.startsWith("http") ? BACKEND_API_BASE : `${window.location.origin}${BACKEND_API_BASE}`;
  if (path.startsWith("/")) return new URL(path, new URL(base).origin).toString();
  return new URL(path.replace(/^\/+/, ""), `${base.replace(/\/$/, "")}/`).toString();
}

export async function startBackendSeparationFromFile(
  file: File,
  audio: AudioBuffer,
  strategy: AnalysisStrategy,
  callbacks: BackendSeparationCallbacks,
  beatsPerBar = 4,
) {
  const projectResponse = await fetch(apiUrl("projects"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "DubPad Project" }),
  });
  if (!projectResponse.ok) throw new Error(`Could not create backend project (${projectResponse.status}).`);
  const project = await projectResponse.json() as { id: string };
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("sample_rate", String(audio.sampleRate));
  form.set("channels", String(audio.numberOfChannels));
  form.set("frame_count", String(audio.length));
  const uploadResponse = await fetch(apiUrl(`projects/${encodeURIComponent(project.id)}/audio`), { method: "POST", body: form });
  if (!uploadResponse.ok) throw new Error(`Could not upload audio to HTDemucs (${uploadResponse.status}): ${await uploadResponse.text()}`);
  const asset = await uploadResponse.json() as { id: string };
  return startBackendSeparation(project.id, asset.id, strategy, callbacks, beatsPerBar);
}

function websocketUrl(path: string) {
  const url = new URL(apiUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeFloatWav(
  bytes: ArrayBuffer,
  stem: string,
  chunk: BackendChunkCompleted,
): Float32Array[] {
  const view = new DataView(bytes);
  const fourcc = (offset: number) => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
  if (view.byteLength < 44 || fourcc(0) !== "RIFF" || fourcc(8) !== "WAVE") {
    throw new Error(`${stem} chunk is not a valid RIFF/WAVE file.`);
  }
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const id = fourcc(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength) throw new Error(`${stem} WAV chunk is truncated.`);
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      blockAlign = view.getUint16(body + 12, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = size;
    }
    offset = body + size + (size & 1);
  }
  const expectedFrames = chunk.source_sample_end - chunk.source_sample_start;
  const expectedChannels = chunk.stems[stem as keyof BackendChunkCompleted["stems"]]?.channels;
  const expectedRate = chunk.stems[stem as keyof BackendChunkCompleted["stems"]]?.sample_rate ?? chunk.sample_rate;
  if (format !== 3 || bitsPerSample !== 32 || sampleRate !== chunk.sample_rate ||
      sampleRate !== expectedRate || channels < 1 || channels > 2 ||
      (expectedChannels !== undefined && channels !== expectedChannels) || blockAlign !== channels * 4 ||
      dataOffset < 0 || dataBytes !== expectedFrames * blockAlign ||
      chunk.stems[stem as keyof BackendChunkCompleted["stems"]]?.frame_count !== expectedFrames ||
      chunk.stems[stem as keyof BackendChunkCompleted["stems"]]?.audio_format !== "wav" ||
      chunk.stems[stem as keyof BackendChunkCompleted["stems"]]?.byte_length !== bytes.byteLength) {
    throw new Error(`${stem} WAV format or sample frame count does not match the chunk manifest.`);
  }
  const output = Array.from({ length: channels }, () => new Float32Array(expectedFrames));
  for (let frame = 0; frame < expectedFrames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      output[channel][frame] = view.getFloat32(dataOffset + frame * blockAlign + channel * 4, true);
    }
  }
  return output;
}

function chunkManifest(chunk: BackendChunkCompleted): LocalChunkManifest {
  const section: Omit<SeparatedSection, "stems"> = {
    id: chunk.chunk_id,
    index: chunk.chunk_index,
    startBar: chunk.bar_number ?? 0,
    endBar: chunk.bar_number === null ? 0 : chunk.bar_number + 1,
    startTime: chunk.start_seconds,
    endTime: chunk.end_seconds,
    startSample: chunk.source_sample_start,
    endSample: chunk.source_sample_end,
    sampleRate: chunk.sample_rate,
  };
  return { id: chunk.chunk_id, projectId: ACTIVE_LOCAL_PROJECT_ID, jobId: chunk.job_id, chunkIndex: chunk.chunk_index, section, stemMetadata: chunk.stems };
}

async function fetchAndPersistChunk(chunk: BackendChunkCompleted, signal?: AbortSignal): Promise<SeparatedSection> {
  const metadata = chunkManifest(chunk);
  const stems = {} as SeparatedSection["stems"];
  for (const name of ["drums", "bass", "other", "vocals"] as const) {
    const descriptor = chunk.stems[name];
    if (!descriptor.sha256) throw new Error(`Server manifest does not include a ${name} checksum; rerun this job on the updated backend.`);
    let existing = await getLocalChunkStem(chunk.chunk_id, name);
    if (existing && await sha256Hex(await existing.blob.arrayBuffer()) !== descriptor.sha256) {
      await deleteLocalChunkStem(chunk.chunk_id, name);
      existing = undefined;
    }
    let blob: Blob;
    let samples: Float32Array[];
    if (existing) {
      blob = existing.blob;
      samples = decodeFloatWav(await blob.arrayBuffer(), name, chunk);
    } else {
      const response = await fetch(apiUrl(descriptor.url), { signal });
      if (!response.ok) throw new Error(`Could not fetch ${name} chunk (${response.status}); retry is safe.`);
      const bytes = await response.arrayBuffer();
      const checksum = await sha256Hex(bytes);
      if (checksum !== descriptor.sha256) throw new Error(`${name} chunk checksum mismatch; retry is safe.`);
      samples = decodeFloatWav(bytes, name, chunk);
      blob = new Blob([bytes], { type: "audio/wav" });
      await persistLocalChunkStem(metadata, name, blob, checksum);
    }
    stems[name] = samples;
  }
  await markLocalChunkPersisted(chunk.chunk_id);
  const checksums = Object.fromEntries(Object.entries(chunk.stems).map(([name, stem]) => [name, stem.sha256]));
  let ackError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ackResponse = await fetch(apiUrl(`jobs/${encodeURIComponent(chunk.job_id)}/chunks/${chunk.chunk_index}/ack`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunk_id: chunk.chunk_id, checksums }),
      });
      if (ackResponse.ok) { ackError = undefined; break; }
      ackError = new Error(`Chunk is stored locally, but server acknowledgement failed (${ackResponse.status}).`);
    } catch (error) {
      ackError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (ackError) console.warn("[Chunk delivery] persisted chunk awaits acknowledgement recovery", { chunkId: chunk.chunk_id, error: ackError.message });
  return { ...metadata.section, stems };
}

function activatePersistedChunk(section: SeparatedSection) {
  addSeparatedSection(section);
  audioEngine.prepareSection(section);
  registerSectionClips(section);
  setSectionProgress(section.id, 100);
}

/** Starts a Rust HTDemucs job and consumes completed four-stem chunks over WS + HTTP. */
export async function startBackendSeparation(
  projectId: string,
  audioAssetId: string,
  strategy: AnalysisStrategy,
  callbacks: BackendSeparationCallbacks,
  beatsPerBar = 4,
) {
  const response = await fetch(apiUrl(`projects/${encodeURIComponent(projectId)}/jobs`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_asset_id: audioAssetId, job_type: "separate", analysis_strategy: strategy, beats_per_bar: beatsPerBar }),
  });
  if (!response.ok) throw new Error(`Could not create separation job (${response.status}): ${await response.text()}`);
  const job = await response.json() as { id: string };
  await saveBackendJobId(job.id);
  setProjectStatus("separating");
  const socket = new WebSocket(websocketUrl(`jobs/${encodeURIComponent(job.id)}/events`));
  let closed = false;
  const seenChunks = new Set<string>();
  const inFlightChunks = new Map<string, Promise<void>>();
  const publishChunk = (chunk: BackendChunkCompleted): Promise<void> => {
    if (seenChunks.has(chunk.chunk_id)) return Promise.resolve();
    const existing = inFlightChunks.get(chunk.chunk_id);
    if (existing) return existing;
    const work = (async () => {
      const section = await fetchAndPersistChunk(chunk);
      activatePersistedChunk(section);
      seenChunks.add(chunk.chunk_id);
      callbacks.onChunk?.(section, chunk);
    })();
    const tracked = work.finally(() => inFlightChunks.delete(chunk.chunk_id));
    inFlightChunks.set(chunk.chunk_id, tracked);
    return tracked;
  };
  let eventQueue = Promise.resolve();
  socket.onmessage = (message) => {
    eventQueue = eventQueue.then(async () => {
      const event = JSON.parse(String(message.data)) as BackendEvent;
      callbacks.onProgress?.(event);
      if (event.event === "beat_analysis.completed" && event.chunk && "analysis" in event.chunk) {
        setExternalBeatMarkerGrid(event.chunk.analysis, event.chunk.analysis.sample_rate);
        setBackendChunkSchedule(job.id, event.chunk.boundaries);
      }
      if (event.event === "chunk.completed" && event.chunk && "status" in event.chunk && event.chunk.status === "COMPLETED") {
        await publishChunk(event.chunk);
      }
      if (event.status === "SUCCEEDED" && !closed) {
        closed = true;
        const manifestResponse = await fetch(apiUrl(`jobs/${encodeURIComponent(job.id)}/chunks`));
        if (!manifestResponse.ok) throw new Error("Could not retrieve final chunk manifest.");
        const manifest = await manifestResponse.json() as Array<{
          chunk_id: string; chunk_index: number; bar_number: number | null;
          start_seconds: number; end_seconds: number; source_sample_start: number;
          source_sample_end: number; sample_rate: number;
          stem_metadata: BackendChunkCompleted["stems"];
          client_persisted_at: string | null;
        }>;
        setBackendChunkSchedule(job.id, manifest.map((chunk) => ({
          index: chunk.chunk_index,
          bar_number: chunk.bar_number,
          start_sample: chunk.source_sample_start,
          end_sample: chunk.source_sample_end,
          sample_rate: chunk.sample_rate,
        })));
        for (const row of manifest) {
          const chunk: BackendChunkCompleted = {
            job_id: job.id,
            chunk_id: row.chunk_id,
            chunk_index: row.chunk_index,
            bar_number: row.bar_number,
            start_seconds: row.start_seconds,
            end_seconds: row.end_seconds,
            duration_seconds: row.end_seconds - row.start_seconds,
            source_sample_start: row.source_sample_start,
            source_sample_end: row.source_sample_end,
            sample_rate: row.sample_rate,
            stems: row.stem_metadata,
            status: "COMPLETED",
          };
          if (!seenChunks.has(chunk.chunk_id)) await publishChunk(chunk);
        }
        const analysisResponse = await fetch(apiUrl(`jobs/${encodeURIComponent(job.id)}/beat-analysis`));
        if (analysisResponse.ok) {
          const analysisJob = await analysisResponse.json() as { result: BeatAnalysisResult | null };
          if (analysisJob.result) setExternalBeatMarkerGrid(analysisJob.result, analysisJob.result.sample_rate);
        }
        callbacks.onComplete?.(manifest);
        finishSeparation();
        socket.close();
      } else if (["FAILED", "CANCELLED"].includes(event.status ?? "")) {
        callbacks.onError?.(new Error(event.message || `Separation job ${event.status?.toLowerCase()}.`));
        socket.close();
      }
    }).catch((error: unknown) => callbacks.onError?.(error instanceof Error ? error : new Error(String(error))));
  };
  socket.onerror = () => callbacks.onError?.(new Error("Separation job WebSocket connection failed."));
  socket.onclose = () => {
    if (closed) return;
    void recoverBackendChunks(job.id)
      .then((count) => {
        if (closed) return;
        closed = true;
        callbacks.onProgress?.({ event: "chunks.recovered", message: `Recovered ${count} missing chunks from the server manifest.` });
        callbacks.onComplete?.([]);
      })
      .catch((error: unknown) => callbacks.onError?.(error instanceof Error ? error : new Error(String(error))));
  };
  return { jobId: job.id, close: () => { closed = true; socket.close(); } };
}

/** Reconcile a saved project against a server manifest after a reload/reconnect. */
export async function recoverBackendChunks(jobId: string, signal?: AbortSignal): Promise<number> {
  let restored = 0;
  let jobStatus: string = "RUNNING";
  while (jobStatus === "RUNNING" || jobStatus === "QUEUED") {
    const response = await fetch(apiUrl(`jobs/${encodeURIComponent(jobId)}/chunks`), { signal });
    if (!response.ok) throw new Error(`Could not recover chunk manifest (${response.status}).`);
    const manifest = await response.json() as Array<{
      chunk_id: string; chunk_index: number; bar_number: number | null;
      start_seconds: number; end_seconds: number; source_sample_start: number;
      source_sample_end: number; sample_rate: number; stem_metadata: BackendChunkCompleted["stems"];
      client_persisted_at: string | null;
    }>;
    for (const row of manifest) {
    const chunk: BackendChunkCompleted = {
      job_id: jobId,
      chunk_id: row.chunk_id,
      chunk_index: row.chunk_index,
      bar_number: row.bar_number,
      start_seconds: row.start_seconds,
      end_seconds: row.end_seconds,
      duration_seconds: row.end_seconds - row.start_seconds,
      source_sample_start: row.source_sample_start,
      source_sample_end: row.source_sample_end,
      sample_rate: row.sample_rate,
      stems: row.stem_metadata,
      status: "COMPLETED",
    };
    const existing = await getLocalChunkRecord(chunk.chunk_id);
    if (existing?.status === "CLIENT_PERSISTED" && existing.receivedStems.length === 4) {
      if (row.client_persisted_at) continue;
      // Re-acknowledge idempotently if a prior response was lost after the IDB commit.
      const ack = await fetch(apiUrl(`jobs/${encodeURIComponent(jobId)}/chunks/${chunk.chunk_index}/ack`), {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunk_id: chunk.chunk_id, checksums: existing.checksums }),
      });
      if (!ack.ok) throw new Error(`Could not re-acknowledge saved chunk ${chunk.chunk_id} (${ack.status}).`);
      continue;
    }
    const section = await fetchAndPersistChunk(chunk, signal);
    activatePersistedChunk(section);
    restored++;
    }
    const jobResponse = await fetch(apiUrl(`jobs/${encodeURIComponent(jobId)}`), { signal });
    if (!jobResponse.ok) throw new Error(`Could not recover job state (${jobResponse.status}).`);
    const job = await jobResponse.json() as { status: string };
    jobStatus = job.status;
    if (jobStatus === "RUNNING" || jobStatus === "QUEUED") {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 1_500);
        signal?.addEventListener("abort", () => {
          window.clearTimeout(timer);
          reject(new DOMException("Chunk recovery cancelled", "AbortError"));
        }, { once: true });
      });
    }
  }
  if (jobStatus === "FAILED" || jobStatus === "CANCELLED") throw new Error(`Chunk recovery stopped because job is ${jobStatus.toLowerCase()}.`);
  if (jobStatus === "SUCCEEDED") {
    const analysisResponse = await fetch(apiUrl(`jobs/${encodeURIComponent(jobId)}/beat-analysis`), { signal });
    if (analysisResponse.ok) {
      const analysis = await analysisResponse.json() as { result: BeatAnalysisResult | null };
      if (analysis.result) setExternalBeatMarkerGrid(analysis.result, analysis.result.sample_rate);
    }
    finishSeparation();
  }
  return restored;
}
