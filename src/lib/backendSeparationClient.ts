import { API_BASE_URL } from "./api";
import { audioEngine } from "../features/audio-engine/AudioEngine";
import type { SeparationSection, StemName } from "../features/stem-separation/chunkEngine";
import type { SeparatedSection } from "../features/stem-separation/separationScheduler";
import { assembleMasterTimelineSections } from "../features/stem-separation/separationPlan";
import { getClipState, registerSectionClips, resetClips, setClipLoop } from "../stores/clip.store";
import { restoreClipSnapshot, type AudioClip } from "../stores/clip.store";
import {
  addSeparatedSection,
  finishSeparation,
  getProjectState,
  setArrangementSections,
  setBackendBeatTimeline,
  setProjectError,
  setProjectStatus,
  setSegmentSizePreference,
  restoreProjectSnapshot,
  type ProjectState,
} from "../stores/project.store";
import { replaceLocalSections, saveBackendJobId, saveLocalSection } from "./localProjectStore";

export type AnalysisStrategy = "mix_first" | "drums_first";
const BACKEND_API_BASE = API_BASE_URL;
const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const;
export type ArrangementSegmentSize = "1bar" | "2bars" | "4bars" | "beat";

export type BeatGridEvent = { timeSeconds: number; samplePosition: number; bar?: number };
export type BeatGrid = {
  schemaVersion: number;
  jobId: string;
  projectId: string;
  audio: {
    sampleRate: number;
    channels: number;
    frames: number;
    durationSeconds: number;
    samplePositionUnit: "frames";
    stems: Record<StemName, string>;
  };
  analysis: {
    engine: string;
    engineVersion: string | null;
    modelVersion: string | null;
    inputStem: string;
    bpm: number | null;
    beatsPerBar: number;
    beats: BeatGridEvent[];
    downbeats: BeatGridEvent[];
    metadata: unknown;
  };
};

export type BackendJob = {
  id: string;
  project_id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  progress: number;
  error_message: string | null;
  result_metadata: {
    projectId?: string;
    analysisUrl?: string;
    stems?: Partial<Record<StemName, { url?: string; sampleRate?: number; channels?: number; frames?: number }>>;
  };
};

type ProjectStem = {
  name: StemName;
  audioUrl: string;
  sampleRate: number;
  channels: number;
  frames: number;
  durationSeconds: number;
  fileSizeBytes: number;
};

type BackendProject = {
  project: { id: string };
  stems: ProjectStem[];
};

type BackendProjectDetails = {
  project: { id: string; name: string };
  project_state: Partial<ProjectState> & { clips?: AudioClip[] | Record<string, AudioClip> };
  jobs: BackendJob[];
  audio_assets: Array<{ original_filename: string; content_type: string }>;
  stems: ProjectStem[];
};

/** Restore the last server project by ID; audio remains segment-fetched on demand. */
export async function restoreLastServerProject(signal?: AbortSignal): Promise<boolean> {
  let projectId: string | null;
  try { projectId = localStorage.getItem("dubpad:last-server-project"); } catch { return false; }
  if (!projectId) return false;
  const response = await fetch(apiUrl(`projects/${encodeURIComponent(projectId)}`), { signal });
  if (response.status === 410) {
    try { localStorage.removeItem("dubpad:last-server-project"); } catch { /* ignore */ }
    return false;
  }
  const details = await responseJson<BackendProjectDetails>(response, "Could not restore server project");
  if (details.project.id !== projectId) throw new Error("Server returned a different project ID.");
  const saved = details.project_state ?? {};
  const fileInfo = details.audio_assets[0];
  const placeholder = new File([], fileInfo?.original_filename ?? details.project.name, { type: fileInfo?.content_type ?? "audio/wav" });
  restoreProjectSnapshot(placeholder, null, {
    backendProjectId: projectId,
    serverSaveStatus: "saved",
    analysis: saved.analysis ?? null,
    masterTimeline: saved.masterTimeline ?? null,
    beatMarkerGrid: saved.beatMarkerGrid ?? null,
    timelineCorrections: saved.timelineCorrections ?? {},
    beatSnapMode: saved.beatSnapMode ?? "off",
    downbeatPhaseOffsetSamples: saved.downbeatPhaseOffsetSamples ?? 0,
    segmentSize: saved.segmentSize ?? "4bars",
    sections: saved.sections ?? [],
    status: "imported",
  }, []);
  const clips = saved.clips;
  if (clips) restoreClipSnapshot(Array.isArray(clips) ? Object.fromEntries(clips.map((clip) => [clip.id, clip])) : clips);
  const latest = details.jobs.find((job) => job.status === "SUCCEEDED") ?? details.jobs[0];
  if (latest) await recoverBackendJob(latest.id, signal);
  return true;
}

