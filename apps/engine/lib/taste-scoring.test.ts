import { describe, expect, test } from "bun:test";
import {
  addYield,
  buildTrackSeedLineage,
  emptyYield,
  estimateYield,
  indexTrackEpisodes,
} from "./taste-scoring";

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
