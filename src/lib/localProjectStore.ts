import type { AudioClip } from "../stores/clip.store";
import type { ProjectState } from "../stores/project.store";
import type { SeparatedSection } from "../features/stem-separation/separationScheduler";

const DB_NAME = "dubpad-local-projects";
export const ACTIVE_LOCAL_PROJECT_ID = "active";
const ACTIVE_PROJECT_ID = ACTIVE_LOCAL_PROJECT_ID;

type PersistedProjectState = Pick<ProjectState,
  "analysis" | "masterTimeline" | "beatMarkerGrid" | "timelineCorrections" |
  "beatSnapMode" | "downbeatPhaseOffsetSamples" | "segmentSize" | "sections" | "status">;

export type LocalProjectRecord = {
  id: typeof ACTIVE_PROJECT_ID;
  file: Blob;
  fileName: string;
  fileType: string;
  state: PersistedProjectState;
  clips: Record<string, AudioClip>;
  backendJobId?: string;
  savedAt: number;
};

export type LocalSectionRecord = { id: string; section: SeparatedSection };
export type PersistedChunkSection = Omit<SeparatedSection, "stems">;
export type LocalChunkManifest = {
  id: string;
  projectId: typeof ACTIVE_PROJECT_ID;
  jobId: string;
  chunkIndex: number;
  section: PersistedChunkSection;
  stemMetadata: Record<string, { url: string; sha256: string; byte_length: number; sample_rate: number; channels: number; frame_count: number; audio_format: string }>;
};
export type LocalChunkRecord = LocalChunkManifest & {
  receivedStems: string[];
  checksums: Record<string, string>;
  status: "PARTIAL" | "CLIENT_PERSISTED";
};
export type LocalChunkStemRecord = { key: string; chunkId: string; stem: string; blob: Blob; sha256: string };

const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("projects")) database.createObjectStore("projects", { keyPath: "id" });
      if (!database.objectStoreNames.contains("sections")) database.createObjectStore("sections", { keyPath: "id" });
      if (!database.objectStoreNames.contains("chunks")) database.createObjectStore("chunks", { keyPath: "id" });
      if (!database.objectStoreNames.contains("chunkStems")) database.createObjectStore("chunkStems", { keyPath: "key" });
      if (!database.objectStoreNames.contains("jobLinks")) database.createObjectStore("jobLinks", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
  });
}

