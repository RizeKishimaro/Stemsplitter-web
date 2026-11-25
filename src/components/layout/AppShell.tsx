import { useEffect, useRef } from "react";
import {
  getClipState,
  restoreClipSnapshot,
  registerSectionClips,
  resetClips,
  setClipStartTime,
  subscribeClips,
} from "../../stores/clip.store";

import { AudioImportScreen } from "../../features/audio-import/components/AudioImportScreen";
import { analyzeAudio } from "../../features/audio-analysis/analysisClient";
import {
  assembleMasterTimelineSections,
  buildSeparationPlan,
} from "../../features/stem-separation/separationPlan";
import { startSeparation } from "../../features/stem-separation/separationScheduler";
import { audioEngine } from "../../features/audio-engine/AudioEngine";
import { recoverBackendChunks, startBackendSeparationFromFile, type AnalysisStrategy } from "../../lib/backendSeparationClient";
import { getAudioContext } from "../../features/audio-engine/AudioContextManager";
import { getTransportSnapshot } from "../../stores/transport.store";
import type { SeparatedSection } from "../../features/stem-separation/separationScheduler";

import {
  addSeparatedSection,
  finishSeparation,
  setAnalysisResult,
  setImportedAudio,
  setMasterTimelineSections,
  setProjectError,
  setProjectStatus,
  setSectionError,
  setSectionProgress,
  setSeparationPlan,
  getProjectState,
  restoreProjectSnapshot,
  useProjectStoreSelector,
} from "../../stores/project.store";
import { clearLocalProject, clearLocalSections, loadLocalProject, saveLocalProject, saveLocalSection } from "../../lib/localProjectStore";

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
    audio: state.audio,
    analysis: state.analysis,
    masterTimeline: state.masterTimeline,
    beatMarkerGrid: state.beatMarkerGrid,
    timelineCorrections: state.timelineCorrections,
    beatSnapMode: state.beatSnapMode,
    downbeatPhaseOffsetSamples: state.downbeatPhaseOffsetSamples,
    sections: state.sections,
    status: state.status,
  }));

  const cancelCurrentJob = useRef<(() => void) | null>(null);
  const separatedSections = useRef<SeparatedSection[]>([]);

  useEffect(() => {
    let cancelled = false;
    const recoveryController = new AbortController();
    void loadLocalProject().then(async (saved) => {
      if (!saved || cancelled || getProjectState().file) return;
      const file = new File([saved.project.file], saved.project.fileName, { type: saved.project.fileType });
      const audio = await getAudioContext().decodeAudioData(await file.arrayBuffer());
      if (cancelled || getProjectState().file) return;
      const restoredState = {
        ...saved.project.state,
        status: saved.sections.length ? "ready" as const : "imported" as const,
      };
      restoreProjectSnapshot(file, audio, restoredState, saved.sections);
      restoreClipSnapshot(saved.project.clips);
      for (const section of saved.sections) audioEngine.prepareSection(section);
      for (const section of saved.sections) registerSectionClips(section);
      if (saved.project.backendJobId) {
        void recoverBackendChunks(saved.project.backendJobId, recoveryController.signal)
          .catch((error: unknown) => {
            if (recoveryController.signal.aborted) return;
            const message = error instanceof Error ? error.message : String(error);
            setProjectError(`Could not recover backend chunks: ${message}`);
            console.warn("Could not recover backend chunks", error);
          });
      }
    }).catch((error: unknown) => console.warn("Could not restore local DubPad project", error));
    return () => { cancelled = true; recoveryController.abort(); };
  }, []);

  useEffect(() => {
    if (!project.file || !project.audio) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const persist = () => {
      const current = getProjectState();
      if (current.file && current.audio) {
        void saveLocalProject(current.file, current, getClipState().clips)
          .catch((error: unknown) => console.warn("Could not save local DubPad project", error));
      }
    };
    persist();
    const schedulePersist = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 200);
    };
    const unsubscribe = subscribeClips(schedulePersist);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [project.file, project.audio, project.analysis, project.masterTimeline, project.beatMarkerGrid,
    project.timelineCorrections, project.beatSnapMode, project.downbeatPhaseOffsetSamples,
    project.sections, project.status]);

  async function handleBackendSeparation(strategy: AnalysisStrategy, beatsPerBar: number, report: (message: string) => void) {
    if (!project.file || !project.audio) throw new Error("Import audio before starting HTDemucs separation.");
    cancelCurrentJob.current?.();
    audioEngine.stop();
    audioEngine.clearPreparedBuffers();
    resetClips();
    setSeparationPlan([]);
    const handle = await startBackendSeparationFromFile(project.file, project.audio, strategy, {
      onProgress: (event) => report(`${event.event ?? "job"}${event.progress === undefined ? "" : ` · ${Math.round(event.progress)}%`}${event.message ? ` · ${event.message}` : ""}`),
      onError: (error) => { report(error.message); setProjectError(error.message); },
      onComplete: () => report("All synchronized HTDemucs chunks are ready."),
    }, beatsPerBar);
    cancelCurrentJob.current = handle.close;
    report(`HTDemucs job ${handle.jobId} is running.`);
  }

  useEffect(() => {
    if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("e2e")) {
      return;
    }

    window.__SONICLAB_E2E__ = {
      playArrangement: (position) => audioEngine.playArrangement(position),
      playClip: (clipId) => audioEngine.playClip(clipId),
      setClipStartTime: (clipId, startTime) => setClipStartTime(clipId, startTime),
      pause: () => audioEngine.pause(),
      resume: () => audioEngine.resume(),
      seek: (position) => audioEngine.seek(position),
      stop: () => audioEngine.stop(),
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

  function handleAudioLoaded(file: File, audio: AudioBuffer) {
    // Cancel any previous analysis or separation job.
    cancelCurrentJob.current?.();
    cancelCurrentJob.current = null;
    audioEngine.stop();
    audioEngine.clearPreparedBuffers();
    separatedSections.current = [];
    resetClips();
    void clearLocalProject().then(() => {
      const current = getProjectState();
      if (current.file === file) return saveLocalProject(file, current, getClipState().clips);
    }).catch((error: unknown) => console.warn("Could not replace previous local DubPad project", error));

    // Save the original audio.
    setImportedAudio(file, audio);
    setProjectStatus("analyzing");

    // Analyze the original audio in a separate worker.
    cancelCurrentJob.current = analyzeAudio(
      audio.getChannelData(0),
      audio.sampleRate,
      4,
      {
        onStatus: (_stage, message) => {
          console.info("[Audio Analysis]", message);
        },

        onComplete: (analysis) => {
          try {
            setAnalysisResult(analysis);

            // Build downbeat-aligned separation sections.
            const plan = buildSeparationPlan(
              analysis,
              audio.sampleRate,
              4,
              1,
            );

            setSeparationPlan(plan.sections);

            console.info(
              `[Separation] ${plan.totalSections} sections generated.`,
            );

            // Start processing one section at a time.
            cancelCurrentJob.current = startSeparation({
              audio,
              sections: plan.sections,
              backend: "wasm",

              callbacks: {
                onStatus: (section, message) => {
                  console.info(
                    `[${section.id}]`,
                    message,
                  );
                },

                onProgress: (section, percentage) => {
                  setSectionProgress(
                    section.id,
                    percentage,
                  );
                },

                onSectionComplete: (section) => {
                  separatedSections.current.push(section);
                  void saveLocalSection(section).catch((error: unknown) => console.warn("Could not save local audio section", error));
                  // Keep progressive PCM results available while processing.
                  // These sections follow the temporary import analysis grid;
                  // do not expose them as playable arrangement clips until
                  // drum analysis establishes the authoritative final grid.
                  addSeparatedSection(section);

                  console.info(`[Separation] Completed ${section.id}`);
                },

                onComplete: () => {
                  // Analyze the separated drums at their original sample
                  // offsets. This is the authoritative musical grid used to
                  // assemble the final arrangement for every stem.
                  const drumReference = new Float32Array(audio.length);
                  for (const section of separatedSections.current) {
                    const channels = section.stems.drums;
                    const expectedLength = section.endSample - section.startSample;
                    if (!channels?.length || channels[0].length !== expectedLength) {
                      setProjectError(`Drum timing samples are invalid in ${section.id}.`);
                      cancelCurrentJob.current = null;
                      return;
                    }
                    drumReference.set(
                      channels[0],
                      section.startSample,
                    );
                  }

                  cancelCurrentJob.current = analyzeAudio(
                    drumReference,
                    audio.sampleRate,
                    4,
                    {
                      onStatus: (_stage, message) => {
                        console.info("[Drums Master Analysis]", message);
                      },
                      onComplete: (drumAnalysis) => {
                        try {
                          const masterPlan = buildSeparationPlan(
                            drumAnalysis,
                            audio.sampleRate,
                            4,
                            1,
                          );
                          const masterSections = assembleMasterTimelineSections(
                            separatedSections.current,
                            masterPlan.sections,
                            audio.sampleRate,
                          );

                          audioEngine.stop();
                          audioEngine.clearPreparedBuffers();
                          resetClips();
                          setMasterTimelineSections(
                            drumAnalysis,
                            masterPlan.sections,
                            masterSections,
                          );
                          separatedSections.current = [];
                          for (const section of masterSections) {
                            audioEngine.prepareSection(section);
                            registerSectionClips(section);
                          }
                          void clearLocalSections().then(() => Promise.all(masterSections.map(saveLocalSection)))
                            .catch((error: unknown) => console.warn("Could not persist finalized audio sections", error));
                          finishSeparation();
                          cancelCurrentJob.current = null;

                          console.info("[Drums Master Timeline] assembled", {
                            bpm: drumAnalysis.bpm,
                            beatCount: drumAnalysis.beats.length,
                            downbeatCount: drumAnalysis.downbeats.length,
                            sectionCount: masterSections.length,
                            sampleRate: audio.sampleRate,
                            originSample: 0,
                            maxStemBoundaryErrorSamples: Math.max(
                              0,
                              ...masterSections.flatMap((section) => [
                                ...(["drums", "bass", "other", "vocals"] as const)
                                  .map((stem) => Math.abs(
                                    section.stems[stem][0].length -
                                    (section.endSample - section.startSample),
                                  )),
                              ]),
                            ),
                          });
                        } catch (error) {
                          const message = error instanceof Error
                            ? error.message
                            : String(error);
                          setProjectError(message);
                          cancelCurrentJob.current = null;
                        }
                      },
                      onError: (message) => {
                        setProjectError(`Drums master analysis failed: ${message}`);
                        cancelCurrentJob.current = null;
                      },
                    },
                  );
                },

                onError: (section, message) => {
                  setSectionError(section.id, message);
                  setProjectError(message);
                  cancelCurrentJob.current = null;

                  console.error(
                    `[Separation] ${section.id}`,
                    message,
                  );
                },
              },
            });
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : String(error);

            setProjectError(message);
            cancelCurrentJob.current = null;

            console.error("[Audio Pipeline]", error);
          }
        },

        onError: (message) => {
          setProjectError(message);
          cancelCurrentJob.current = null;

          console.error("[Audio Analysis]", message);
        },
      },
    );
  }

  return (
    <div className="app-shell">
      <SongCanvas onBackendSeparation={handleBackendSeparation} />

      {!project.audio && (
        <div className="app-shell__import-overlay">
          <AudioImportScreen
            onAudioLoaded={handleAudioLoaded}
          />
        </div>
      )}
    </div>
  );
}
