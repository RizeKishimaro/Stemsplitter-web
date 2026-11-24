


import separate from "@audio/neural-separate";
import {
  load,
  type Session,
} from "@audio/neural-runtime";

type SeparationBackend = "wasm" | "webgpu";
type StemName = "vocals" | "drums" | "bass" | "other";

type SeparationRequest = {
  type: "separate-section";
  jobId: string;
  sectionId: string;
  sectionIndex: number;
  totalSections: number;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  backend: SeparationBackend;
  processStartSample: number;
  coreStartSample: number;
  coreEndSample: number;
};

type SeparationResponse =
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

type WorkerScope = {
  onmessage: ((event: MessageEvent<SeparationRequest>) => void) | null;
  postMessage(message: SeparationResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

const scope = self as unknown as WorkerScope;

const STEM_NAMES: StemName[] = [
  "vocals",
  "drums",
  "bass",
  "other",
];

let cachedSession: Session | null = null;
let cachedBackend: SeparationBackend | null = null;
let sessionPromise: Promise<Session> | null = null;
let processing = false;
let disposeRequested = false;
let disposeJobId: string | null = null;


function finishDispose() {
  if (processing || !disposeRequested || !disposeJobId) return;

  releaseSession();

  scope.postMessage({
    type: "disposed",
    jobId: disposeJobId,
  });

  disposeRequested = false;
  disposeJobId = null;
}

async function getSession(
  backend: SeparationBackend,
): Promise<Session> {
  if (cachedSession && cachedBackend === backend) {
    return cachedSession;
  }

  if (sessionPromise) {
    return sessionPromise;
  }

  sessionPromise = (async () => {
    const session = await load(
      "https://huggingface.co/audiojs/scnet/resolve/e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46/scnet.int8.onnx",
      {
        backend,
        threads: 4,
        sessionOptions: {
          enableCpuMemArena: false,
          enableMemPattern: false,
        },
      },
    );

    cachedSession = session;
    cachedBackend = backend;

    return session;
  })();

  try {
    return await sessionPromise;
  } finally {
    sessionPromise = null;
  }
}

function releaseSession() {
  cachedSession?.free();
  cachedSession = null;
  cachedBackend = null;
  sessionPromise = null;
}

scope.addEventListener("message", (event) => {
  const message = event.data;

  if (message?.type !== "dispose") return;

  disposeRequested = true;
  disposeJobId = message.jobId;

  finishDispose();
});

scope.onmessage = async (event: MessageEvent<SeparationRequest>) => {
  const request = event.data;

  if (request.type !== "separate-section") return;

  const {
    jobId,
    sectionId,
    sectionIndex,
    totalSections,
    left,
    right,
    sampleRate,
    backend,
    processStartSample,
    coreStartSample,
    coreEndSample,
  } = request;

  const send = (message: SeparationResponse) => {
    scope.postMessage(message);
  };

  processing = true;

  try {
    if (
      !jobId ||
      !sectionId ||
      !left?.length ||
      !right?.length ||
      left.length !== right.length
    ) {
      throw new Error("Invalid section audio or section identifiers.");
    }

    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("Invalid audio sample rate.");
    }

    if (
      !Number.isInteger(processStartSample) ||
      !Number.isInteger(coreStartSample) ||
      !Number.isInteger(coreEndSample) ||
      processStartSample > coreStartSample ||
      coreStartSample >= coreEndSample
    ) {
      throw new Error("Invalid section timing information.");
    }

    send({
      type: "status",
      jobId,
      sectionId,
      stage: "runtime",
      message: `Initializing ${backend.toUpperCase()} runtime...`,
    });

    send({
      type: "status",
      jobId,
      sectionId,
      stage: "model",
      message: "Loading SCNet model...",
    });

    const session = await getSession(backend);

    const result = await separate([left, right], {
      sampleRate,
      model: "scnet",
      device: backend,
      step: 0.5,

      // The library calls free() after each section.
      // Keep the real session alive until the worker is disposed.
      session: async () =>
        ({
          inputs: session.inputs,
          outputs: session.outputs,
          run: session.run.bind(session),
          free: () => { },
        }) as unknown as import("@audio/neural-separate").Session,

      progress: ({ chunk, totalChunks }) => {
        send({
          type: "progress",
          jobId,
          sectionId,
          sectionIndex,
          totalSections,
          chunk,
          totalChunks,
          percentage: totalChunks > 0
            ? Math.round((chunk / totalChunks) * 100)
            : 0,
        });
      },
    });

    if (!Number.isFinite(result.sampleRate) || result.sampleRate <= 0) {
      throw new Error("SCNet returned an invalid output sample rate.");
    }

    send({
      type: "status",
      jobId,
      sectionId,
      stage: "transfer",
      message: "Trimming overlap and preparing stems...",
    });

    if (result.sampleRate !== sampleRate) {
      throw new Error(
        `SCNet changed sample rate from ${sampleRate} Hz to ${result.sampleRate} Hz; exact source sample offsets cannot be preserved.`,
      );
    }

    const outputTrimStart = coreStartSample - processStartSample;
    const outputTrimEnd = coreEndSample - processStartSample;

    const stems = {} as Record<StemName, Float32Array[]>;
    const transferables: ArrayBuffer[] = [];
    const expectedCoreFrames = coreEndSample - coreStartSample;

    for (const name of STEM_NAMES) {
      const channels = result.stems[name];

      if (!channels?.length) {
        throw new Error(`SCNet did not return the "${name}" stem.`);
      }

      stems[name] = channels.map((channel) => {
        const start = outputTrimStart;
        const end = outputTrimEnd;

        if (end <= start || end > channel.length || end - start !== expectedCoreFrames) {
          throw new Error(
            `Invalid trimmed audio range for "${name}" in section ${sectionId}.`,
          );
        }

        const trimmed = channel.slice(start, end);
        transferables.push(trimmed.buffer as ArrayBuffer);

        return trimmed;
      });
    }

    if (import.meta.env.DEV) {
      console.debug("[Separation timing] exact sample trim", {
        sectionId,
        processStartSample,
        coreStartSample,
        coreEndSample,
        trimStartSample: outputTrimStart,
        trimEndSample: outputTrimEnd,
        sampleRate: result.sampleRate,
        expectedCoreFrames,
        stemFrames: Object.fromEntries(
          STEM_NAMES.map(name => [name, stems[name][0]?.length ?? 0]),
        ),
      });
    }

    send({
      type: "status",
      jobId,
      sectionId,
      stage: "processing",
      message: "Section separated. Sending stems...",
    });

    scope.postMessage(
      {
        type: "section-complete",
        jobId,
        sectionId,
        sectionIndex,
        totalSections,
        startTime: coreStartSample / sampleRate,
        endTime: coreEndSample / sampleRate,
        startSample: coreStartSample,
        endSample: coreEndSample,
        sampleRate: result.sampleRate,
        stems,
      },
      transferables,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
        : String(error);

    console.error(`[Separation Worker: ${sectionId}]`, error);

    send({
      type: "error",
      jobId,
      sectionId,
      message,
    });
  } finally {
    processing = false;

    if (disposeRequested) {
      finishDispose();
    }
  }
};
