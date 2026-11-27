import { useEffect, useRef, useState } from "react";
import {
  getClipState,
  restoreClipSnapshot,
  registerSectionClips,
  resetClips,
  setClipStartTime,
  subscribeClips,
} from "../../stores/clip.store";

import { AudioImportScreen } from "../../features/audio-import/components/AudioImportScreen";
import { audioEngine } from "../../features/audio-engine/AudioEngine";
import { getAudioContext } from "../../features/audio-engine/AudioContextManager";
import { API_BASE_URL } from "../../lib/api";
import { changeArrangementSegmentSize, recoverBackendJob, restoreLastServerProject, startBackendSeparationFromFile } from "../../lib/backendSeparationClient";
import { getTransportSnapshot } from "../../stores/transport.store";
import type { SeparatedSection } from "../../features/stem-separation/separationScheduler";
import {
  setArrangementSections,
  setImportedAudio,
  setProjectError,
  setProjectStatus,
  setServerSaveStatus,
  getProjectState,
  restoreProjectSnapshot,
  useProjectStoreSelector,
} from "../../stores/project.store";
import { loadLocalProject } from "../../lib/localProjectStore";

import { SongCanvas } from "../../features/song-canvas/components/SongCanvas";
import { getArrangementRenderCount } from "../../features/song-canvas/components/arrangementMetrics";

import "./AppShell.css";

declare global {
  interface Window {
    __SONICLAB_E2E__?: {
      playArrangement: (position?: number) => Promise<void>;
      playClip: (clipId: string) => Promise<void>;
      setClipStartTime: (clipId: string, startTime: number) => void;
      pause: () => void;
      resume: () => Promise<void>;
      seek: (position: number) => void;
      stop: () => void;
      installSyntheticProject: (timelineStart: number, durationSeconds: number) => string[];
      replaceSyntheticProject: (timelineStart: number, durationSeconds: number) => string[];
      snapshot: () => {
        audioContextCurrentTime: number;
          transport: ReturnType<typeof getTransportSnapshot>;
        clips: ReturnType<typeof getClipState>["clips"];
        status: ReturnType<typeof getProjectState>["status"];
        masterTimelineReady: boolean;
          audioDiagnostics: ReturnType<typeof audioEngine.getDiagnostics>;
          arrangementRenderCount: number;
        sections: Array<{
          id: string;
          startSample: number;
          endSample: number;
          sampleRate: number;
          startTime: number;
          endTime: number;
          stemFrames: Record<"drums" | "bass" | "other" | "vocals", number[]>;
        }>;
      };
    };
  }
}

