
import type { SeparationSection, StemName } from "./chunkEngine";

export type SeparationBackend = "wasm" | "webgpu";

export type ServerStemSource = {
  url: string;
  sampleRate: number;
  channels: number;
  frames: number;
  audioFormat: "wav";
};

export type SeparatedSection = {
  id: string;
  index: number;
  startBar: number;
  endBar: number;
  startTime: number;
  endTime: number;
  startSample: number;
  endSample: number;
  sampleRate: number;
  kind?: SeparationSection["kind"];
  /** Server-owned audio is fetched only when a clip needs playback. */
  serverStems?: Partial<Record<StemName, ServerStemSource>>;
  stems: Record<StemName, Float32Array[]>;
};

type WorkerResponse =
  | {
    type: "status";
    jobId: string;
    sectionId: string;
    stage: "runtime" | "model" | "processing" | "transfer";
    message: string;
  }
  | {
    type: "progress";
    jobId: string;
    sectionId: string;
    sectionIndex: number;
    totalSections: number;
    chunk: number;
    totalChunks: number;
    percentage: number;
  }
  | {
    type: "section-complete";
    jobId: string;
    sectionId: string;
    sectionIndex: number;
    totalSections: number;
    startTime: number;
    endTime: number;
    startSample: number;
    endSample: number;
    sampleRate: number;
    stems: Record<StemName, Float32Array[]>;
  }
  | {
    type: "error";
    jobId: string;
    sectionId: string;
    message: string;
  }
  | {
    type: "disposed";
    jobId: string;
  };

type SchedulerCallbacks = {
  onStatus?: (
    section: SeparationSection,
    message: string,
  ) => void;

  onProgress?: (
    section: SeparationSection,
    percentage: number,
  ) => void;

  onSectionComplete: (section: SeparatedSection) => void;

  onComplete?: () => void;

  onError?: (
    section: SeparationSection,
    message: string,
  ) => void;
};

type SchedulerOptions = {
  audio: AudioBuffer;
  sections: SeparationSection[];
  backend: SeparationBackend;
  callbacks: SchedulerCallbacks;
};

export function startSeparation({
  audio,
  sections,
  backend,
  callbacks,
}: SchedulerOptions): () => void {
  if (!sections.length) {
    throw new Error("No separation sections provided.");
  }

  if (audio.numberOfChannels < 1) {
    throw new Error("The source audio has no channels.");
  }

  const jobId = crypto.randomUUID();

  const worker = new Worker(
    new URL("../../workers/separation.worker.ts", import.meta.url),
    { type: "module" },
  );

  let currentIndex = 0;
  let stopped = false;
  let waitingForSection = false;

  const totalSections = sections.length;

  let disposing = false;
  let disposalTimeout: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    if (stopped) return;

    stopped = true;
    disposing = true;

    worker.postMessage({
      type: "dispose",
      jobId,
    });

    // Fallback if the worker never acknowledges disposal.
    disposalTimeout = setTimeout(() => {
      worker.terminate();
    }, 30_000);
  };

  const fail = (
    section: SeparationSection,
    message: string,
  ) => {
    if (stopped) return;

    callbacks.onError?.(section, message);
    finish();
  };

  const processNextSection = () => {
    if (stopped) return;

    if (currentIndex >= totalSections) {
      finish();
      callbacks.onComplete?.();
      return;
    }

    const section = sections[currentIndex];

    // Clamp processing boundaries to the original audio.
    const processStartSample = Math.max(
      0,
      Math.min(section.processStartSample, audio.length),
    );

    const processEndSample = Math.max(
      processStartSample,
      Math.min(section.processEndSample, audio.length),
    );

    const coreStartSample = Math.max(
      processStartSample,
      Math.min(section.startSample, processEndSample),
    );

    const coreEndSample = Math.max(
      coreStartSample,
      Math.min(section.endSample, processEndSample),
    );

    if (coreEndSample <= coreStartSample) {
      fail(section, "Section has an invalid audio range.");
      return;
    }

    // Use the first two channels. Duplicate mono to stereo.
    const sourceLeft = audio.getChannelData(0);
    const sourceRight = audio.numberOfChannels > 1
      ? audio.getChannelData(1)
      : sourceLeft;

    // Copy only this section's processing region.
    // The original AudioBuffer remains untouched.
    const left = sourceLeft.slice(
      processStartSample,
      processEndSample,
    );

    const right = sourceRight.slice(
      processStartSample,
      processEndSample,
    );

    if (!left.length || left.length !== right.length) {
      fail(section, "Could not extract valid section audio.");
      return;
    }

    waitingForSection = true;

    callbacks.onStatus?.(
      section,
      `Processing section ${currentIndex + 1} of ${totalSections}...`,
    );

    worker.postMessage(
      {
        type: "separate-section",
        jobId,
        sectionId: section.id,
        sectionIndex: currentIndex,
        totalSections,
        left,
        right,
        sampleRate: audio.sampleRate,
        backend,
        // Keep overlap trimming in original sample coordinates. Seconds are
        // derived from these exact offsets only when clips enter the timeline.
        processStartSample,
        coreStartSample,
        coreEndSample,
      },
      [left.buffer, right.buffer],
    );
  };

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (stopped) return;

    const response = event.data;

    if (response.type === "disposed") {
      if (response.jobId !== jobId || !disposing) return;

      if (disposalTimeout) {
        clearTimeout(disposalTimeout);
      }

      worker.terminate();
      return;
    }

    if (stopped) return;
    if (response.jobId !== jobId) return;

    const section = sections[currentIndex];

    if (!section || response.sectionId !== section.id) return;

    switch (response.type) {
      case "status": {
        callbacks.onStatus?.(section, response.message);
        break;
      }

      case "progress": {
        callbacks.onProgress?.(
          section,
          response.percentage,
        );
        break;
      }

      case "section-complete": {
        if (!waitingForSection) return;

        waitingForSection = false;

        // Publish this section immediately.
        callbacks.onSectionComplete({
          id: response.sectionId,
          index: response.sectionIndex,
          startBar: section.startBar,
          endBar: section.endBar,
          startTime: response.startTime,
          endTime: response.endTime,
          startSample: response.startSample,
          endSample: response.endSample,
          sampleRate: response.sampleRate,
          stems: response.stems,
        });

        currentIndex++;

        // Let the UI receive the completed section before
        // starting the next section.
        queueMicrotask(processNextSection);
        break;
      }

      case "error": {
        fail(section, response.message);
        break;
      }
    }
  };

  worker.onerror = (event) => {
    if (stopped) {
      if (disposalTimeout) clearTimeout(disposalTimeout);
      worker.terminate();
      return;
    }

    const section = sections[currentIndex];

    if (section) {
      fail(section, event.message || "Separation worker failed.");
    } else {
      finish();
    }
  };

  worker.onmessageerror = () => {
    if (stopped) {
      if (disposalTimeout) clearTimeout(disposalTimeout);
      worker.terminate();
      return;
    }

    const section = sections[currentIndex];

    if (section) {
      fail(section, "Could not read the separation worker response.");
    } else {
      finish();
    }
  };

  processNextSection();

  // Return a cancellation function.
  return () => {
    finish();
  };
}
