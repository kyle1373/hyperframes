/**
 * Scenario 02: sustained playback frame rate.
 *
 * Loads the 10-video-grid fixture, calls `player.play()`, then samples
 * `requestAnimationFrame` callbacks inside the iframe for ~5 seconds. GSAP's
 * ticker drives rAF continuously while the timeline is playing, so the rAF
 * cadence is a faithful proxy for the effective render frame rate of the full
 * composition (10 simultaneously-decoding videos + GSAP transform updates).
 *
 * Per the proposal:
 *   Test 1: Playback frame rate (player-perf-fps)
 *     Load 10-video composition → play 5s → collect rAF tick count + dropped frames
 *     Assert: fps >= 55 (allow 8% drop from 60), dropped frames < 3
 *
 * Methodology details:
 *   - We install the rAF sampler before calling `play()` so the very first
 *     post-play frame is captured. We then wait for `__player.isPlaying()` to
 *     flip true (the parent→iframe `play` message is async via postMessage)
 *     and *reset* the sample buffer, so the measurement window only contains
 *     frames produced while the runtime was actively playing the timeline.
 *   - FPS is computed as `(samples - 1) / (lastTs - firstTs in seconds)`. This
 *     is independent of wall-clock setTimeout drift — we trust the rAF
 *     timestamps because they are the same numbers the compositor saw.
 *   - A frame is "dropped" when the gap to the previous rAF callback exceeds
 *     1.5 × (1000 / TARGET_FPS) ms. With a 60Hz target that's >25ms, which
 *     matches the conventional "missed at least one vsync" definition used by
 *     Chrome DevTools.
 *
 * Outputs two metrics:
 *   - playback_fps_min       (higher-is-better, baseline key fpsMin)
 *   - playback_dropped_frames_max (lower-is-better, baseline key droppedFramesMax)
 *
 * We aggregate as `min(fps)` and `max(droppedFrames)` across runs because the
 * proposal asserts a floor on fps and a ceiling on dropped frames — the worst
 * sample is the one that matters for guarding against regressions.
 */

import type { Browser, Frame, Page } from "puppeteer-core";
import { loadHostPage } from "../runner.ts";
import type { Metric } from "../perf-gate.ts";

export type FpsScenarioOpts = {
  browser: Browser;
  origin: string;
  /** Number of measurement runs. */
  runs: number;
  /** If null, runs the default fixture (10-video-grid). */
  fixture: string | null;
};

const DEFAULT_FIXTURE = "10-video-grid";
const PLAYBACK_DURATION_MS = 5_000;
const TARGET_FPS = 60;
const DROPPED_FRAME_THRESHOLD_MS = (1000 / TARGET_FPS) * 1.5;
const PLAY_CONFIRM_TIMEOUT_MS = 5_000;
const FRAME_LOOKUP_TIMEOUT_MS = 5_000;

declare global {
  interface Window {
    /** rAF timestamps collected by the sampler (DOMHighResTimeStamp ms). */
    __perfRafSamples?: number[];
    /** Set to false to stop the sampler at the end of the measurement window. */
    __perfRafActive?: boolean;
    /** Most recent rAF request id, so we can cancel cleanly. */
    __perfRafReqId?: number;
    /** Hyperframes runtime player API exposed inside the composition iframe. */
    __player?: {
      play: () => void;
      pause: () => void;
      seek: (timeSeconds: number) => void;
      getTime: () => number;
      getDuration: () => number;
      isPlaying: () => boolean;
    };
  }
}

type RunResult = {
  fps: number;
  droppedFrames: number;
  samples: number;
  elapsedSec: number;
};

/**
 * Find the iframe Puppeteer Frame that hosts the fixture composition. The
 * `<hyperframes-player>` shell wraps an iframe whose URL is derived from the
 * player's `src` attribute, so we match by path substring rather than full URL.
 */
async function getFixtureFrame(page: Page, fixture: string): Promise<Frame> {
  const expected = `/fixtures/${fixture}/`;
  const deadline = Date.now() + FRAME_LOOKUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes(expected));
    if (frame) return frame;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`[scenario:fps] fixture frame not found for "${fixture}" within timeout`);
}

