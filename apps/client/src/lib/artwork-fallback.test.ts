import { describe, expect, test } from "bun:test";
import { artworkCandidates } from "./artwork-fallback";

describe("artwork fallback chain", () => {
  test("keeps track then episode order, dedupes, and removes empty URLs", () => {
    expect(artworkCandidates("https://img/track.jpg", "https://img/episode.jpg", "https://img/track.jpg", null, "")).toEqual([
      "https://img/track.jpg",
      "https://img/episode.jpg",
    ]);
  });
});