async function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export async function saveLocalProject(file: File, state: ProjectState, clips: Record<string, AudioClip>) {
  const database = await openDb();
  try {
    const transaction = database.transaction("projects", "readwrite");
    const store = transaction.objectStore("projects");
    const previousRequest = store.get(ACTIVE_PROJECT_ID);
    previousRequest.onsuccess = () => {
      const previous = previousRequest.result as LocalProjectRecord | undefined;
      const record: LocalProjectRecord = {
        id: ACTIVE_PROJECT_ID,
        file,
        fileName: file.name,
        fileType: file.type,
        state: {
          analysis: state.analysis,
          masterTimeline: state.masterTimeline,
          beatMarkerGrid: state.beatMarkerGrid,
          timelineCorrections: state.timelineCorrections,
          beatSnapMode: state.beatSnapMode,
          downbeatPhaseOffsetSamples: state.downbeatPhaseOffsetSamples,
          segmentSize: state.segmentSize,
          sections: state.sections,
          status: state.status,
        },
        clips,
        backendJobId: previous?.backendJobId,
        savedAt: Date.now(),
      };
      store.put(record);
    };
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

export async function saveBackendJobId(jobId: string) {
  const database = await openDb();
  try {
    const transaction = database.transaction("jobLinks", "readwrite");
    transaction.objectStore("jobLinks").put({ id: ACTIVE_PROJECT_ID, backendJobId: jobId });
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function getLocalChunkRecord(chunkId: string): Promise<LocalChunkRecord | undefined> {
  const database = await openDb();
  try {
    return await requestResult(database.transaction("chunks").objectStore("chunks").get(chunkId)) as LocalChunkRecord | undefined;
  } finally {
    database.close();
  }
}

export async function getLocalChunkStem(chunkId: string, stem: string): Promise<LocalChunkStemRecord | undefined> {
  const database = await openDb();
  try {
    return await requestResult(database.transaction("chunkStems").objectStore("chunkStems").get(`${chunkId}:${stem}`)) as LocalChunkStemRecord | undefined;
  } finally {
    database.close();
  }
}

export async function deleteLocalChunkStem(chunkId: string, stem: string) {
  const database = await openDb();
  try {
    const transaction = database.transaction(["chunks", "chunkStems"], "readwrite");
    transaction.objectStore("chunkStems").delete(`${chunkId}:${stem}`);
    const request = transaction.objectStore("chunks").get(chunkId);
    request.onsuccess = () => {
      const previous = request.result as LocalChunkRecord | undefined;
      if (!previous) return;
      const checksums = { ...previous.checksums };
      delete checksums[stem];
      transaction.objectStore("chunks").put({
        ...previous,
        checksums,
        receivedStems: previous.receivedStems.filter((name) => name !== stem),
        status: "PARTIAL",
      } satisfies LocalChunkRecord);
    };
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

/** Store one verified stem so a later retry only needs to download missing stems. */
export async function persistLocalChunkStem(
  manifest: LocalChunkManifest,
  stem: typeof STEM_NAMES[number],
  blob: Blob,
  sha256: string,
) {
  const expected = manifest.stemMetadata[stem]?.sha256;
  if (!expected || expected !== sha256) throw new Error(`Missing or mismatched ${stem} chunk checksum.`);
  const database = await openDb();
  try {
    const transaction = database.transaction(["chunks", "chunkStems"], "readwrite");
    const chunkStore = transaction.objectStore("chunks");
    const stemStore = transaction.objectStore("chunkStems");
    const existing = stemStore.get(`${manifest.id}:${stem}`);
    existing.onsuccess = () => {
      const previousStem = existing.result as LocalChunkStemRecord | undefined;
      if (previousStem && previousStem.sha256 !== sha256) {
        transaction.abort();
        return;
      }
      if (!previousStem) stemStore.put({ key: `${manifest.id}:${stem}`, chunkId: manifest.id, stem, blob, sha256 } satisfies LocalChunkStemRecord);
      const storedChunk = chunkStore.get(manifest.id);
      storedChunk.onsuccess = () => {
        const previous = storedChunk.result as LocalChunkRecord | undefined;
        if (previous && (previous.jobId !== manifest.jobId || previous.section.startSample !== manifest.section.startSample || previous.section.endSample !== manifest.section.endSample)) {
          transaction.abort();
          return;
        }
        const checksums = { ...(previous?.checksums ?? {}), [stem]: sha256 };
        const receivedStems = [...new Set([...(previous?.receivedStems ?? []), stem])];
        chunkStore.put({
          ...manifest,
          checksums,
          receivedStems,
          status: previous?.status ?? "PARTIAL",
        } satisfies LocalChunkRecord);
      };
    };
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

/** The commit resolving means all four stem blobs and completion metadata are durable. */
export async function markLocalChunkPersisted(chunkId: string): Promise<LocalChunkRecord> {
  const database = await openDb();
  try {
    const transaction = database.transaction(["chunks", "chunkStems"], "readwrite");
    const chunkStore = transaction.objectStore("chunks");
    const stemStore = transaction.objectStore("chunkStems");
    let completed: LocalChunkRecord | undefined;
    const chunkRequest = chunkStore.get(chunkId);
    chunkRequest.onsuccess = () => {
      const chunk = chunkRequest.result as LocalChunkRecord | undefined;
      if (!chunk) { transaction.abort(); return; }
      const recordsRequest = stemStore.getAll(IDBKeyRange.bound(`${chunkId}:`, `${chunkId}:\uffff`));
      recordsRequest.onsuccess = () => {
        const stemRecords = recordsRequest.result as LocalChunkStemRecord[];
        const names = new Set(stemRecords.map((record) => record.stem));
        if (!STEM_NAMES.every((stem) => names.has(stem) && chunk.checksums[stem] === chunk.stemMetadata[stem]?.sha256)) {
          transaction.abort();
          return;
        }
        completed = { ...chunk, receivedStems: [...STEM_NAMES], status: "CLIENT_PERSISTED" };
        chunkStore.put(completed);
      };
    };
    await transactionDone(transaction);
    if (!completed) throw new Error("Chunk persistence transaction committed without a complete manifest.");
    return completed;
  } finally {
    database.close();
  }
}

export async function saveLocalSection(section: SeparatedSection) {
  const database = await openDb();
  try {
    await requestResult(database.transaction("sections", "readwrite").objectStore("sections").put({ id: section.id, section } satisfies LocalSectionRecord));
  } finally {
    database.close();
  }
}

/** Replace cached derived section PCM while keeping project and job metadata intact. */
export async function replaceLocalSections(sections: SeparatedSection[]) {
  const database = await openDb();
  try {
    const transaction = database.transaction("sections", "readwrite");
    const store = transaction.objectStore("sections");
    store.clear();
    for (const section of sections) store.put({ id: section.id, section } satisfies LocalSectionRecord);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearLocalProject() {
  const database = await openDb();
  try {
    const transaction = database.transaction(["projects", "sections", "chunks", "chunkStems", "jobLinks"], "readwrite");
    transaction.objectStore("projects").clear();
    transaction.objectStore("sections").clear();
    transaction.objectStore("chunks").clear();
    transaction.objectStore("chunkStems").clear();
    transaction.objectStore("jobLinks").clear();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear local project."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Local project clear was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function clearLocalSections() {
  const database = await openDb();
  try {
    const transaction = database.transaction(["sections", "chunks", "chunkStems", "jobLinks"], "readwrite");
    transaction.objectStore("sections").clear();
    transaction.objectStore("chunks").clear();
    transaction.objectStore("chunkStems").clear();
    transaction.objectStore("jobLinks").clear();
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not clear local sections."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Local section clear was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function loadLocalProject(): Promise<{ project: LocalProjectRecord; sections: SeparatedSection[] } | null> {
  const database = await openDb();
  try {
    const project = await requestResult(database.transaction("projects").objectStore("projects").get(ACTIVE_PROJECT_ID)) as LocalProjectRecord | undefined;
    if (!project) return null;
    const jobLink = await requestResult(database.transaction("jobLinks").objectStore("jobLinks").get(ACTIVE_PROJECT_ID)) as { backendJobId?: string } | undefined;
    if (jobLink?.backendJobId) project.backendJobId = jobLink.backendJobId;
    const records = await requestResult(database.transaction("sections").objectStore("sections").getAll()) as LocalSectionRecord[];
    const chunkRecords = await requestResult(database.transaction("chunks").objectStore("chunks").getAll()) as LocalChunkRecord[];
    const stemRecords = await requestResult(database.transaction("chunkStems").objectStore("chunkStems").getAll()) as LocalChunkStemRecord[];
    const stemByKey = new Map(stemRecords.map((record) => [record.key, record]));
    const restoredChunks: SeparatedSection[] = [];
    for (const chunk of chunkRecords.filter((record) => record.status === "CLIENT_PERSISTED")) {
      const stems = {} as SeparatedSection["stems"];
      let complete = true;
      for (const stem of STEM_NAMES) {
        const stored = stemByKey.get(`${chunk.id}:${stem}`);
        if (!stored || stored.sha256 !== chunk.stemMetadata[stem]?.sha256) { complete = false; break; }
        stems[stem] = decodeFloatWav(await stored.blob.arrayBuffer(), chunk.section.sampleRate, chunk.section.endSample - chunk.section.startSample, stem);
      }
      if (complete) restoredChunks.push({ ...chunk.section, stems });
    }
    const byId = new Map([...records.map((record) => record.section), ...restoredChunks].map((section) => [section.id, section]));
    return { project, sections: [...byId.values()].sort((a, b) => a.startSample - b.startSample) };
  } finally {
    database.close();
  }
}

function decodeFloatWav(bytes: ArrayBuffer, expectedRate: number, expectedFrames: number, stem: string): Float32Array[] {
  const view = new DataView(bytes);
  const text = (offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (view.byteLength < 44 || text(0) !== "RIFF" || text(8) !== "WAVE") throw new Error(`Stored ${stem} chunk is not WAV.`);
  let offset = 12; let format = 0; let channels = 0; let sampleRate = 0; let blockAlign = 0; let bits = 0; let dataAt = -1; let dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const name = text(offset); const size = view.getUint32(offset + 4, true); const body = offset + 8;
    if (body + size > view.byteLength) throw new Error(`Stored ${stem} WAV is truncated.`);
    if (name === "fmt ") { format = view.getUint16(body, true); channels = view.getUint16(body + 2, true); sampleRate = view.getUint32(body + 4, true); blockAlign = view.getUint16(body + 12, true); bits = view.getUint16(body + 14, true); }
    if (name === "data") { dataAt = body; dataSize = size; }
    offset = body + size + (size & 1);
  }
  if (format !== 3 || bits !== 32 || sampleRate !== expectedRate || channels < 1 || channels > 2 || blockAlign !== channels * 4 || dataAt < 0 || dataSize !== expectedFrames * blockAlign) throw new Error(`Stored ${stem} WAV metadata is invalid.`);
  const result = Array.from({ length: channels }, () => new Float32Array(expectedFrames));
  for (let frame = 0; frame < expectedFrames; frame++) for (let channel = 0; channel < channels; channel++) result[channel][frame] = view.getFloat32(dataAt + frame * blockAlign + channel * 4, true);
  return result;
}
