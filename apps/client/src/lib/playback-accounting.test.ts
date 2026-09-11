import { describe, expect, test } from "bun:test";
import {
  isRepeatLoopTransition,
  nextPlaybackReport,
  reportablePlaybackMs,
  samplePlaybackClock,
} from "./playback-accounting";

describe("playback accounting", () => {
  test("reports cumulative listening only in complete 30-second chunks", () => {
    expect(reportablePlaybackMs(29_999)).toBe(0);
    expect(reportablePlaybackMs(30_000)).toBe(30_000);
    expect(reportablePlaybackMs(67_000)).toBe(60_000);
  });

  test("advances cumulative reports without double-counting prior chunks", () => {
    const initial = {
      sessionId: "00000000-0000-4000-8000-000000000001",
      trackId: "00000000-0000-4000-8000-000000000002",
      listenedMs: 29_000,
      requestedMs: 0,
    };
    const qualified = nextPlaybackReport(initial, 1_100);
    expect(qualified.requestedMs).toBe(30_000);
    const repeatedTick = nextPlaybackReport(qualified, 500);
    expect(repeatedTick.requestedMs).toBe(30_000);
    const secondChunk = nextPlaybackReport(repeatedTick, 30_000);
    expect(secondChunk.requestedMs).toBe(60_000);
  });

  test("counts wall-clock time only while playback is active", () => {
    let sample = samplePlaybackClock({ sampledAtMs: 1_000, wasPlaying: false }, 2_000, true);
    expect(sample.elapsedPlayingMs).toBe(0);

    sample = samplePlaybackClock(sample.clock, 12_000, false);
    expect(sample.elapsedPlayingMs).toBe(10_000);

    sample = samplePlaybackClock(sample.clock, 42_000, true);
    expect(sample.elapsedPlayingMs).toBe(0); // paused time is excluded
    sample = samplePlaybackClock(sample.clock, 47_000, true);
    expect(sample.elapsedPlayingMs).toBe(5_000);
  });

  test("uses elapsed time rather than media position, so seeks cannot inflate totals", () => {
    const sample = samplePlaybackClock({ sampledAtMs: 10_000, wasPlaying: true }, 11_000, true);
    const state = nextPlaybackReport({
      sessionId: "00000000-0000-4000-8000-000000000001",
      trackId: "00000000-0000-4000-8000-000000000002",
      listenedMs: 0,
      requestedMs: 0,
    }, sample.elapsedPlayingMs);
    expect(state.listenedMs).toBe(1_000);
    expect(state.requestedMs).toBe(0);
  });
});

describe("repeat loop accounting", () => {
  test("starts a fresh pass only on a natural end-to-start wrap", () => {
    expect(isRepeatLoopTransition(118.5, 0.4, 120, true)).toBe(true);
    expect(isRepeatLoopTransition(60, 0.4, 120, true)).toBe(false);
    expect(isRepeatLoopTransition(118.5, 0.4, 120, false)).toBe(false);
  });

  test("does not treat an explicit seek from the end as a repeated pass", () => {
    expect(isRepeatLoopTransition(119, 0, 120, true, true)).toBe(false);
  });
});
