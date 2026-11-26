import { expect, test } from "@playwright/test";

type EngineSnapshot = {
  audioContextCurrentTime: number;
  transport: {
    currentTime: number;
    isPlaying: boolean;
    isPaused: boolean;
    playingClipIds: string[];
  };
  audioDiagnostics: {
    globalTimelinePosition: number;
    activeSourceCount: number;
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
      installSyntheticProject: (timelineStart: number, durationSeconds: number) => string[];
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
      expect(schedule.sourceOffsetSeconds).toBe(0);
      expect(schedule.sourceOffsetSamples).toBe(0);
      expect(schedule.scheduledContextTime - audioClockBeforeClick).toBeGreaterThan(0);
      expect(schedule.scheduledContextTime - audioClockBeforeClick).toBeLessThan(0.2);
      expect(schedule.scheduledContextTime).not.toBe(timelineStart);
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
});
