import { useEffect, useRef } from "react";
import {
  getClipState,
  registerSectionClips,
  resetClips,
  setClipStartTime,
} from "../../stores/clip.store";

import { AudioImportScreen } from "../../features/audio-import/components/AudioImportScreen";
import { analyzeAudio } from "../../features/audio-analysis/analysisClient";
import {
  assembleMasterTimelineSections,
  buildSeparationPlan,
} from "../../features/stem-separation/separationPlan";
import { startSeparation } from "../../features/stem-separation/separationScheduler";
import { audioEngine } from "../../features/audio-engine/AudioEngine";
import { getAudioContext } from "../../features/audio-engine/AudioContextManager";
import { getTransportState } from "../../stores/transport.store";
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
  useProjectStore,
} from "../../stores/project.store";

import { SongCanvas } from "../../features/song-canvas/components/SongCanvas";

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
        transport: ReturnType<typeof getTransportState>;
        clips: ReturnType<typeof getClipState>["clips"];
        status: ReturnType<typeof getProjectState>["status"];
        masterTimelineReady: boolean;
        audioDiagnostics: ReturnType<typeof audioEngine.getDiagnostics>;
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
  const project = useProjectStore();

  const cancelCurrentJob = useRef<(() => void) | null>(null);
  const separatedSections = useRef<SeparatedSection[]>([]);

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
        transport: getTransportState(),
        clips: getClipState().clips,
        status: getProjectState().status,
        masterTimelineReady: getProjectState().masterTimeline !== null,
        audioDiagnostics: audioEngine.getDiagnostics(),
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
      <SongCanvas />

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