type BackendStemMetadata = {
  name?: string;
  url?: string;
  sample_rate?: number;
  channels?: number;
  frame_count?: number;
  duration_seconds?: number;
  audio_format?: string;
  file_size_bytes?: number;
};

type BackendEvent = {
  event?: string;
  stage?: string;
  status?: string;
  progress?: number;
  message?: string;
  job_id?: string;
  chunk?: { segmentId?: string };
  stem?: string;
  stem_metadata?: BackendStemMetadata;
};

export type BackendSeparationCallbacks = {
  onProgress?: (event: BackendEvent) => void;
  onStemCompleted?: (stem: StemName) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
};

function apiUrl(path: string) {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const base = BACKEND_API_BASE.startsWith("http") ? BACKEND_API_BASE : `${origin}${BACKEND_API_BASE}`;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/")) return new URL(path, new URL(base).origin).toString();
  return new URL(path.replace(/^\/+/, ""), `${base.replace(/\/$/, "")}/`).toString();
}

async function responseJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) throw new Error(`${message} (${response.status}): ${await response.text()}`);
  return response.json() as Promise<T>;
}

export function decodeStemWav(bytes: ArrayBuffer, expected: Pick<ProjectStem, "name" | "sampleRate" | "channels" | "frames">): Float32Array[] {
  const view = new DataView(bytes);
  const fourcc = (offset: number) => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  );
  if (view.byteLength < 44 || fourcc(0) !== "RIFF" || fourcc(8) !== "WAVE") {
    throw new Error(`${expected.name} stem is not a valid RIFF/WAVE file.`);
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
    if (body + size > view.byteLength) throw new Error(`${expected.name} WAV data is truncated.`);
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

  const bytesPerSample = bitsPerSample / 8;
  const supportedPcm = format === 1 && [8, 16, 24, 32].includes(bitsPerSample);
  const supportedFloat = format === 3 && bitsPerSample === 32;
  if ((!supportedPcm && !supportedFloat) || sampleRate !== expected.sampleRate ||
    channels !== expected.channels || channels < 1 || blockAlign !== channels * bytesPerSample ||
    dataOffset < 0 || dataBytes !== expected.frames * blockAlign ||
    dataOffset + dataBytes !== view.byteLength) {
    throw new Error(`${expected.name} WAV format or source frame metadata does not match the project manifest.`);
  }

  const output = Array.from({ length: channels }, () => new Float32Array(expected.frames));
  for (let frame = 0; frame < expected.frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const position = dataOffset + frame * blockAlign + channel * bytesPerSample;
      let sample: number;
      if (supportedFloat) sample = view.getFloat32(position, true);
      else if (bitsPerSample === 8) sample = (view.getUint8(position) - 128) / 128;
      else if (bitsPerSample === 16) sample = view.getInt16(position, true) / 32768;
      else if (bitsPerSample === 24) {
        let value = view.getUint8(position) | (view.getUint8(position + 1) << 8) | (view.getUint8(position + 2) << 16);
        if (value & 0x800000) value |= 0xff000000;
        sample = value / 8_388_608;
      } else sample = view.getInt32(position, true) / 2_147_483_648;
      output[channel][frame] = sample;
    }
  }
  return output;
}

