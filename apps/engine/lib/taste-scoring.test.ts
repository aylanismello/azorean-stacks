import { describe, expect, test } from "bun:test";
import {
  addYield,
  buildTrackSeedLineage,
  emptyYield,
  episodeContextKey,
  estimateYield,
  explicitOutcomeWeight,
  indexTrackEpisodes,
} from "./taste-scoring";

describe("explicitOutcomeWeight", () => {
  test("keeps explicit likes and rejects strong while skips stay taste-neutral", () => {
    expect(explicitOutcomeWeight("approved", true, 5)).toBe(3);
    expect(explicitOutcomeWeight("approved", false, 100)).toBe(1);
    expect(explicitOutcomeWeight("rejected", false, 100)).toBe(-1);
    expect(explicitOutcomeWeight("skipped", false, null)).toBe(0);
    expect(explicitOutcomeWeight("listened", false, null)).toBe(0);
  });

  test("does not guess whether a skip meant neutral or already familiar", () => {
    expect(explicitOutcomeWeight("skipped", false, 0)).toBe(0);
    expect(explicitOutcomeWeight("skipped", false, 5)).toBe(0);
    expect(explicitOutcomeWeight("skipped", false, 90)).toBe(0);
    expect(explicitOutcomeWeight("skipped", false, 100)).toBe(0);
  });

  test("uses a completed listen as weak evidence well below approval", () => {
    expect(explicitOutcomeWeight("listened", false, 80)).toBe(0.15);
    expect(explicitOutcomeWeight("listened", false, 100)).toBe(0.15);
    expect(explicitOutcomeWeight("listened", false, 100)).toBeLessThan(
      explicitOutcomeWeight("approved", false, 1),
    );
  });
});

describe("episodeContextKey", () => {
  test("aggregates separate episodes from one series into a stable context", () => {
    expect(episodeContextKey({ series_id: "series-1", title: "Episode One" })).toBe("series:series-1");
    expect(episodeContextKey({ series_id: "series-1", title: "Episode Two" })).toBe("series:series-1");
  });

  test("keeps the existing show fallback when no series is attached", () => {
    expect(episodeContextKey({ url: "https://www.nts.live/shows/heat-wave/episodes/one" })).toBe("nts:heat-wave");
  });
});

describe("estimateYield", () => {
  test("does not let many ancient votes satisfy current support", () => {
    const accumulator = emptyYield();
    for (let index = 0; index < 100; index++) addYield(accumulator, 1, 0.01);
    expect(estimateYield(accumulator, 0.5, 4, 3)).toBeNull();
  });

  test("uses recent effective support and returns a dampened signal", () => {
    const accumulator = emptyYield();
    addYield(accumulator, 1);
    addYield(accumulator, 1);
    addYield(accumulator, -1);
    const estimate = estimateYield(accumulator, 0.5, 4, 3);
    expect(estimate).not.toBeNull();
    expect(estimate!.samples).toBe(3);
    expect(estimate!.signal).toBeGreaterThan(0);
    expect(estimate!.signal).toBeLessThan(1);
  });
});

describe("indexTrackEpisodes", () => {
  test("keeps every canonical junction plus the legacy fallback", () => {
    const tracks = [{ id: "track-1", episode_id: "legacy" }];
    const links = [
      { track_id: "track-1", episode_id: "episode-a" },
      { track_id: "track-1", episode_id: "episode-b" },
      { track_id: "track-1", episode_id: "episode-a" },
    ];
    expect([...indexTrackEpisodes(tracks, links).get("track-1")!].sort()).toEqual([
      "episode-a",
      "episode-b",
      "legacy",
    ]);
  });
});

describe("buildTrackSeedLineage", () => {
  test("attributes all user-scoped episode appearances without leaking foreign seeds", () => {
    const lineage = buildTrackSeedLineage(
      [{ id: "track-1" }],
      [
        { track_id: "track-1", episode_id: "episode-a" },
        { track_id: "track-1", episode_id: "episode-b" },
      ],
      [
        { episode_id: "episode-a", seed_id: "owned", match_type: "artist" },
        { episode_id: "episode-b", seed_id: "owned", match_type: "full" },
        { episode_id: "episode-b", seed_id: "foreign", match_type: "full" },
      ],
      [{ id: "owned" }],
    );
    expect([...lineage.get("track-1")!]).toEqual([["owned", "full"]]);
  });
});
