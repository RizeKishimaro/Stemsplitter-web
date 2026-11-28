import { expect, test } from "@playwright/test";

type EngineSnapshot = {
  audioContextCurrentTime: number;
  transport: {
    currentTime: number;
    isPlaying: boolean;
    isBuffering: boolean;
    isPaused: boolean;
    playingClipIds: string[];
  };
  audioDiagnostics: {
    globalTimelinePosition: number;
    activeSourceCount: number;
    playbackStart: {
      requestToSourceStartMs: number;
      audioContextResumeMs: number;
      estimatedClickToAudibleMs: number;
    } | null;
    activeSources: Array<{ clipId: string; stem: string }>;
    activeSchedules: Array<{
      clipId: string;
      scheduledContextTime: number;
      sourceOffsetSeconds: number;
      sourceOffsetSamples: number;
      looping: boolean;
    }>;
  } | null;
};

declare global {
  interface Window {
    __SONICLAB_E2E__?: {
      playArrangement: (position?: number) => Promise<void>;
      playClip: (clipId: string) => Promise<void>;
      pause: () => void;
      resume: () => Promise<void>;
      seek: (position: number) => void;
      stop: () => void;
      clearPreparedBuffers: () => void;
      installSyntheticProject: (timelineStart: number, durationSeconds: number) => string[];
      installRemoteSyntheticProject: (durationSeconds: number) => string[];
      replaceSyntheticProject: (timelineStart: number, durationSeconds: number) => string[];
      snapshot: () => EngineSnapshot;
    };
  }
}

async function installProject(page: import("@playwright/test").Page, start: number, duration: number) {
  await page.waitForFunction(() => !!window.__SONICLAB_E2E__);
  return page.evaluate(([timelineStart, durationSeconds]) =>
    window.__SONICLAB_E2E__!.installSyntheticProject(timelineStart, durationSeconds), [start, duration]);
}

async function snapshot(page: import("@playwright/test").Page) {
  return page.evaluate(() => window.__SONICLAB_E2E__!.snapshot());
}

function makePcmWav(sampleRate: number, frames: number, frequency: number) {
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) {
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * frame / sampleRate) * 8_000), 44 + frame * 2);
  }
  return bytes;
}

async function startClipFromUi(page: import("@playwright/test").Page, clipId: string) {
  const play = page.locator(`[data-clip-id="${clipId}"]`).getByRole("button", { name: "Play clip" });
  await play.hover();
  await play.click();
}