export function buildSectionSchedule(
  jobId: string,
  sampleRate: number,
  frames: number,
  beatSamples: number[],
  downbeatSamples: number[],
  segmentSize: ArrangementSegmentSize = "4bars",
  beatsPerBar = 4,
): SeparationSection[] {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(frames) || frames <= 0 ||
    !Number.isInteger(beatsPerBar) || beatsPerBar <= 0) {
    throw new Error("Invalid source timeline for section generation.");
  }
  const sourceBoundaries = segmentSize === "beat"
    ? beatSamples
    : completeMissingDownbeats(beatSamples, downbeatSamples, beatsPerBar);
  for (const sample of sourceBoundaries) {
    if (!Number.isSafeInteger(sample) || sample < 0 || sample > frames) {
      throw new Error("Musical marker is outside the source frame timeline.");
    }
  }
  const markers = sourceBoundaries
    .filter((sample) => sample < frames)
    .slice()
    .sort((a, b) => a - b)
    .filter((sample, index, all) => index === 0 || sample !== all[index - 1]);
  const groupSize = segmentSize === "beat" ? 1 : Number(segmentSize[0]);
  const ranges: Array<{ start: number; end: number; startBar: number; endBar: number; kind: SeparationSection["kind"] }> = [];
  if (!markers.length) {
    ranges.push({ start: 0, end: frames, startBar: 0, endBar: 0, kind: "bars" });
  } else {
    if (markers[0] > 0) ranges.push({ start: 0, end: markers[0], startBar: 0, endBar: 0, kind: "pickup" });
    for (let index = 0; index < markers.length; index++) {
      ranges.push({
        start: markers[index],
        end: markers[index + 1] ?? frames,
        startBar: segmentSize === "beat" ? Math.floor(index / beatsPerBar) + 1 : index + 1,
        endBar: segmentSize === "beat" ? Math.floor(index / beatsPerBar) + 1 : index + 1,
        kind: "bars",
      });
    }
  }

  const grouped: typeof ranges = [];
  for (let index = 0; index < ranges.length;) {
    const first = ranges[index];
    if (first.kind === "pickup") {
      grouped.push(first);
      index++;
      continue;
    }
    const selected = ranges.slice(index, index + groupSize);
    grouped.push({
      start: selected[0].start,
      end: selected[selected.length - 1].end,
      startBar: selected[0].startBar,
      endBar: selected[selected.length - 1].endBar,
      kind: "bars",
    });
    index += selected.length;
  }

  return grouped.map((range, index) => {
    const id = `${jobId.replaceAll("-", "")}-${segmentSize}-${String(index).padStart(6, "0")}`;
    return {
      id,
      index,
      startBar: range.startBar,
      endBar: range.endBar,
      startTime: range.start / sampleRate,
      endTime: range.end / sampleRate,
      startSample: range.start,
      endSample: range.end,
      processStartSample: range.start,
      processEndSample: range.end,
      trimStartSample: 0,
      trimEndSample: range.end - range.start,
      duration: (range.end - range.start) / sampleRate,
      chunkIds: [`${id}:local`],
      kind: range.kind,
    };
  });
}

/**
 * Keep detected downbeats authoritative. If a downbeat is absent but the
 * detector supplied a complete beat sequence between two detected downbeats,
 * recover the missing bar starts from those integer beat frames. Incomplete
 * or irregular beat sequences are left as-is rather than guessed from BPM.
 */
function completeMissingDownbeats(beatSamples: number[], downbeatSamples: number[], beatsPerBar: number) {
  const downbeats = [...new Set(downbeatSamples)].sort((a, b) => a - b);
  if (downbeats.length < 2) return downbeats;
  const beats = [...new Set(beatSamples)].sort((a, b) => a - b);
  const recovered: number[] = [];
  for (let index = 0; index < downbeats.length - 1; index++) {
    const start = downbeats[index];
    const end = downbeats[index + 1];
    const between = beats.filter((sample) => sample > start && sample < end);
    if (between.length < beatsPerBar * 2 - 1 || (between.length + 1) % beatsPerBar !== 0) continue;
    for (let beatIndex = beatsPerBar - 1; beatIndex < between.length; beatIndex += beatsPerBar) {
      recovered.push(between[beatIndex]);
    }
  }
  return [...new Set([...downbeats, ...recovered])].sort((a, b) => a - b);
}