async function runOnce(
  opts: FpsScenarioOpts,
  fixture: string,
  idx: number,
  total: number,
): Promise<RunResult> {
  const ctx = await opts.browser.createBrowserContext();
  try {
    const page = await ctx.newPage();
    const { duration } = await loadHostPage(page, opts.origin, { fixture });
    const frame = await getFixtureFrame(page, fixture);

    // Install the rAF sampler in the iframe context. GSAP's ticker is already
    // hooking rAF here via the runtime; we add a sibling consumer that just
    // records the timestamp on every paint.
    await frame.evaluate(() => {
      window.__perfRafSamples = [];
      window.__perfRafActive = true;
      const tick = (ts: number) => {
        if (!window.__perfRafActive) return;
        window.__perfRafSamples!.push(ts);
        window.__perfRafReqId = requestAnimationFrame(tick);
      };
      window.__perfRafReqId = requestAnimationFrame(tick);
    });

    // Issue play from the host page (parent of the iframe). The player's
    // public `play()` posts a control message into the iframe.
    await page.evaluate(() => {
      const el = document.getElementById("player") as (HTMLElement & { play: () => void }) | null;
      if (!el) throw new Error("[scenario:fps] player element missing on host page");
      el.play();
    });

    // Wait for the runtime to actually transition to playing — this is the
    // signal that the postMessage round trip + timeline.play() finished.
    await frame.waitForFunction(() => window.__player?.isPlaying?.() === true, {
      timeout: PLAY_CONFIRM_TIMEOUT_MS,
    });

    // Reset samples now that playback is confirmed running. Anything captured
    // before this point belongs to the ramp-up window and would skew FPS down.
    await frame.evaluate(() => {
      window.__perfRafSamples = [];
    });

    // Sustain playback for the measurement window.
    await new Promise((r) => setTimeout(r, PLAYBACK_DURATION_MS));

    // Stop the sampler and harvest the timestamps before pausing the runtime,
    // so the pause command can't perturb the tail of the sample window.
    const samples = (await frame.evaluate(() => {
      window.__perfRafActive = false;
      if (window.__perfRafReqId !== undefined) cancelAnimationFrame(window.__perfRafReqId);
      return window.__perfRafSamples ?? [];
    })) as number[];

    await page.evaluate(() => {
      const el = document.getElementById("player") as (HTMLElement & { pause: () => void }) | null;
      el?.pause();
    });

    if (samples.length < 2) {
      throw new Error(
        `[scenario:fps] run ${idx + 1}/${total}: only ${samples.length} rAF samples captured (composition duration ${duration}s)`,
      );
    }

    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const elapsedSec = (last - first) / 1000;
    const fps = (samples.length - 1) / elapsedSec;

    let droppedFrames = 0;
    for (let i = 1; i < samples.length; i++) {
      const gap = samples[i]! - samples[i - 1]!;
      if (gap > DROPPED_FRAME_THRESHOLD_MS) droppedFrames++;
    }

    console.log(
      `[scenario:fps] run[${idx + 1}/${total}] fps=${fps.toFixed(2)} dropped=${droppedFrames} samples=${samples.length} elapsed=${elapsedSec.toFixed(3)}s`,
    );

    await page.close();
    return { fps, droppedFrames, samples: samples.length, elapsedSec };
  } finally {
    await ctx.close();
  }
}

export async function runFps(opts: FpsScenarioOpts): Promise<Metric[]> {
  const fixture = opts.fixture ?? DEFAULT_FIXTURE;
  const runs = Math.max(1, opts.runs);
  console.log(
    `[scenario:fps] fixture=${fixture} runs=${runs} window=${PLAYBACK_DURATION_MS}ms target=${TARGET_FPS}fps droppedThreshold=${DROPPED_FRAME_THRESHOLD_MS.toFixed(2)}ms`,
  );

  const fpsResults: number[] = [];
  const droppedResults: number[] = [];
  for (let i = 0; i < runs; i++) {
    const result = await runOnce(opts, fixture, i, runs);
    fpsResults.push(result.fps);
    droppedResults.push(result.droppedFrames);
  }

  // Worst case wins for both metrics: the proposal asserts fps >= 55 and
  // dropped frames < 3, so a single bad run should be the one that gates.
  const fpsMin = Math.min(...fpsResults);
  const droppedMax = Math.max(...droppedResults);
  console.log(
    `[scenario:fps] aggregate min fps=${fpsMin.toFixed(2)} max dropped=${droppedMax} runs=${runs}`,
  );

  return [
    {
      name: "playback_fps_min",
      baselineKey: "fpsMin",
      value: fpsMin,
      unit: "fps",
      direction: "higher-is-better",
      samples: fpsResults,
    },
    {
      name: "playback_dropped_frames_max",
      baselineKey: "droppedFramesMax",
      value: droppedMax,
      unit: "frames",
      direction: "lower-is-better",
      samples: droppedResults,
    },
  ];
}
