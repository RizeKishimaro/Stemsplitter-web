

import {
  getAudioContext,
  getAudioContextDiagnostics,
  resumeAudioContext,
} from "./AudioContextManager";

import { getProjectState } from "../../stores/project.store";
import type { SeparatedSection } from "../stem-separation/separationScheduler";
import type { StemName } from "../stem-separation/chunkEngine";
import {
  mapTimelineToClipSource,
  sourceRangeMatchesTimeline,
} from "./sourceMapping";

import {
  getClipState,
  type AudioClip,
} from "../../stores/clip.store";

import {
  getTransportState,
  updateTransport,
  resetTransport,
  publishTransportFrame,
  type PlaybackMode,
} from "../../stores/transport.store";

class AudioEngine {
  private sources = new Map<string, AudioBufferSourceNode>();
  private sourceMixNodes = new Map<string, { stem: StemName; node: GainNode }>();
  private sourceSchedules = new Map<string, {
    scheduledTime: number;
    sourceOffset: number;
    playbackRate: number;
    sourceStart: number;
    sourceEnd: number;
    loop: boolean;
  }>();
  private preparedBuffers = new Map<string, AudioBuffer>();
  private activeClipIds = new Set<string>();
  private localPlaybackClipIds = new Set<string>();
  private pausedLocalOffsets = new Map<string, number>();
  private mutedStems = new Set<StemName>();
  private soloedStems = new Set<StemName>();

  private mode: PlaybackMode = null;
  private timelineStart = 0;
  private contextStart = 0;
  private pausedPosition = 0;
  private duration = 0;

  private animationFrame = 0;
  private generation = 0;
  private requestSequence = 0;
  private pendingClipRequests = new Map<string, number>();
  private globallyPaused = false;
  private lastPlaybackStart: Record<string, number | string | null> | null = null;
  private frameMetrics = { frames: 0, droppedFrames: 0, maxGapMs: 0, lastFrameAt: 0 };
  private longTaskMetrics = { count: 0, totalMs: 0, maxMs: 0 };
  private longTaskObserver: PerformanceObserver | null = null;