test.describe("Firefox Web Audio lifecycle", () => {
  test("clips positioned at 10 and 30 seconds start immediately in buffer time", async ({ page }) => {
    await page.goto("/?e2e=1");

    for (const timelineStart of [10, 30]) {
      const ids = await installProject(page, timelineStart, 0.8);
      const clipId = ids.find((id) => id.startsWith("drums:"));
      expect(clipId).toBeTruthy();
      const audioClockBeforeClick = (await snapshot(page)).audioContextCurrentTime;
      await startClipFromUi(page, clipId!);

      await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
        .toBe(1);
      const current = await snapshot(page);
      const schedule = current.audioDiagnostics!.activeSchedules[0];
      const startup = current.audioDiagnostics!.playbackStart!;
      expect(schedule.sourceOffsetSeconds).toBe(0);
      expect(schedule.sourceOffsetSamples).toBe(0);
      expect(schedule.scheduledContextTime - audioClockBeforeClick).toBeGreaterThan(0);
      expect(schedule.scheduledContextTime - audioClockBeforeClick).toBeLessThan(0.2);
      expect(schedule.scheduledContextTime).not.toBe(timelineStart);
      expect(startup.audioContextResumeMs).toBeLessThan(300);
      expect(startup.requestToSourceStartMs).toBeLessThan(300);
      expect(startup.estimatedClickToAudibleMs).toBeLessThan(500);
      expect(current.transport.currentTime).toBeGreaterThanOrEqual(timelineStart);

      await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
      await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
        .toBe(0);
    }
  });

  test("a native clip loop advances its playhead for at least ten iterations and survives pause/resume", async ({ page }) => {
    await page.goto("/?e2e=1");
    const ids = await installProject(page, 0, 0.08);
    const clipId = ids.find((id) => id.startsWith("drums:"))!;
    await startClipFromUi(page, clipId);
    await page.waitForTimeout(1_200);

    const afterLoops = await snapshot(page);
    expect(afterLoops.transport.isPlaying).toBe(true);
    expect(afterLoops.transport.currentTime).toBeGreaterThan(0.8);
    expect(afterLoops.audioDiagnostics?.activeSourceCount).toBe(1);
    expect(afterLoops.audioDiagnostics?.activeSchedules[0].looping).toBe(true);

    await page.evaluate(() => window.__SONICLAB_E2E__!.pause());
    const paused = await snapshot(page);
    expect(paused.transport.isPaused).toBe(true);
    expect(paused.audioDiagnostics?.activeSourceCount).toBe(0);
    await page.evaluate(() => window.__SONICLAB_E2E__!.resume());
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
      .toBe(1);
    await page.waitForTimeout(250);
    expect((await snapshot(page)).transport.currentTime).toBeGreaterThan(paused.transport.currentTime);

    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
    const stopped = await snapshot(page);
    expect(stopped.transport.isPlaying).toBe(false);
    expect(stopped.audioDiagnostics?.activeSourceCount).toBe(0);
  });

  test("replacing a playing project disconnects its sources and Stop clears every new source", async ({ page }) => {
    await page.goto("/?e2e=1");
    let ids = await installProject(page, 0, 2);
    for (let iteration = 0; iteration < 3; iteration++) {
      const stem = iteration === 0 ? "drums" : iteration === 1 ? "bass" : "vocals";
      const clipId = ids.find((id) => id.startsWith(`${stem}:`))!;
      await startClipFromUi(page, clipId);
      await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
        .toBe(1);
      expect((await snapshot(page)).audioDiagnostics?.activeSources.map((source) => source.stem))
        .toEqual([stem]);

      ids = await page.evaluate(() => window.__SONICLAB_E2E__!.replaceSyntheticProject(0, 2));
      expect((await snapshot(page)).audioDiagnostics?.activeSourceCount).toBe(0);
    }
    const lastClip = ids.find((id) => id.startsWith("other:"))!;
    await startClipFromUi(page, lastClip);
    expect((await snapshot(page)).audioDiagnostics?.activeSources.map((source) => source.stem)).toEqual(["other"]);

    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
    expect((await snapshot(page)).audioDiagnostics?.activeSourceCount).toBe(0);
  });

  test("all four tracks share one clock through pause, resume, and seek", async ({ page }) => {
    await page.goto("/?e2e=1");
    const ids = await installProject(page, 0, 3);
    await startClipFromUi(page, ids.find((id) => id.startsWith("drums:"))!);
    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
    await page.evaluate(() => window.__SONICLAB_E2E__!.playArrangement(0));
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
      .toBe(4);
    const bassClip = ids.find((id) => id.startsWith("bass:"))!;
    const bassPlayButton = page.locator(`[data-clip-id="${bassClip}"]`).getByRole("button", { name: "Pause clip" });
    await bassPlayButton.hover();
    await bassPlayButton.click();
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
      .toBe(3);
    const resumeBass = page.locator(`[data-clip-id="${bassClip}"]`).getByRole("button", { name: "Play clip" });
    await resumeBass.hover();
    await resumeBass.click();
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
      .toBe(4);
    await page.evaluate(() => window.__SONICLAB_E2E__!.pause());
    expect((await snapshot(page)).audioDiagnostics?.activeSourceCount).toBe(0);
    await page.evaluate(() => window.__SONICLAB_E2E__!.resume());
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount)
      .toBe(4);
    await page.evaluate(() => window.__SONICLAB_E2E__!.seek(1));
    const afterSeek = await snapshot(page);
    expect(afterSeek.audioDiagnostics?.activeSchedules).toHaveLength(4);
    expect(afterSeek.audioDiagnostics?.activeSchedules.every((schedule) => schedule.sourceOffsetSeconds > 0.9)).toBe(true);
    expect(afterSeek.transport.currentTime).toBeGreaterThanOrEqual(1);
    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
    expect((await snapshot(page)).audioDiagnostics?.activeSourceCount).toBe(0);
  });

  test("slow remote stem waits at the shared section barrier and starts on the same audio clock", async ({ page }) => {
    await page.goto("/?e2e=1");
    let bassRequests = 0;
    await page.route("**/e2e-audio/*.wav", async (route) => {
      const stem = new URL(route.request().url()).pathname.split("/").at(-1)!.replace(".wav", "");
      if (stem === "bass") {
        bassRequests++;
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
      const frequency = ({ drums: 73, bass: 113, other: 211, vocals: 421 } as Record<string, number>)[stem] ?? 100;
      await route.fulfill({ contentType: "audio/wav", body: makePcmWav(48_000, 48_000, frequency) });
    });
    await page.evaluate(() => window.__SONICLAB_E2E__!.installRemoteSyntheticProject(1));
    await page.evaluate(() => window.__SONICLAB_E2E__!.playArrangement(0));
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount).toBe(4);
    const diagnostics = (await snapshot(page)).audioDiagnostics!;
    expect(new Set(diagnostics.activeSchedules.map((schedule) => schedule.scheduledContextTime)).size).toBe(1);
    expect(new Set(diagnostics.activeSources.map((source) => source.stem))).toEqual(new Set(["drums", "bass", "other", "vocals"]));
    expect(bassRequests).toBe(1);
    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
  });

  test("slow remote stems rejoin together after arrangement resume and seek", async ({ page }) => {
    await page.goto("/?e2e=1");
    let bassRequests = 0;
    await page.route("**/e2e-audio/*.wav", async (route) => {
      const stem = new URL(route.request().url()).pathname.split("/").at(-1)!.replace(".wav", "");
      if (stem === "bass") {
        bassRequests++;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      await route.fulfill({ contentType: "audio/wav", body: makePcmWav(48_000, 48_000, 120) });
    });
    await page.evaluate(() => window.__SONICLAB_E2E__!.installRemoteSyntheticProject(2));
    await page.evaluate(() => window.__SONICLAB_E2E__!.playArrangement(0));
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount).toBe(4);

    await page.evaluate(() => window.__SONICLAB_E2E__!.pause());
    await page.evaluate(() => window.__SONICLAB_E2E__!.clearPreparedBuffers());
    const beforeResume = bassRequests;
    await page.evaluate(() => window.__SONICLAB_E2E__!.resume());
    expect(bassRequests).toBeGreaterThan(beforeResume);
    const afterResume = (await snapshot(page)).audioDiagnostics!;
    expect(afterResume.activeSourceCount).toBe(4);
    expect(new Set(afterResume.activeSchedules.map((schedule) => schedule.scheduledContextTime)).size).toBe(1);

    await page.evaluate(() => window.__SONICLAB_E2E__!.clearPreparedBuffers());
    await page.evaluate(() => window.__SONICLAB_E2E__!.seek(0.25));
    await expect.poll(async () => (await snapshot(page)).audioDiagnostics?.activeSourceCount).toBe(4);
    const afterSeek = (await snapshot(page)).audioDiagnostics!;
    expect(new Set(afterSeek.activeSchedules.map((schedule) => schedule.scheduledContextTime)).size).toBe(1);
    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
  });

  test("failed stem load reports buffering instead of phantom audible playback", async ({ page }) => {
    await page.goto("/?e2e=1");
    let bassRequests = 0;
    await page.route("**/e2e-audio/*.wav", async (route) => {
      const stem = new URL(route.request().url()).pathname.split("/").at(-1)!.replace(".wav", "");
      if (stem === "bass") {
        bassRequests++;
        await route.fulfill({ status: 503, body: "segment unavailable" });
        return;
      }
      await route.fulfill({ contentType: "audio/wav", body: makePcmWav(48_000, 48_000, 100) });
    });
    await page.evaluate(() => window.__SONICLAB_E2E__!.installRemoteSyntheticProject(1));
    await page.evaluate(() => window.__SONICLAB_E2E__!.playArrangement(0));
    const state = await snapshot(page);
    expect(state.audioDiagnostics?.activeSourceCount).toBe(0);
    expect(state.transport.isPlaying).toBe(false);
    expect(state.transport.isBuffering).toBe(true);
    await page.waitForTimeout(150);
    expect(bassRequests).toBeLessThanOrEqual(2);
    await page.evaluate(() => window.__SONICLAB_E2E__!.stop());
  });
});