export function buildSectionsFromBeatGrid(
  jobId: string,
  grid: BeatGrid,
  stems: Record<StemName, Float32Array[]>,
  segmentSize: ArrangementSegmentSize = "4bars",
): SeparatedSection[] {
  const { sampleRate, frames, channels, durationSeconds } = grid.audio;
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(frames) || frames <= 0 ||
    !Number.isSafeInteger(channels) || channels < 1 || durationSeconds !== frames / sampleRate) {
    throw new Error("Beat grid has invalid source audio metadata.");
  }
  for (const name of STEM_NAMES) {
    if (stems[name].length !== channels || stems[name].some((channel) => channel.length !== frames)) {
      throw new Error(`${name} stem does not match the shared source sample timeline.`);
    }
  }

  for (const event of [...grid.analysis.beats, ...grid.analysis.downbeats]) {
    if (!Number.isSafeInteger(event.samplePosition) || event.samplePosition < 0 || event.samplePosition > frames ||
      !Number.isFinite(event.timeSeconds) || Math.round(event.timeSeconds * sampleRate) !== event.samplePosition) {
      throw new Error("Beat grid contains a timestamp that does not map to the original frame timeline.");
    }
  }
  const schedule = buildSectionSchedule(jobId, sampleRate, frames,
    grid.analysis.beats.map((beat) => beat.samplePosition),
    grid.analysis.downbeats.map((beat) => beat.samplePosition), segmentSize, grid.analysis.beatsPerBar);
  return schedule.map((section) => {
    return {
      ...section,
      sampleRate,
      stems: Object.fromEntries(STEM_NAMES.map((name) => [name, stems[name].map((channel) => channel.slice(section.startSample, section.endSample))])) as Record<StemName, Float32Array[]>,
    };
  });
}

/** Re-segment already loaded PCM locally; this performs no network requests. */
export function regroupSectionsFromTimeline(
  sections: SeparatedSection[],
  sampleRate: number,
  beatSamples: number[],
  downbeatSamples: number[],
  beatsPerBar: number,
  segmentSize: ArrangementSegmentSize,
): SeparatedSection[] {
  const ordered = sections.slice().sort((left, right) => left.startSample - right.startSample);
  const frames = ordered.at(-1)?.endSample ?? 0;
  if (!ordered.length || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 || frames <= 0) {
    throw new Error("No complete local stem audio is available to re-segment.");
  }
  const schedule = buildSectionSchedule("local", sampleRate, frames, beatSamples, downbeatSamples, segmentSize, beatsPerBar);
  const targets = schedule.map((section) => ({ ...section, sampleRate, stems: {} as SeparatedSection["stems"] }));
  const assembled = assembleMasterTimelineSections(ordered, targets, sampleRate);
  return assembled.map((section, index) => ({ ...section, kind: schedule[index].kind }));
}