export function AppShell() {
  const project = useProjectStoreSelector((state) => ({
    file: state.file,
    analysis: state.analysis,
    masterTimeline: state.masterTimeline,
    beatMarkerGrid: state.beatMarkerGrid,
    timelineCorrections: state.timelineCorrections,
    beatSnapMode: state.beatSnapMode,
    segmentSize: state.segmentSize,
    downbeatPhaseOffsetSamples: state.downbeatPhaseOffsetSamples,
    sections: state.sections,
    backendProjectId: state.backendProjectId,
    status: state.status,
  }));

  const cancelCurrentJob = useRef<(() => void) | null>(null);
  const activeImport = useRef(0);
  const [processingMessage, setProcessingMessage] = useState("");
  const [processingProgress, setProcessingProgress] = useState<number | null>(null);

  useEffect(() => () => {
    activeImport.current++;
    cancelCurrentJob.current?.();
    audioEngine.stop();
  }, []);

  // Debounced server autosave contains only durable timeline and clip data.
  // Playback position, selection, hover and audio PCM are intentionally absent.
  useEffect(() => {
    if (!project.backendProjectId || project.status === "separating" || project.status === "idle") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const persist = () => {
      const current = getProjectState();
      if (!current.backendProjectId || cancelled) return;
      const clips = Object.values(getClipState().clips).map(({ id, stem, sectionId, sourceStartSample, sourceEndSample, startTime, endTime, parentClipId, childClipIds, splitDepth, active, loopEnabled }) => ({
        id, stem, sectionId, sourceStartSample, sourceEndSample, startTime, endTime, parentClipId, childClipIds, splitDepth, active, loopEnabled,
      }));
      const payload = {
        project_state: {
          schemaVersion: 1,
          analysis: current.analysis,
          masterTimeline: current.masterTimeline,
          beatMarkerGrid: current.beatMarkerGrid,
          timelineCorrections: current.timelineCorrections,
          beatSnapMode: current.beatSnapMode,
          downbeatPhaseOffsetSamples: current.downbeatPhaseOffsetSamples,
          segmentSize: current.segmentSize,
          sections: current.sections,
          clips,
        },
      };
      setServerSaveStatus("saving");
      void fetch(`${API_BASE_URL}/projects/${encodeURIComponent(current.backendProjectId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`Project save failed (${response.status}): ${await response.text()}`);
        if (!cancelled) setServerSaveStatus("saved");
      }).catch((error: unknown) => {
        if (cancelled) return;
        setServerSaveStatus("error");
        console.warn("Could not save DubPad project to server", error);
      });
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 800);
    };
    schedule();
    const unsubscribe = subscribeClips(schedule);
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [project.backendProjectId, project.analysis, project.masterTimeline, project.beatMarkerGrid,
    project.timelineCorrections, project.beatSnapMode, project.downbeatPhaseOffsetSamples,
    project.segmentSize, project.sections, project.status]);

  useEffect(() => {
    let cancelled = false;
    const recoveryController = new AbortController();
    void (async () => {
      try {
        if (await restoreLastServerProject(recoveryController.signal) || cancelled) return;
      } catch (error) {
        if (!recoveryController.signal.aborted) console.warn("Could not restore the server project; checking legacy local data", error);
      }
      const saved = await loadLocalProject();
      if (!saved || cancelled || getProjectState().file) return;
      const file = new File([saved.project.file], saved.project.fileName, { type: saved.project.fileType });
      const audio = await getAudioContext().decodeAudioData(await file.arrayBuffer());
      if (cancelled || getProjectState().file) return;
      const restoredState = {
        ...saved.project.state,
        backendProjectId: null,
        serverSaveStatus: "idle" as const,
        segmentSize: saved.project.state.segmentSize ?? "4bars" as const,
        status: saved.sections.length ? "ready" as const : "imported" as const,
      };
      restoreProjectSnapshot(file, audio, restoredState, saved.sections);
      restoreClipSnapshot(saved.project.clips);
      const expectedEndSample = saved.project.state.sections.at(-1)?.endSample;
      const savedSectionsCoverTimeline = saved.sections.length > 0 && saved.sections[0].startSample === 0 &&
        saved.sections.at(-1)?.endSample === expectedEndSample &&
        saved.sections.every((section, index) => index === 0 || saved.sections[index - 1].endSample === section.startSample);
      const needsDefaultFourBarRegroup = savedSectionsCoverTimeline &&
        saved.project.state.masterTimeline !== null && saved.project.state.masterTimeline !== undefined &&
        saved.project.state.segmentSize === undefined;
      let regroupedOnRestore = false;
      if (needsDefaultFourBarRegroup) {
        try {
          await changeArrangementSegmentSize("4bars", true);
          regroupedOnRestore = true;
        } catch (error) {
          console.warn("Could not convert saved sections to four-bar segments", error);
        }
      }
      if (!regroupedOnRestore) {
        for (const section of saved.sections) audioEngine.prepareSection(section);
        for (const section of saved.sections) registerSectionClips(section);
      }
      const hasCompleteLocalStemSet = saved.project.state.sections.length > 0 &&
        saved.sections.length >= saved.project.state.sections.length;
      if (saved.project.backendJobId && !hasCompleteLocalStemSet) {
        void recoverBackendJob(saved.project.backendJobId, recoveryController.signal)
          .catch((error: unknown) => {
            if (recoveryController.signal.aborted) return;
            const message = error instanceof Error ? error.message : String(error);
            setProjectError(`Could not restore backend stems and beat grid: ${message}`);
            console.warn("Could not restore backend stems and beat grid", error);
          });
      }
    })().catch((error: unknown) => console.warn("Could not restore DubPad project", error));
    return () => { cancelled = true; recoveryController.abort(); };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("e2e")) {
      return;
    }

    const installSyntheticProject = (timelineStart: number, durationSeconds: number) => {
      audioEngine.stop();
      audioEngine.clearPreparedBuffers();
      resetClips();
      const context = getAudioContext();
      const sampleRate = context.sampleRate;
      const startSample = Math.round(timelineStart * sampleRate);
      const frameCount = Math.max(2, Math.round(durationSeconds * sampleRate));
      const stems = Object.fromEntries(([
        ["drums", 70], ["bass", 110], ["other", 220], ["vocals", 440],
      ] as const).map(([stem, frequency]) => {
        const pcm = new Float32Array(frameCount);
        for (let frame = 0; frame < frameCount; frame++) {
          pcm[frame] = Math.sin(2 * Math.PI * frequency * frame / sampleRate) * 0.2;
        }
        return [stem, [pcm]];
      })) as SeparatedSection["stems"];
      const id = `e2e-${Math.random().toString(36).slice(2)}`;
      const section: SeparatedSection = {
        id,
        index: 0,
        startBar: 1,
        endBar: 2,
        startSample,
        endSample: startSample + frameCount,
        startTime: startSample / sampleRate,
        endTime: (startSample + frameCount) / sampleRate,
        sampleRate,
        stems,
      };
      setArrangementSections([section], "4bars");
      audioEngine.prepareSection(section);
      registerSectionClips(section);
      return Object.keys(getClipState().clips);
    };

    window.__SONICLAB_E2E__ = {
      playArrangement: (position) => audioEngine.playArrangement(position),
      playClip: (clipId) => audioEngine.playClip(clipId),
      setClipStartTime: (clipId, startTime) => setClipStartTime(clipId, startTime),
      pause: () => audioEngine.pause(),
      resume: () => audioEngine.resume(),
      seek: (position) => audioEngine.seek(position),
      stop: () => audioEngine.stop(),
      installSyntheticProject,
      replaceSyntheticProject: installSyntheticProject,
      snapshot: () => ({
        audioContextCurrentTime: getAudioContext().currentTime,
        transport: getTransportSnapshot(),
        clips: getClipState().clips,
        status: getProjectState().status,
        masterTimelineReady: getProjectState().masterTimeline !== null,
        audioDiagnostics: audioEngine.getDiagnostics(),
        arrangementRenderCount: getArrangementRenderCount(),
        sections: Object.values(getProjectState().completedSections).map((section) => ({
          id: section.id,
          startSample: section.startSample,
          endSample: section.endSample,
          sampleRate: section.sampleRate,
          startTime: section.startTime,
          endTime: section.endTime,
          stemFrames: {
            drums: section.stems.drums.map((channel) => channel.length),
            bass: section.stems.bass.map((channel) => channel.length),
            other: section.stems.other.map((channel) => channel.length),
            vocals: section.stems.vocals.map((channel) => channel.length),
          },
        })),
      }),
    };

    return () => {
      delete window.__SONICLAB_E2E__;
    };
  }, []);

  async function handleAudioLoaded(file: File) {
    const importId = ++activeImport.current;
    cancelCurrentJob.current?.();
    cancelCurrentJob.current = null;
    audioEngine.stop();
    audioEngine.clearPreparedBuffers();
    resetClips();
    setImportedAudio(file);
    setProjectStatus("separating");
    setProcessingMessage("Uploading audio…");
    setProcessingProgress(null);
    const controller = new AbortController();
    cancelCurrentJob.current = () => controller.abort();
    void (async () => {
      const audio = await getAudioContext().decodeAudioData(await file.arrayBuffer());
      if (activeImport.current !== importId || controller.signal.aborted) return;
      return startBackendSeparationFromFile(file, audio, "drums_first", {
      onProgress: (event) => {
        if (activeImport.current !== importId) return;
        if (event.event === "stem.completed") {
          setProcessingMessage(`Downloading ${event.stem?.toUpperCase() ?? "completed"} stem…`);
          return;
        }
        if (event.event === "stem.download_failed") {
          setProcessingMessage(event.message ?? "A completed stem will be loaded after processing finishes.");
          return;
        }
        const stage = event.stage ?? event.event ?? event.status ?? "Processing";
        const progress = typeof event.progress === "number" && Number.isFinite(event.progress)
          ? Math.max(0, Math.min(100, event.progress))
          : null;
        setProcessingProgress(progress);
        setProcessingMessage(`${stage}${event.message ? ` · ${event.message}` : ""}`);
      },
      onStemCompleted: (stem) => {
        if (activeImport.current !== importId) return;
        setProcessingMessage(`${stem.toUpperCase()} stem added to the arrangement.`);
      },
      onError: (error) => {
        if (activeImport.current !== importId || controller.signal.aborted) return;
        setProcessingMessage(error.message);
        setProcessingProgress(null);
        setProjectError(error.message);
      },
      onComplete: () => {
        if (activeImport.current !== importId) return;
        setProcessingMessage("Stems and beat grid are ready.");
        setProcessingProgress(100);
        cancelCurrentJob.current = null;
      },
      }, 4, controller.signal);
    })().then((handle) => {
      if (!handle) return;
      if (activeImport.current !== importId || controller.signal.aborted) {
        handle.close();
        return;
      }
      cancelCurrentJob.current = () => {
        controller.abort();
        handle.close();
      };
      setProcessingMessage(`Processing job ${handle.jobId}`);
    }).catch((error: unknown) => {
      if (activeImport.current !== importId || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      setProcessingMessage(message);
      setProcessingProgress(null);
      setProjectError(message);
    });
  }

  return (
    <div className="app-shell">
      <SongCanvas processingMessage={processingMessage} processingProgress={processingProgress} />

      {!project.file && (
        <div className="app-shell__import-overlay">
          <AudioImportScreen
            onAudioLoaded={handleAudioLoaded}
          />
        </div>
      )}
    </div>
  );
}
