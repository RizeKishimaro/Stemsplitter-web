import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sync-fixture.wav",
);

type TimingLog = {
  stem?: string;
  clipId?: string;
  clipStartTime?: number;
  clipEndTime?: number;
  sectionStartTime?: number;
  sectionStartSample?: number;
  sourceStartSample?: number;
  sourceEndSample?: number;
  loopEnabled?: boolean;
  scheduleMode?: "timeline" | "clip-local";
  globalTimelinePosition?: number;
  audioContextCurrentTime?: number;
  requestedTimelineAtStart?: number;
  scheduledSourceStartTime?: number;
  sourceStartArguments?: number[];
  sourceOffsetSeconds?: number;
  sourceOffsetSamples?: number;
  playbackRate?: number;
  sourceMappingErrorSamples?: number | null;
  sourceRangeMatchesTimeline?: boolean;
  sampleRate?: number;
  bufferDuration?: number;
  timelineDifferenceMs?: number;
};

type BufferPreparationLog = {
  stem: string;
  sectionId: string;
  sectionStartTime: number;
  sectionEndTime: number;
  sampleRate: number;
  duration: number;
  frames: number;
  preparationMs: number;
};

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
        transport: { currentTime: number; playingClipIds: string[]; isPaused: boolean };
        status: string;
        masterTimelineReady: boolean;
        audioDiagnostics: {
          globalTimelinePosition: number;
          activeSourceCount: number;
          activeSources: Array<{ clipId: string; stem: string; effectiveGain: number }>;
          preparedBuffers: Array<{ key: string; sampleRate: number; duration: number; length: number }>;
        } | null;
        arrangementRenderCount: number;
        clips: Record<string, {
          id: string;
          stem: string;
          sectionId: string;
          startTime: number;
          endTime: number;
          sourceStartSample: number;
          sourceEndSample: number;
          active: boolean;
        }>;
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