  constructor() {
    if (import.meta.env?.DEV && typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTaskMetrics.count++;
          this.longTaskMetrics.totalMs += entry.duration;
          this.longTaskMetrics.maxMs = Math.max(this.longTaskMetrics.maxMs, entry.duration);
        }
      });
      this.longTaskObserver.observe({ type: "longtask", buffered: true });
    }
  }

  /** Prepare each section once, as it arrives from the separation worker. */
  prepareSection(section: SeparatedSection) {
    const context = getAudioContext();
    const stems: StemName[] = ["drums", "bass", "other", "vocals"];

    for (const stem of stems) {
      const key = `${section.id}:${stem}`;
      if (this.preparedBuffers.has(key)) continue;

      const channels = section.stems[stem];
      if (!channels?.length || !channels[0]?.length) continue;

      const startedAt = performance.now();
      const frameCount = channels[0].length;
      if (frameCount <= 0) continue;
      if (channels.some((channel) => channel.length !== frameCount)) {
        throw new Error(
          `Cannot prepare ${stem} section ${section.id}: channel frame counts differ.`,
        );
      }

      const buffer = context.createBuffer(
        Math.min(2, channels.length),
        frameCount,
        section.sampleRate,
      );
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        buffer.getChannelData(channel).set(channels[channel].subarray(0, frameCount));
      }
      this.preparedBuffers.set(key, buffer);

      if (import.meta.env.DEV) {
        console.debug("[Audio timing] buffer prepared", {
          stem,
          sectionId: section.id,
          sectionStartTime: section.startTime,
          sectionEndTime: section.endTime,
          sampleRate: buffer.sampleRate,
          duration: buffer.duration,
          frames: buffer.length,
          preparationMs: performance.now() - startedAt,
        });
      }
    }
  }

  clearPreparedBuffers() {
    this.preparedBuffers.clear();
  }

  /** Browser E2E diagnostics; production callers receive no PCM metadata. */
  getDiagnostics() {
    if (!import.meta.env.DEV) return null;

    const context = getAudioContext();
    return {
      audioContextCurrentTime: context.currentTime,
      globalTimelinePosition: this.getPosition(),
      activeSourceCount: this.sources.size,
      activeSources: [...this.sourceMixNodes].map(([clipId, source]) => ({
        clipId,
        stem: source.stem,
        effectiveGain: this.effectiveStemGain(source.stem),
      })),
      activeSchedules: [...this.sourceSchedules].map(([clipId, schedule]) => {
        const clip = getClipState().clips[clipId];
        const sampleRate = clip ? this.getClipBuffer(clip)?.sampleRate ?? 0 : 0;
        return {
          clipId,
          scheduledContextTime: schedule.scheduledTime,
          sourceOffsetSeconds: schedule.sourceOffset,
          sourceOffsetSamples: Math.round(schedule.sourceOffset * sampleRate),
          sourceStartSeconds: schedule.sourceStart,
          sourceEndSeconds: schedule.sourceEnd,
          looping: schedule.loop,
        };
      }),
      preparedBuffers: [...this.preparedBuffers].map(([key, buffer]) => ({
        key,
        sampleRate: buffer.sampleRate,
        duration: buffer.duration,
        length: buffer.length,
      })),
      preparedBufferBytes: [...this.preparedBuffers.values()].reduce(
        (total, buffer) => total + buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
        0,
      ),
      memory: (() => {
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
        return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } : null;
      })(),
      audioContext: getAudioContextDiagnostics(),
      playbackStart: this.lastPlaybackStart,
      frameMetrics: { ...this.frameMetrics, lastFrameAt: 0 },
      longTaskMetrics: { ...this.longTaskMetrics },
    };
  }

  private getPosition(): number {
    if (this.mode === null) return 0;

    const context = getAudioContext();

    if (this.globallyPaused || context.state !== "running") {
      return this.pausedPosition;
    }

    const elapsed = Math.max(
      0,
      context.currentTime - this.contextStart,
    );

    return this.timelineStart + elapsed;
  }

  private getArrangementDuration(): number {
    const clips = Object.values(getClipState().clips)
      .filter(clip => clip.active);

    return clips.length
      ? Math.max(...clips.map(clip => clip.endTime))
      : 0;
  }

  private getClipBuffer(clip: AudioClip): AudioBuffer | null {
    return this.preparedBuffers.get(`${clip.sectionId}:${clip.stem}`) ?? null;
  }

  private effectiveStemGain(stem: StemName): number {
    if (this.mutedStems.has(stem)) return 0;
    if (this.soloedStems.size > 0 && !this.soloedStems.has(stem)) return 0;
    return 1;
  }

  private refreshStemGains() {
    const context = getAudioContext();
    for (const { stem, node } of this.sourceMixNodes.values()) {
      node.gain.setTargetAtTime(this.effectiveStemGain(stem), context.currentTime, 0.003);
    }
  }

  setTrackMuted(stem: StemName, muted: boolean) {
    if (muted) this.mutedStems.add(stem);
    else this.mutedStems.delete(stem);
    this.refreshStemGains();
  }

  setTrackSolo(stem: StemName, solo: boolean) {
    if (solo) this.soloedStems.add(stem);
    else this.soloedStems.delete(stem);
    this.refreshStemGains();
  }

  setClipLoop(clipId: string, enabled: boolean) {
    const source = this.sources.get(clipId);
    const storedClip = getClipState().clips[clipId];
    // The clip store is updated by the UI before this method is called, so
    // its loopEnabled value already equals `enabled` here.
    if (!source || !storedClip?.active || this.globallyPaused) return;
    const clip = { ...storedClip, loopEnabled: enabled };

    const sourceOffset = this.getCurrentSourceOffset(clipId);
    const wasLocalPlayback = this.localPlaybackClipIds.has(clipId);
    const context = getAudioContext();
    const scheduledTime = context.currentTime + 0.03;
    const generation = this.generation;
    this.stopSource(clipId);
    if (wasLocalPlayback) this.localPlaybackClipIds.add(clipId);
    else this.localPlaybackClipIds.delete(clipId);
    this.scheduleClip(
      clip,
      wasLocalPlayback
        ? this.getPosition()
        : this.getPosition() + (scheduledTime - context.currentTime),
      scheduledTime,
      generation,
      wasLocalPlayback ? "clip-local" : "timeline",
      wasLocalPlayback
        ? sourceOffset + (scheduledTime - context.currentTime)
        : undefined,
    );
    if (!this.sources.has(clipId)) {
      this.activeClipIds.delete(clipId);
      this.localPlaybackClipIds.delete(clipId);
      this.pausedLocalOffsets.delete(clipId);
      this.syncTransport();
    }
  }

  private scheduleClip(
    clip: AudioClip,
    timelinePosition: number,
    startAt: number,
    generation: number,
    scheduleMode: "timeline" | "clip-local" = "timeline",
    clipLocalOffset?: number,
    startMeasurement?: { requestStartedAtMs: number; resumeDurationMs: number },
  ) {
    if (this.sources.has(clip.id)) return;

    const clipDuration = clip.endTime - clip.startTime;

    if (clipDuration <= 0) return;

    const buffer = this.getClipBuffer(clip);

    if (!buffer) return;

    const sourceStartSample = Math.max(0, clip.sourceStartSample);
    const sourceEndSample = Math.min(buffer.length, clip.sourceEndSample);
    if (sourceEndSample <= sourceStartSample) return;

    const sourceStart = sourceStartSample / buffer.sampleRate;
    const sourceEnd = sourceEndSample / buffer.sampleRate;
    const sourceDuration = sourceEnd - sourceStart;

    // Audio timeline time and AudioBuffer time are both seconds. Their sample
    // rates may differ, but playback remains at 1x; convert timeline deltas to
    // source frames using the buffer's own sample clock.
    const sourceMatchesTimeline = sourceRangeMatchesTimeline(
      sourceStartSample,
      sourceEndSample,
      clip.startTime,
      clip.endTime,
      buffer.sampleRate,
    );

    // Wait until the clip's timeline position if it starts later.
    const scheduleDelay = scheduleMode === "clip-local"
      ? 0
      : Math.max(0, clip.startTime - timelinePosition);

    const mappedSource = scheduleMode === "clip-local"
      ? null
      : mapTimelineToClipSource({
        timelinePosition,
        clipStartTime: clip.startTime,
        sourceStartSample,
        bufferSampleRate: buffer.sampleRate,
        bufferLength: buffer.length,
      });
    if (scheduleMode === "timeline" && !mappedSource) return;

    let sourceOffset = scheduleMode === "clip-local"
      ? clipLocalOffset ?? sourceStart
      : mappedSource!.sourceOffsetSeconds;

    if (!Number.isFinite(sourceOffset) || sourceOffset < sourceStart || sourceOffset > buffer.duration) return;

    // If the playhead has passed this clip, only a looping clip
    // can continue from its wrapped position.
    if (sourceOffset >= sourceEnd) {
      if (!clip.loopEnabled) return;

      sourceOffset = sourceStart +
        ((sourceOffset - sourceStart) % sourceDuration);
    }

    const source = getAudioContext().createBufferSource();

    source.buffer = buffer;
    source.playbackRate.value = 1;
    source.loop = clip.loopEnabled;

    if (clip.loopEnabled) {
      source.loopStart = sourceStart;
      source.loopEnd = sourceEnd;
    }

    const context = getAudioContext();
    const mixNode = context.createGain();
    mixNode.gain.value = this.effectiveStemGain(clip.stem);
    source.connect(mixNode);
    mixNode.connect(context.destination);

    const scheduledTime = startAt + scheduleDelay;

    if (import.meta.env.DEV) {
      const sourceStartArguments = clip.loopEnabled
        ? [scheduledTime, sourceOffset]
        : [scheduledTime, sourceOffset, sourceEnd - sourceOffset];
      const context = getAudioContext();
      const section = getProjectState().completedSections[clip.sectionId];
      const expectedTimelineAtStart = timelinePosition + scheduleDelay;
      const expectedContentTime = scheduleMode === "clip-local"
        ? clip.startTime + (sourceOffset - sourceStart)
        : clip.loopEnabled
          ? clip.startTime +
          ((expectedTimelineAtStart - clip.startTime) % clipDuration + clipDuration) % clipDuration
          : expectedTimelineAtStart;
      const sourceOffsetSamples = Math.round(sourceOffset * buffer.sampleRate);
      const sourceTimelineAtStart = clip.startTime +
        (sourceOffset - sourceStart);
      const expectedBufferSample = sourceStartSample +
        Math.max(0, expectedContentTime - clip.startTime) * buffer.sampleRate;
      const sourceMappingErrorSamples = sourceOffsetSamples - expectedBufferSample;
      console.debug("[Audio timing] source scheduled", {
        clipId: clip.id,
        stem: clip.stem,
        clipStartTime: clip.startTime,
        clipEndTime: clip.endTime,
        sectionStartTime: section?.startTime,
        sectionStartSample: section?.startSample,
        sourceStartSample,
        sourceEndSample,
        sourceOriginSample: section?.startSample,
        bufferOriginSample: 0,
        sourceRangeMatchesTimeline: sourceMatchesTimeline,
        sourceRangeDurationDifferenceMs: (sourceDuration - clipDuration) * 1000,
        loopEnabled: clip.loopEnabled,
        scheduleMode,
        globalTimelinePosition: timelinePosition,
        audioContextCurrentTime: context.currentTime,
        scheduledSourceStartTime: scheduledTime,
        sourceStartArguments,
        requestedTimelineAtStart: expectedTimelineAtStart,
        expectedClipContentTime: expectedContentTime,
        mappedSourceTimelineAtStart: sourceTimelineAtStart,
        timelineDifferenceMs: (sourceTimelineAtStart - expectedContentTime) * 1000,
        sourceMappingErrorSamples,
        sourceOffsetSeconds: sourceOffset,
        sourceOffsetSamples,
        playbackRate: 1,
        sampleRate: buffer.sampleRate,
        bufferDuration: buffer.duration,
        activeSourceCountBeforeStart: this.sources.size,
      });
    }

    const sourceStartCallAt = import.meta.env.DEV ? performance.now() : 0;
    if (clip.loopEnabled) {
      source.start(scheduledTime, sourceOffset);
    } else {
      const remaining = sourceEnd - sourceOffset;

      if (remaining <= 0) {
        source.disconnect();
        return;
      }

      source.start(
        scheduledTime,
        sourceOffset,
        remaining,
      );
    }

    if (import.meta.env.DEV) {
      const context = getAudioContext();
      const estimatedOutputDelayMs = Math.max(0, scheduledTime - context.currentTime) * 1000 +
        (context.baseLatency + (context.outputLatency ?? 0)) * 1000;
      this.lastPlaybackStart = {
        clipId: clip.id,
        requestToSourceStartMs: startMeasurement
          ? sourceStartCallAt - startMeasurement.requestStartedAtMs
          : 0,
        audioContextResumeMs: startMeasurement?.resumeDurationMs ?? 0,
        scheduledLeadMs: Math.max(0, scheduledTime - context.currentTime) * 1000,
        estimatedOutputDelayMs,
        estimatedClickToAudibleMs: startMeasurement
          ? sourceStartCallAt - startMeasurement.requestStartedAtMs + estimatedOutputDelayMs
          : estimatedOutputDelayMs,
        sampleRate: buffer.sampleRate,
      };
      console.debug("[Audio performance] source.start issued", {
        ...this.lastPlaybackStart,
        measuredAt: "AudioBufferSourceNode.start call; output delay is estimated from browser latency reports",
      });
    }

    this.sources.set(clip.id, source);
    this.sourceMixNodes.set(clip.id, { stem: clip.stem, node: mixNode });
    this.sourceSchedules.set(clip.id, {
      scheduledTime,
      sourceOffset,
      playbackRate: 1,
      sourceStart,
      sourceEnd,
      loop: clip.loopEnabled,
    });

    source.onended = () => {
      source.disconnect();
      mixNode.disconnect();

      // Ignore callbacks from an earlier playback generation.
      if (generation !== this.generation) return;

      if (this.sources.get(clip.id) === source) {
        this.sources.delete(clip.id);
        this.sourceMixNodes.delete(clip.id);
        this.sourceSchedules.delete(clip.id);
        this.localPlaybackClipIds.delete(clip.id);
        this.pausedLocalOffsets.delete(clip.id);
        this.activeClipIds.delete(clip.id);
        this.syncTransport();
      }
    };
  }

  private syncTransport() {
    const playingClipIds = [...this.activeClipIds];

    updateTransport({
      isPlaying: !this.globallyPaused && playingClipIds.length > 0,
      isPaused: this.globallyPaused && playingClipIds.length > 0,
      playingClipIds,
      activeClipId: playingClipIds[0] ?? null,
      currentTime: this.getPosition(),
      mode: this.mode,
      duration: this.duration,
    });

    if (playingClipIds.length === 0) {
      this.cancelClock();
      this.mode = null;
      this.globallyPaused = false;

      updateTransport({
        isPlaying: false,
        isPaused: false,
        mode: null,
        activeClipId: null,
        playingClipIds: [],
      });
    }
  }

  private cancelClock() {
    cancelAnimationFrame(this.animationFrame);
  }

  private startClock() {
    this.cancelClock();
    if (import.meta.env.DEV) this.frameMetrics.lastFrameAt = 0;

    const generation = this.generation;

    const tick = () => {
      if (generation !== this.generation) return;
      if (this.globallyPaused) return;

      if (import.meta.env.DEV) {
        const now = performance.now();
        if (this.frameMetrics.lastFrameAt > 0) {
          const gap = now - this.frameMetrics.lastFrameAt;
          this.frameMetrics.maxGapMs = Math.max(this.frameMetrics.maxGapMs, gap);
          if (gap > 25) this.frameMetrics.droppedFrames += Math.max(1, Math.round(gap / (1000 / 60)) - 1);
        }
        this.frameMetrics.lastFrameAt = now;
        this.frameMetrics.frames++;
      }
      const position = this.getPosition();
      const hasLoopingSource = [...this.sourceSchedules.values()].some((schedule) => schedule.loop);
      publishTransportFrame(hasLoopingSource ? position : Math.min(position, this.duration));

      if (
        this.mode === "arrangement" &&
        position >= this.duration &&
        !hasLoopingSource
      ) {
        this.stop();
        return;
      }

      this.animationFrame = requestAnimationFrame(tick);
    };

    this.animationFrame = requestAnimationFrame(tick);
  }

  private stopSource(clipId: string) {
    const source = this.sources.get(clipId);

    if (!source) return;

    this.sources.delete(clipId);
    const mixNode = this.sourceMixNodes.get(clipId)?.node;
    this.sourceMixNodes.delete(clipId);
    this.sourceSchedules.delete(clipId);

    source.onended = null;

    try {
      source.stop();
    } catch {
      // Source may already have ended.
    }

    source.disconnect();
    mixNode?.disconnect();
  }

  private stopAllSources() {
    for (const clipId of [...this.sources.keys()]) {
      this.stopSource(clipId);
    }
  }

  private beginTimeline(position: number) {
    const context = getAudioContext();

    this.timelineStart = position;
    this.pausedPosition = position;
    this.contextStart = context.currentTime + 0.03;
    this.globallyPaused = false;
  }

  async playClip(clipId: string) {
    const requestStartedAtMs = performance.now();
    let clip = getClipState().clips[clipId];

    if (!clip?.active) return;

    // Don't restart an already playing clip.
    if (this.activeClipIds.has(clipId)) return;

    const requestTime = getAudioContext().currentTime;
    const generation = this.generation;
    const requestId = ++this.requestSequence;
    this.pendingClipRequests.set(clipId, requestId);
    let context: AudioContext;
    const resumeStartedAtMs = performance.now();
    let resumeDurationMs: number;
    try {
      context = await resumeAudioContext();
      resumeDurationMs = performance.now() - resumeStartedAtMs;
    } catch (error) {
      if (this.pendingClipRequests.get(clipId) === requestId) this.pendingClipRequests.delete(clipId);
      throw error;
    }

    // A new project, stop, seek, or newer click invalidates this asynchronous
    // request. A late AudioContext.resume() must never revive a replaced track.
    if (generation !== this.generation || this.pendingClipRequests.get(clipId) !== requestId) return;
    this.pendingClipRequests.delete(clipId);

    // AudioContext resume is asynchronous. Re-read the clip and buffer after
    // it completes so scheduling uses current project state and source range.
    clip = getClipState().clips[clipId];
    if (!clip?.active) return;
    if (!this.getClipBuffer(clip)) {
      if (import.meta.env.DEV) {
        console.warn("[Audio timing] play request has no prepared buffer", {
          clipId,
          stem: clip.stem,
          sectionId: clip.sectionId,
          requestContextTime: requestTime,
          contextTimeAfterResume: context.currentTime,
        });
      }
      return;
    }

    const hadTransport = this.mode !== null;
    if (this.mode === null) {
      this.mode = "clip";
      this.duration = this.getArrangementDuration();
      this.beginTimeline(clip.startTime);
    } else if (this.duration === 0) {
      this.duration = this.getArrangementDuration();
    }

    this.activeClipIds.add(clipId);

    const position = this.getPosition();
    const scheduleAt = context.currentTime + 0.03;
    const targetPosition = this.globallyPaused
      ? position
      : this.timelineStart + Math.max(0, scheduleAt - this.contextStart);
    const pausedOffset = this.pausedLocalOffsets.get(clipId);
    const scheduleMode = pausedOffset !== undefined ||
      (hadTransport && targetPosition < clip.startTime)
      ? "clip-local"
      : "timeline";
    if (scheduleMode === "clip-local") this.localPlaybackClipIds.add(clipId);
    else this.localPlaybackClipIds.delete(clipId);

    // If globally paused, remember this clip and defer its source until resume.
    if (this.globallyPaused) {
      this.syncTransport();
      return;
    }

    if (import.meta.env.DEV) {
      console.debug("[Audio timing] play request", {
        clipId,
        stem: clip.stem,
        requestContextTime: requestTime,
        contextTimeAfterResume: context.currentTime,
        baseLatencySeconds: context.baseLatency,
        outputLatencySeconds: context.outputLatency ?? null,
        globalTimelinePosition: position,
        targetTimelinePosition: targetPosition,
        scheduleMode,
        clipStartTime: clip.startTime,
        clipEndTime: clip.endTime,
      });
    }

    // A new clip joins the existing global timeline.
    this.scheduleClip(
      clip,
      targetPosition,
      scheduleAt,
      this.generation,
      scheduleMode,
      pausedOffset,
      { requestStartedAtMs, resumeDurationMs },
    );
    this.pausedLocalOffsets.delete(clipId);

    this.syncTransport();
    this.startClock();
  }

  pauseClip(clipId: string) {
    this.pendingClipRequests.delete(clipId);
    if (!this.activeClipIds.has(clipId)) return;

    if (this.localPlaybackClipIds.has(clipId)) {
      this.pausedLocalOffsets.set(clipId, this.getCurrentSourceOffset(clipId));
    }

    this.stopSource(clipId);
    this.activeClipIds.delete(clipId);

    this.syncTransport();

    if (this.activeClipIds.size > 0 && !this.globallyPaused) {
      this.startClock();
    }
  }

  async toggleClip(clipId: string) {
    if (this.activeClipIds.has(clipId)) {
      this.pauseClip(clipId);
    } else {
      await this.playClip(clipId);
    }
  }

  async playArrangement(fromTime = 0) {
    const requestStartedAtMs = performance.now();
    const clips = Object.values(getClipState().clips)
      .filter(clip => clip.active);

    if (!clips.length) return;

    const requestGeneration = this.generation;
    const resumeStartedAtMs = performance.now();
    await resumeAudioContext();
    const resumeDurationMs = performance.now() - resumeStartedAtMs;
    if (requestGeneration !== this.generation) return;

    this.stop();
    this.localPlaybackClipIds.clear();
    this.pausedLocalOffsets.clear();

    this.mode = "arrangement";
    this.duration = this.getArrangementDuration();

    if (fromTime >= this.duration) {
      fromTime = 0;
    }

    this.beginTimeline(fromTime);

    for (const clip of clips) {
      this.activeClipIds.add(clip.id);
    }


    for (const clip of clips) {
      this.scheduleClip(
        clip,
        fromTime,
        this.contextStart,
        this.generation,
        "timeline",
        undefined,
        { requestStartedAtMs, resumeDurationMs },
      );
    }

    this.syncTransport();

    if (this.sources.size > 0) {
      this.startClock();
    } else {
      this.stop();
    }
  }

  pause() {
    if (this.mode === null || this.globallyPaused) return;

    this.pausedPosition = this.getPosition();
    this.globallyPaused = true;

    for (const clipId of this.localPlaybackClipIds) {
      this.pausedLocalOffsets.set(clipId, this.getCurrentSourceOffset(clipId));
    }

    this.generation++;
    this.cancelClock();
    this.stopAllSources();

    updateTransport({
      isPlaying: false,
      isPaused: true,
      currentTime: this.pausedPosition,
      playingClipIds: [...this.activeClipIds],
    });
  }

  async resume() {
    if (this.mode === null || !this.globallyPaused) return;

    const generationBeforeResume = this.generation;
    await resumeAudioContext();
    if (generationBeforeResume !== this.generation || this.mode === null || !this.globallyPaused) return;

    this.globallyPaused = false;
    this.beginTimeline(this.pausedPosition);

    const generation = this.generation;

    for (const clipId of this.activeClipIds) {
      const clip = getClipState().clips[clipId];

      if (!clip?.active) {
        this.activeClipIds.delete(clipId);
        continue;
      }

      this.scheduleClip(
        clip,
        this.pausedPosition,
        this.contextStart,
        generation,
        this.localPlaybackClipIds.has(clipId) ? "clip-local" : "timeline",
        this.pausedLocalOffsets.get(clipId),
      );
    }

    this.syncTransport();

    if (this.sources.size > 0) {
      this.startClock();
    }
  }

  /** Seek the shared transport and reschedule every active clip together. */
  seek(position: number) {
    if (this.mode === null || !Number.isFinite(position)) return;

    const nextPosition = Math.max(0, Math.min(position, this.duration));
    this.pausedPosition = nextPosition;

    if (this.globallyPaused) {
      this.localPlaybackClipIds.clear();
      this.pausedLocalOffsets.clear();
      updateTransport({ currentTime: nextPosition });
      return;
    }

    this.generation++;
    this.localPlaybackClipIds.clear();
    this.pausedLocalOffsets.clear();
    this.cancelClock();
    this.stopAllSources();
    if (this.mode === "arrangement") {
      this.activeClipIds = new Set(
        Object.values(getClipState().clips)
          .filter((clip) => clip.active)
          .map((clip) => clip.id),
      );
    }
    this.beginTimeline(nextPosition);

    const generation = this.generation;
    for (const clipId of this.activeClipIds) {
      const clip = getClipState().clips[clipId];
      if (!clip?.active) {
        this.activeClipIds.delete(clipId);
        continue;
      }

      this.scheduleClip(
        clip,
        nextPosition,
        this.contextStart,
        generation,
      );
    }

    this.syncTransport();
    if (this.sources.size > 0) this.startClock();
  }

  async togglePlayback() {
    const transport = getTransportState();

    if (transport.isPlaying) {
      this.pause();
    } else if (transport.isPaused) {
      await this.resume();
    } else {
      await this.playArrangement(0);
    }
  }

  stop() {
    this.generation++;
    this.pendingClipRequests.clear();
    this.cancelClock();
    this.stopAllSources();
    this.localPlaybackClipIds.clear();
    this.pausedLocalOffsets.clear();

    this.activeClipIds.clear();

    this.mode = null;
    this.timelineStart = 0;
    this.contextStart = 0;
    this.pausedPosition = 0;
    this.duration = 0;
    this.globallyPaused = false;

    resetTransport();
  }

  private getCurrentSourceOffset(clipId: string): number {
    const schedule = this.sourceSchedules.get(clipId);
    if (!schedule) return 0;

    const elapsed = Math.max(0, getAudioContext().currentTime - schedule.scheduledTime);
    let offset = schedule.sourceOffset + elapsed * schedule.playbackRate;
    if (schedule.loop && offset >= schedule.sourceEnd) {
      offset = schedule.sourceStart +
        ((offset - schedule.sourceStart) % (schedule.sourceEnd - schedule.sourceStart));
    }
    return Math.max(schedule.sourceStart, Math.min(offset, schedule.sourceEnd));
  }
}

export const audioEngine = new AudioEngine();
