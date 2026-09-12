import { describe, expect, test } from "bun:test";
import { shouldRevealTangent, tangentDetail, tangentHeadline, type FypTangent } from "./fyp-tangent";

const tangent: FypTangent = {
  id: "tangent-1",
  seed_id: "seed-1",
  seed_name: "Chancha Via Circuito — Jardines",
  generation: 4,
  start_rank: 6,
  added_track_ids: ["a", "b", "c"],
  moved_track_ids: [],
  removed_track_ids: ["old"],
  tracks: [
    { id: "a", artist: "A", title: "One" },
    { id: "b", artist: "B", title: "Two" },
    { id: "c", artist: "C", title: "Three" },
  ],
  removed_tracks: [{ id: "old", artist: "Old", title: "Track" }],
  created_at: "2026-09-11T00:00:00Z",
};

describe("FYP tangent presentation", () => {
  test("states the seed, change and exact placement", () => {
    expect(tangentHeadline(tangent)).toContain("3 tracks from Chancha Via Circuito — Jardines added");
    expect(tangentDetail(tangent)).toContain("positions 6–8");
    expect(tangentDetail(tangent)).toContain("1 older track left");
    expect(tangentDetail(tangent)).toContain("current track did not change");
  });

  test("reveals only when a tangible seed track is added or actually reordered", () => {
    expect(shouldRevealTangent(tangent, ["x"], ["x", "a"], null)).toBe(true);
    expect(shouldRevealTangent(tangent, ["x", "a"], ["x", "a"], null)).toBe(false);
    expect(shouldRevealTangent(tangent, ["x"], ["x", "a"], "tangent-1")).toBe(false);

    const moved = { ...tangent, added_track_ids: [], moved_track_ids: ["a"] };
    expect(shouldRevealTangent(moved, ["x", "a", "y"], ["x", "y", "a"], null)).toBe(true);
    expect(shouldRevealTangent(moved, ["x", "a"], ["x", "a"], null)).toBe(false);
  });
});