/** Apply a segment-size change to the current arrangement without downloading stems again. */
export async function changeArrangementSegmentSize(segmentSize: ArrangementSegmentSize, force = false) {
  const project = getProjectState();
  if (!force && project.segmentSize === segmentSize) return;
  const sections = Object.values(project.completedSections);
  if (!sections.length || !project.masterTimeline) {
    setSegmentSizePreference(segmentSize);
    return;
  }
  try {
    const previousActiveClips = Object.values(getClipState().clips).filter((clip) => clip.active);
    const regrouped = regroupSectionsFromTimeline(
      sections,
      project.masterTimeline.sampleRate,
      project.masterTimeline.beatSamples,
      project.masterTimeline.downbeatSamples,
      project.masterTimeline.meter,
      segmentSize,
    );
    await replaceLocalSections(regrouped);
    audioEngine.stop();
    audioEngine.clearPreparedBuffers();
    resetClips();
    setArrangementSections(regrouped, segmentSize);
    for (const section of regrouped) {
      audioEngine.prepareSection(section);
      registerSectionClips(section);
      for (const stem of STEM_NAMES) {
        const previousClip = previousActiveClips
          .filter((clip) => clip.stem === stem && clip.startTime < section.endTime && clip.endTime > section.startTime)
          .sort((left, right) => Math.abs(left.startTime - section.startTime) - Math.abs(right.startTime - section.startTime))[0];
        if (previousClip && !previousClip.loopEnabled) setClipLoop(`${stem}:${section.id}`, false);
      }
    }
  } catch (error) {
    setProjectError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function fetchSuccessfulJobAudio(
  job: BackendJob,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  segmentSize: ArrangementSegmentSize = "4bars",
): Promise<{ grid: BeatGrid; sections: SeparatedSection[] }> {
  if (job.status !== "SUCCEEDED") throw new Error(`Separation job is ${job.status.toLowerCase()}.`);
  const metadataProjectId = job.result_metadata?.projectId;
  if (!metadataProjectId || metadataProjectId !== job.project_id) {
    throw new Error("Successful job metadata is missing its matching project ID.");
  }
  const analysisPath = job.result_metadata.analysisUrl;
  if (!analysisPath) throw new Error("Successful job metadata has no analysisUrl.");

  const [projectResponse, analysisResponse] = await Promise.all([
    fetcher(apiUrl(`projects/${encodeURIComponent(metadataProjectId)}`), { signal }),
    fetcher(apiUrl(analysisPath), { signal }),
  ]);
  const project = await responseJson<BackendProject>(projectResponse, "Could not load project metadata");
  const grid = await responseJson<BeatGrid>(analysisResponse, "Could not load the saved beat grid");
  if (project.project.id !== metadataProjectId || grid.projectId !== metadataProjectId || grid.jobId !== job.id ||
    grid.audio.samplePositionUnit !== "frames") {
    throw new Error("Project, job, and analysis metadata do not describe the same source timeline.");
  }

  const projectStems = new Map(project.stems.map((stem) => [stem.name, stem]));
  const decoded = {} as Record<StemName, Float32Array[]>;
  for (const stemName of STEM_NAMES) {
    const projectStem = projectStems.get(stemName);
    const jobStem = job.result_metadata.stems?.[stemName];
    const beatGridUrl = grid.audio.stems[stemName];
    if (!projectStem || !jobStem?.url || !beatGridUrl ||
      projectStem.audioUrl !== jobStem.url || projectStem.audioUrl !== beatGridUrl ||
      projectStem.sampleRate !== grid.audio.sampleRate || projectStem.channels !== grid.audio.channels ||
      projectStem.frames !== grid.audio.frames || jobStem.sampleRate !== grid.audio.sampleRate ||
      jobStem.channels !== grid.audio.channels || jobStem.frames !== grid.audio.frames) {
      throw new Error(`${stemName} metadata does not match the shared beat-grid sample timeline.`);
    }
    const response = await fetcher(apiUrl(jobStem.url), { signal });
    if (!response.ok) throw new Error(`Could not fetch the complete ${stemName} stem (${response.status}).`);
    decoded[stemName] = decodeStemWav(await response.arrayBuffer(), {
      name: stemName,
      sampleRate: projectStem.sampleRate,
      channels: projectStem.channels,
      frames: projectStem.frames,
    });
  }

  const sections = buildSectionsFromBeatGrid(job.id, grid, decoded, segmentSize);
  return { grid, sections };
}

async function loadSuccessfulJob(job: BackendJob, signal?: AbortSignal): Promise<SeparatedSection[]> {
  const segmentSize = getProjectState().segmentSize;
  const { grid, sections } = await fetchSuccessfulJobAudio(job, fetch, signal, segmentSize);
  audioEngine.stop();
  audioEngine.clearPreparedBuffers();
  resetClips();
  setBackendBeatTimeline(grid, sections, segmentSize);
  for (const section of sections) {
    audioEngine.prepareSection(section);
    registerSectionClips(section);
  }
  await Promise.all(sections.map(saveLocalSection));
  finishSeparation();
  return sections;
}

async function getJob(jobId: string, signal?: AbortSignal): Promise<BackendJob> {
  return responseJson<BackendJob>(await fetch(apiUrl(`jobs/${encodeURIComponent(jobId)}`), { signal }), "Could not retrieve separation job");
}

function websocketUrl(path: string) {
  const url = new URL(apiUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function startBackendSeparationFromFile(
  file: File,
  audio: AudioBuffer,
  strategy: AnalysisStrategy,
  callbacks: BackendSeparationCallbacks,
  beatsPerBar = 4,
  signal?: AbortSignal,
) {
  const projectResponse = await fetch(apiUrl("projects"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "DubPad Project" }),
    signal,
  });
  const project = await responseJson<{ id: string }>(projectResponse, "Could not create backend project");
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("sample_rate", String(audio.sampleRate));
  form.set("channels", String(audio.numberOfChannels));
  form.set("frame_count", String(audio.length));
  const uploadResponse = await fetch(apiUrl(`projects/${encodeURIComponent(project.id)}/audio`), { method: "POST", body: form, signal });
  const asset = await responseJson<{ id: string }>(uploadResponse, "Could not upload audio for HTDemucs");
  return startBackendSeparation(project.id, asset.id, strategy, callbacks, beatsPerBar, signal);
}

/** Starts HTDemucs and loads the persisted full stems and beat grid after completion. */
export async function startBackendSeparation(
  projectId: string,
  audioAssetId: string,
  strategy: AnalysisStrategy,
  callbacks: BackendSeparationCallbacks,
  beatsPerBar = 4,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
  const response = await fetch(apiUrl(`projects/${encodeURIComponent(projectId)}/jobs`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio_asset_id: audioAssetId, job_type: "separate", analysis_strategy: strategy, beats_per_bar: beatsPerBar }),
    signal,
  });
  const job = await responseJson<BackendJob>(response, "Could not create separation job");
  await saveBackendJobId(job.id);
  setProjectStatus("separating");

  const socket = new WebSocket(websocketUrl(`jobs/${encodeURIComponent(job.id)}/events`));
  if (signal?.aborted) {
    socket.close();
    throw new DOMException("Operation aborted", "AbortError");
  }
  let manualClose = false;
  let completed = false;
  let completion: Promise<void> | undefined;

  // A stem.completed event is emitted only after the backend has validated
  // and atomically published the partial WAV. Download it immediately so the
  // arrangement can expose that track while the other stems are still running.
  const partialStemBuffers: Partial<Record<StemName, Float32Array[]>> = {};
  const partialLoads = new Map<StemName, Promise<void>>();
  let partialSource: { sampleRate: number; channels: number; frames: number } | null = null;

  const receivePartialStem = async (event: BackendEvent, stem: StemName) => {
    const metadata = event.stem_metadata;
    const sampleRate = metadata?.sample_rate;
    const channels = metadata?.channels;
    const frames = metadata?.frame_count;
    const url = metadata?.url;

    if (!url || metadata?.audio_format !== "wav" ||
      typeof sampleRate !== "number" || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 ||
      typeof channels !== "number" || !Number.isSafeInteger(channels) || channels < 1 || channels > 2 ||
      typeof frames !== "number" || !Number.isSafeInteger(frames) || frames <= 0) {
      throw new Error(`The backend returned invalid metadata for the ${stem} stem.`);
    }

    if (partialSource &&
      (partialSource.sampleRate !== sampleRate ||
        partialSource.channels !== channels ||
        partialSource.frames !== frames)) {
      throw new Error(`${stem} stem does not match the source timeline of the other completed stems.`);
    }
    partialSource ??= { sampleRate, channels, frames };

    const response = await fetch(apiUrl(url), { signal });
    if (!response.ok) {
      throw new Error(`Could not download the completed ${stem} stem (${response.status}).`);
    }
    const decoded = decodeStemWav(await response.arrayBuffer(), {
      name: stem,
      sampleRate,
      channels,
      frames,
    });
    if (signal?.aborted) return;

    partialStemBuffers[stem] = decoded;
    const sectionId = `${job.id.replaceAll("-", "")}-partial-full-track`;
    const section: SeparatedSection = {
      id: sectionId,
      index: 0,
      startBar: 0,
      endBar: 0,
      startTime: 0,
      endTime: frames / sampleRate,
      startSample: 0,
      endSample: frames,
      sampleRate,
      // Missing stems remain empty. AudioEngine and registerSectionClips
      // only prepare tracks whose PCM has arrived.
      stems: {
        drums: partialStemBuffers.drums ?? [],
        bass: partialStemBuffers.bass ?? [],
        other: partialStemBuffers.other ?? [],
        vocals: partialStemBuffers.vocals ?? [],
      },
    };

    addSeparatedSection(section);
    audioEngine.prepareSection(section);
    registerSectionClips(section);
    callbacks.onStemCompleted?.(stem);
  };

  const schedulePartialStem = (event: BackendEvent) => {
    if (!event.stem || !STEM_NAMES.includes(event.stem as StemName)) return;
    const stem = event.stem as StemName;
    if (partialStemBuffers[stem] || partialLoads.has(stem)) return;

    const task = receivePartialStem(event, stem);
    partialLoads.set(stem, task);
    void task.catch((error: unknown) => {
      if (signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Backend separation] Incremental ${stem} stem download failed:`, message);
      callbacks.onProgress?.({
        event: "stem.download_failed",
        stem,
        message: `${stem} is ready on the server but could not be downloaded yet; it will be loaded after processing finishes.`,
      });
    }).finally(() => {
      if (partialLoads.get(stem) === task) partialLoads.delete(stem);
    });
  };

  const waitForPartialLoads = async () => {
    await Promise.allSettled([...partialLoads.values()]);
  };

  const complete = () => {
    if (completion) return completion;
    completion = (async () => {
      await waitForPartialLoads();
      let latest = await getJob(job.id, signal);
      while (latest.status === "QUEUED" || latest.status === "RUNNING") {
        await abortableDelay(1_000, signal);
        latest = await getJob(job.id, signal);
      }
      if (latest.status !== "SUCCEEDED") throw new Error(latest.error_message || `Separation job ${latest.status.toLowerCase()}.`);
      callbacks.onProgress?.({
        stage: "LOADING_AUDIO",
        message: "Retrieving the saved beat grid and four full-length stems",
      });
      await loadSuccessfulJob(latest, signal);
      completed = true;
      callbacks.onComplete?.();
      socket.close();
    })().catch((error: unknown) => {
      completion = undefined;
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    void completion.catch(() => undefined);
    return completion;
  };

  socket.onmessage = (message) => {
    if (signal?.aborted) return;
    try {
      const event = JSON.parse(String(message.data)) as BackendEvent;
      if (event.event === "stem.completed") schedulePartialStem(event);
      callbacks.onProgress?.(event);
      if (event.status === "SUCCEEDED") void complete().catch(() => undefined);
      if (event.status === "FAILED" || event.status === "CANCELLED") {
        manualClose = true;
        callbacks.onError?.(new Error(event.message || `Separation job ${event.status.toLowerCase()}.`));
        socket.close();
      }
    } catch (error) {
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  socket.onerror = () => {
    if (!signal?.aborted) callbacks.onError?.(new Error("Separation job WebSocket connection failed."));
  };
  socket.onclose = () => {
    if (manualClose || completed || completion || signal?.aborted) return;
    void (async () => {
      await waitForPartialLoads();
      await recoverBackendJob(job.id, signal);
      completed = true;
      callbacks.onComplete?.();
    })().catch((error: unknown) => callbacks.onError?.(error instanceof Error ? error : new Error(String(error))));
  };
  const close = () => { manualClose = true; socket.close(); };
  signal?.addEventListener("abort", close, { once: true });
  return { jobId: job.id, close };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Operation aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Restores a successful job from project and analysis metadata after reconnect or reload. */
export async function recoverBackendJob(jobId: string, signal?: AbortSignal): Promise<number> {
  let job = await getJob(jobId, signal);
  while (job.status === "QUEUED" || job.status === "RUNNING") {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 1_500);
      signal?.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(new DOMException("Job recovery cancelled", "AbortError"));
      }, { once: true });
    });
    job = await getJob(jobId, signal);
  }
  if (job.status !== "SUCCEEDED") throw new Error(job.error_message || `Separation job is ${job.status.toLowerCase()}.`);
  return (await loadSuccessfulJob(job, signal)).length;
}