test("import, separate, and keep stems aligned in Firefox Web Audio", async ({ page, browser }, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const sourceSchedules: TimingLog[] = [];
  const bufferPreparations: BufferPreparationLog[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    const text = message.text();
    const prefix = "[Audio timing] source scheduled ";
    const preparationPrefix = "[Audio timing] buffer prepared";
    let parsedFromText = false;
    if (text.startsWith(prefix)) {
      try {
        sourceSchedules.push(JSON.parse(text.slice(prefix.length)) as TimingLog);
        parsedFromText = true;
      } catch {
        // Firefox can print the object as a separate console argument.
      }
    }
    if (!parsedFromText && text.includes("[Audio timing] source scheduled")) {
      void message.args()[1]?.jsonValue().then((value) => {
        sourceSchedules.push(value as TimingLog);
      });
    }
    if (text.includes(preparationPrefix)) {
      void message.args()[1]?.jsonValue().then((value) => {
        bufferPreparations.push(value as BufferPreparationLog);
      });
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()} :: ${request.failure()?.errorText ?? "failed"}`);
  });

  await page.goto("/?e2e=1");
  await page.locator("input[type=file]").setInputFiles(fixture);

  // Exercise the actual import, analysis, worker separation and arrangement
  // registration path. A missing model/network dependency is a test failure.
  const drums = page.locator('[aria-label="DRUMS arrangement"] [data-clip-id]').first();
  await expect(drums).toBeVisible({ timeout: 7 * 60 * 1000 });
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().status,
  ), { timeout: 7 * 60 * 1000 }).toBe("complete");
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().masterTimelineReady,
  )).toBe(true);
  for (const stem of ["drums", "bass", "other", "vocals"]) {
    await expect(page.locator(`[aria-label="${stem.toUpperCase()} arrangement"] [data-clip-id]`).first())
      .toBeVisible();
  }

  const sectionBoundaries = await page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().sections,
  );
  const snapshotClips = await page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().clips,
  );
  expect(sectionBoundaries.length).toBeGreaterThan(0);
  const sectionClipToleranceSamples = 1;
  const sectionTimingOffsets: Array<{
    sectionId: string;
    stem: string;
    startOffsetMs: number;
    startOffsetSamples: number;
    endOffsetMs: number;
    endOffsetSamples: number;
    sampleRate: number;
  }> = [];

  for (const section of sectionBoundaries) {
    expect(section.endSample - section.startSample).toBe(
      Math.round((section.endTime - section.startTime) * section.sampleRate),
    );

    const sectionPosition = (stem: string) => {
      const clip = Object.values(snapshotClips).find((candidate) =>
        candidate.stem === stem && candidate.sectionId === section.id,
      );
      return clip && { startTime: clip.startTime, endTime: clip.endTime };
    };
    const drumPosition = sectionPosition("drums");
    expect(drumPosition, `drums clip timing for ${section.id}`).toBeTruthy();

    for (const stem of ["drums", "bass", "other", "vocals"]) {
      const position = sectionPosition(stem);
      expect(position, `${stem} clip timing for ${section.id}`).toBeTruthy();

      const stemFrames = section.stemFrames[stem as "drums" | "bass" | "other" | "vocals"];
      expect(stemFrames.length, `${stem} channel count for ${section.id}`).toBeGreaterThan(0);
      expect(stemFrames.every((frames) => frames === section.endSample - section.startSample),
        `${stem} channel frame count for ${section.id}`).toBe(true);
      const matchingClip = Object.values(snapshotClips).find((candidate) =>
        candidate.stem === stem && candidate.sectionId === section.id,
      );
      expect(matchingClip, `${stem} registered clip for ${section.id}`).toBeTruthy();
      expect(matchingClip!.sourceStartSample).toBe(0);
      expect(matchingClip!.sourceEndSample).toBe(section.endSample - section.startSample);

      const startOffsetSeconds = position!.startTime - drumPosition!.startTime;
      const endOffsetSeconds = position!.endTime - drumPosition!.endTime;
      const startOffsetSamples = Math.round(startOffsetSeconds * section.sampleRate);
      const endOffsetSamples = Math.round(endOffsetSeconds * section.sampleRate);
      sectionTimingOffsets.push({
        sectionId: section.id,
        stem,
        startOffsetMs: startOffsetSeconds * 1000,
        startOffsetSamples,
        endOffsetMs: endOffsetSeconds * 1000,
        endOffsetSamples,
        sampleRate: section.sampleRate,
      });

      expect(Math.abs(startOffsetSamples), `${stem} start offset for ${section.id} in samples`)
        .toBeLessThanOrEqual(sectionClipToleranceSamples);
      expect(Math.abs(endOffsetSamples), `${stem} end offset for ${section.id} in samples`)
        .toBeLessThanOrEqual(sectionClipToleranceSamples);
    }
  }
  for (let index = 1; index < sectionBoundaries.length; index++) {
    expect(sectionBoundaries[index].startSample - sectionBoundaries[index - 1].endSample)
      .toBe(0);
  }

  const playButton = (stem: string) =>
    page.locator(`[aria-label="${stem.toUpperCase()} arrangement"] [data-clip-id]`).first()
      .getByRole("button", { name: "Play clip" });
  await playButton("drums").click();
  await page.waitForTimeout(5_200);
  for (const stem of ["vocals", "bass", "other"]) {
    await playButton(stem).click();
  }
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.preparedBuffers.length ?? 0,
  )).toBeGreaterThanOrEqual(sectionBoundaries.length * 4);

  await expect.poll(() => sourceSchedules.filter((entry) => entry.stem).length)
    .toBeGreaterThanOrEqual(4);
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().transport.playingClipIds.length,
  )).toBeGreaterThanOrEqual(4);
  for (const stem of ["vocals", "bass", "other"]) {
    const lateJoin = sourceSchedules.filter((entry) => entry.stem === stem).at(-1);
    expect(lateJoin, `${stem} must have a real AudioBufferSource schedule`).toBeTruthy();
    expect(lateJoin!.globalTimelinePosition).toBeGreaterThanOrEqual(4.5);
    expect(lateJoin!.scheduledSourceStartTime).toBeGreaterThan(0);
    expect(lateJoin!.audioContextCurrentTime).toBeGreaterThan(0);
    expect(lateJoin!.sourceStartArguments?.[0]).toBe(lateJoin!.scheduledSourceStartTime);
    expect(lateJoin!.sourceStartArguments?.[1]).toBe(lateJoin!.sourceOffsetSeconds);
    expect(lateJoin!.sampleRate).toBeGreaterThan(0);
    expect(lateJoin!.bufferDuration).toBeGreaterThan(0);
    expect(lateJoin!.playbackRate).toBe(1);
    expect(lateJoin!.sourceRangeMatchesTimeline).toBe(true);
    const sourceStartSeconds = lateJoin!.sourceStartSample! / lateJoin!.sampleRate!;
    const sourceEndSeconds = lateJoin!.sourceEndSample! / lateJoin!.sampleRate!;
    const sourceDuration = sourceEndSeconds - sourceStartSeconds;
    const timelineElapsed = Math.max(
      0,
      lateJoin!.globalTimelinePosition! - lateJoin!.clipStartTime!,
    );
    const mappedElapsed = timelineElapsed;
    const expectedSourceOffset = lateJoin!.scheduleMode === "clip-local"
      ? sourceStartSeconds
      : sourceStartSeconds + (lateJoin!.loopEnabled
        ? mappedElapsed % sourceDuration
        : mappedElapsed);
    expect(Math.abs(lateJoin!.sourceOffsetSeconds! - expectedSourceOffset) * lateJoin!.sampleRate!)
      .toBeLessThanOrEqual(1);
    expect(lateJoin!.sourceOffsetSeconds).toBeGreaterThanOrEqual(sourceStartSeconds);
    expect(lateJoin!.sourceOffsetSeconds).toBeLessThan(sourceEndSeconds);
    const audioLead = lateJoin!.scheduledSourceStartTime! - lateJoin!.audioContextCurrentTime!;
    expect(audioLead).toBeGreaterThanOrEqual(0);
    expect(audioLead).toBeLessThan(0.1);
    expect(Math.abs(lateJoin!.timelineDifferenceMs ?? Infinity)).toBeLessThanOrEqual(
      1000 / lateJoin!.sampleRate!,
    );
  }
  const lateJoinMeasurements = ["vocals", "bass", "other"].map((stem) => {
    const record = sourceSchedules.filter((entry) => entry.stem === stem).at(-1)!;
    const startSeconds = (record.sourceStartSample ?? 0) / (record.sampleRate ?? 1);
    const endSeconds = (record.sourceEndSample ?? 0) / (record.sampleRate ?? 1);
    const sourceDuration = endSeconds - startSeconds;
    const elapsed = Math.max(
      0,
      (record.globalTimelinePosition ?? 0) - (record.clipStartTime ?? 0),
    );
    const mappedElapsed = elapsed;
    const expectedSourceOffset = record.scheduleMode === "clip-local"
      ? startSeconds
      : startSeconds + (record.loopEnabled && sourceDuration > 0
        ? mappedElapsed % sourceDuration
        : mappedElapsed);
    return {
      stem,
      requestedTimelineSeconds: record.requestedTimelineAtStart,
      sourceOffsetSeconds: record.sourceOffsetSeconds,
      sourceOffsetSamples: record.sourceOffsetSamples,
      sourceStartSample: record.sourceStartSample,
      sourceEndSample: record.sourceEndSample,
      clipStartTime: record.clipStartTime,
      clipEndTime: record.clipEndTime,
      sectionStartTime: record.sectionStartTime,
      scheduleMode: record.scheduleMode,
      loopEnabled: record.loopEnabled,
      scheduledContextSeconds: record.scheduledSourceStartTime,
      sourceStartArguments: record.sourceStartArguments,
      measuredTimelineErrorMs: record.timelineDifferenceMs,
      measuredTimelineErrorSamples: (record.timelineDifferenceMs ?? 0) * (record.sampleRate ?? 0) / 1000,
      expectedBufferLocalOffsetSeconds: expectedSourceOffset,
      bufferLocalOffsetErrorSamples: Math.abs(
        (record.sourceOffsetSeconds ?? 0) - expectedSourceOffset,
      ) * (record.sampleRate ?? 0),
      sampleRate: record.sampleRate,
    };
  });

  // Pause/resume the global transport and seek with all four native sources
  // active. This calls the actual AudioEngine in the browser, not a mock.
  await page.evaluate(() => window.__SONICLAB_E2E__!.playArrangement(0));
  await expect.poll(async () => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().transport.playingClipIds.length,
  )).toBeGreaterThanOrEqual(4);
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.activeSourceCount ?? 0,
  )).toBeGreaterThanOrEqual(4);
  const simultaneousSchedules = sourceSchedules.slice(-4);
  expect(simultaneousSchedules.map((entry) => entry.stem).sort()).toEqual(
    ["bass", "drums", "other", "vocals"],
  );
  for (const entry of simultaneousSchedules) {
    expect(entry.playbackRate).toBe(1);
    expect(entry.scheduledSourceStartTime)
      .toBe(simultaneousSchedules[0].scheduledSourceStartTime);
  }

  await page.getByRole("button", { name: "DRUMS mute" }).click();
  let stemGains = await page.evaluate(() =>
    window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.activeSources ?? [],
  );
  expect(stemGains.find((source) => source.stem === "drums")?.effectiveGain).toBe(0);
  expect(stemGains.find((source) => source.stem === "bass")?.effectiveGain).toBe(1);
  await page.getByRole("button", { name: "DRUMS mute" }).click();

  await page.getByRole("button", { name: "VOCALS solo" }).click();
  stemGains = await page.evaluate(() =>
    window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.activeSources ?? [],
  );
  expect(stemGains.find((source) => source.stem === "vocals")?.effectiveGain).toBe(1);
  expect(stemGains.find((source) => source.stem === "drums")?.effectiveGain).toBe(0);
  await page.getByRole("button", { name: "VOCALS solo" }).click();

  await page.evaluate(() => window.__SONICLAB_E2E__!.pause());
  const pausedAt = await page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().transport.currentTime,
  );
  await page.waitForTimeout(300);
  const stillPausedAt = await page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().transport.currentTime,
  );
  expect(Math.abs(stillPausedAt - pausedAt)).toBeLessThan(0.01);
  await page.evaluate(() => window.__SONICLAB_E2E__!.resume());
  await page.evaluate(() => window.__SONICLAB_E2E__!.seek(6.25));
  await page.waitForTimeout(100);
  const afterSeek = sourceSchedules.slice(-4);
  expect(afterSeek).toHaveLength(4);
  for (const item of afterSeek) {
    expect(Math.abs((item.requestedTimelineAtStart ?? 0) - 6.25)).toBeLessThan(0.1);
    expect(Math.abs(item.timelineDifferenceMs ?? Infinity)).toBeLessThanOrEqual(
      1000 / (item.sampleRate ?? 1),
    );
  }

  const vocalsClip = page.locator('[aria-label="VOCALS arrangement"] [data-clip-id]').first();
  await vocalsClip.getByRole("button", { name: "Pause clip" }).click();
  const afterIndividualPause = await page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().transport.playingClipIds,
  );
  expect(afterIndividualPause.some((id) => id.startsWith("drums:"))).toBe(true);
  expect(afterIndividualPause.some((id) => id.startsWith("vocals:"))).toBe(false);
  await vocalsClip.getByRole("button", { name: "Play clip" }).click();

  // Exercise the actual split and loop controls and check source ranges remain
  // attached to clips in the store.
  const drumsClip = page.locator('[aria-label="DRUMS arrangement"] [data-clip-id]').first();
  await drumsClip.getByRole("button", { name: "Cut clip in half" }).click();
  await expect(page.locator('[aria-label="DRUMS arrangement"] [data-clip-id]')).toHaveCount(2);
  await page.locator('[aria-label="DRUMS arrangement"] [data-clip-id]').first()
    .getByRole("button", { name: "Link clips" }).click();
  await expect(page.locator('[aria-label="DRUMS arrangement"] [data-clip-id]')).toHaveCount(1);
  const loop = vocalsClip.getByRole("button", { name: "Disable clip loop" });
  let loopScheduleCount = sourceSchedules.length;
  await loop.click();
  await expect(vocalsClip.getByRole("button", { name: "Enable clip loop" })).toBeVisible();
  await expect.poll(() => sourceSchedules.length).toBeGreaterThan(loopScheduleCount);
  expect(sourceSchedules.at(-1)?.loopEnabled).toBe(false);
  loopScheduleCount = sourceSchedules.length;
  await vocalsClip.getByRole("button", { name: "Enable clip loop" }).click();
  await expect.poll(() => sourceSchedules.length).toBeGreaterThan(loopScheduleCount);
  expect(sourceSchedules.at(-1)?.loopEnabled).toBe(true);
  const splitRanges = await page.evaluate(() => Object.values(
    window.__SONICLAB_E2E__!.snapshot().clips,
  ).filter((clip) => clip.endTime > 0).map((clip) => [clip.startTime, clip.endTime, clip.sourceStartSample, clip.sourceEndSample]));
  expect(splitRanges.length).toBeGreaterThanOrEqual(5);

  const auditionClip = await page.evaluate(() => {
    const clip = Object.values(window.__SONICLAB_E2E__!.snapshot().clips)
      .find((candidate) => candidate.stem === "drums" && candidate.active)!;
    return { id: clip.id, startTime: clip.startTime, endTime: clip.endTime };
  });
  const vocalsAuditionClip = await page.evaluate(() => {
    const clip = Object.values(window.__SONICLAB_E2E__!.snapshot().clips)
      .find((candidate) => candidate.stem === "vocals" && candidate.active)!;
    return { id: clip.id, startTime: clip.startTime };
  });
  const auditionDuration = auditionClip.endTime - auditionClip.startTime;
  for (const arrangementStart of [10, 30]) {
    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
    await page.evaluate(({ id, startTime }) => {
      window.__SONICLAB_E2E__!.setClipStartTime(id, startTime);
    }, { id: auditionClip.id, startTime: arrangementStart });
    const previousScheduleCount = sourceSchedules.length;
    await page.evaluate((id) => window.__SONICLAB_E2E__!.playClip(id), auditionClip.id);
    await expect.poll(() => sourceSchedules.length).toBeGreaterThan(previousScheduleCount);

    const audition = sourceSchedules.at(-1)!;
    const audioLead = audition.scheduledSourceStartTime! - audition.audioContextCurrentTime!;
    const expectedLocalOffset = audition.sourceStartSample! / audition.sampleRate!;
    expect(audition.clipStartTime).toBe(arrangementStart);
    expect(audition.clipEndTime).toBe(arrangementStart + auditionDuration);
    expect(audition.scheduleMode).toBe("timeline");
    expect(audioLead).toBeGreaterThanOrEqual(0);
    expect(audioLead).toBeLessThan(0.1);
    expect(Math.abs(audition.sourceOffsetSeconds! - expectedLocalOffset) * audition.sampleRate!)
      .toBeLessThanOrEqual(1);
    expect(audition.scheduledSourceStartTime).not.toBeCloseTo(arrangementStart, 1);
    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
  }
  await page.evaluate(({ id, startTime }) => {
    window.__SONICLAB_E2E__!.setClipStartTime(id, startTime);
  }, { id: auditionClip.id, startTime: auditionClip.startTime });

  // While a clip is already running, auditioning a clip at a future
  // arrangement coordinate must join immediately without stopping it.
  await page.evaluate(({ id, startTime }) => {
    window.__SONICLAB_E2E__!.setClipStartTime(id, startTime);
  }, { id: vocalsAuditionClip.id, startTime: 30 });
  await page.evaluate((id) => window.__SONICLAB_E2E__!.playClip(id), auditionClip.id);
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.activeSourceCount ?? 0,
  )).toBeGreaterThanOrEqual(1);
  const previousLocalScheduleCount = sourceSchedules.length;
  await page.evaluate((id) => window.__SONICLAB_E2E__!.playClip(id), vocalsAuditionClip.id);
  await expect.poll(() => sourceSchedules.length).toBeGreaterThan(previousLocalScheduleCount);
  const localAudition = sourceSchedules.at(-1)!;
  expect(localAudition.scheduleMode).toBe("clip-local");
  expect(localAudition.clipStartTime).toBe(30);
  expect(localAudition.scheduledSourceStartTime! - localAudition.audioContextCurrentTime!)
    .toBeLessThan(0.1);
  expect(Math.abs(
    localAudition.sourceOffsetSeconds! -
    localAudition.sourceStartSample! / localAudition.sampleRate!,
  ) * localAudition.sampleRate!).toBeLessThanOrEqual(1);
  const activeAfterLocalAudition = await page.evaluate(() =>
    window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.activeSources ?? [],
  );
  expect(activeAfterLocalAudition.some((source) => source.stem === "drums")).toBe(true);
  expect(activeAfterLocalAudition.some((source) => source.stem === "vocals")).toBe(true);

  await page.evaluate(() => window.__SONICLAB_E2E__!.pause());
  await page.evaluate(() => window.__SONICLAB_E2E__!.resume());
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.activeSourceCount ?? 0,
  )).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
  await page.evaluate(({ id, startTime }) => {
    window.__SONICLAB_E2E__!.setClipStartTime(id, startTime);
  }, { id: vocalsAuditionClip.id, startTime: vocalsAuditionClip.startTime });

  await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().audioDiagnostics?.activeSourceCount ?? -1,
  )).toBe(0);

  const renderCountBeforePlayback = await page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().arrangementRenderCount,
  );
  await page.evaluate(() => window.__SONICLAB_E2E__!.playArrangement(0));
  const frameMetrics = await page.evaluate(() => new Promise<{ fps: number; maxGapMs: number }>((resolve) => {
    let frames = 0;
    let first = 0;
    let previous = 0;
    let maxGapMs = 0;
    const tick = (time: number) => {
      if (!first) first = time;
      if (previous) maxGapMs = Math.max(maxGapMs, time - previous);
      previous = time;
      frames++;
      if (frames >= 90) resolve({ fps: (frames - 1) * 1000 / (time - first), maxGapMs });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
  const renderCountAfterPlayback = await page.evaluate(
    () => window.__SONICLAB_E2E__!.snapshot().arrangementRenderCount,
  );
  expect(frameMetrics.fps).toBeGreaterThanOrEqual(50);
  expect(renderCountAfterPlayback - renderCountBeforePlayback).toBeLessThanOrEqual(2);
  await testInfo.attach("ui-frame-metrics.json", {
    body: JSON.stringify({ ...frameMetrics, arrangementRendersDuringPlayback: renderCountAfterPlayback - renderCountBeforePlayback }, null, 2),
    contentType: "application/json",
  });

  expect(consoleErrors, "browser console errors").toEqual([]);
  expect(failedRequests, "failed browser requests").toEqual([]);
  await testInfo.attach("web-audio-schedules.json", {
    body: JSON.stringify(sourceSchedules, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("buffer-preparations.json", {
    body: JSON.stringify(bufferPreparations, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("late-join-measurements.json", {
    body: JSON.stringify(lateJoinMeasurements, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("section-alignment-offsets.json", {
    body: JSON.stringify({
      toleranceSamples: sectionClipToleranceSamples,
      offsetsRelativeToDrums: sectionTimingOffsets,
    }, null, 2),
    contentType: "application/json",
  });
  await testInfo.attach("browser-version.txt", {
    body: `${browser.browserType().name()} ${browser.version()}`,
    contentType: "text/plain",
  });
  const expectedLocalSectionIds = await page.evaluate(() =>
    window.__SONICLAB_E2E__!.snapshot().sections.map((section) => section.id).sort(),
  );
  await expect.poll(() => page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open("dubpad-local-projects", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const getAll = database.transaction("sections").objectStore("sections").getAllKeys();
      getAll.onsuccess = () => { const value = getAll.result.map(String).sort(); database.close(); resolve(value); };
      getAll.onerror = () => reject(getAll.error);
    };
  }))).toEqual(expectedLocalSectionIds);
  await page.reload();
  await expect.poll(() => page.evaluate(
    () => window.__SONICLAB_E2E__?.snapshot().masterTimelineReady ?? false,
  )).toBe(true);
  await expect(page.locator('[aria-label="DRUMS arrangement"] [data-clip-id]').first()).toBeVisible();
  expect(await page.evaluate(() => Object.keys(window.__SONICLAB_E2E__!.snapshot().clips).length)).toBeGreaterThan(0);
  await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
});
