import { describe, expect, test } from "bun:test";
import { diversifyTracks } from "./diversify";

describe("diversifyTracks", () => {
  test("preserves clustered high-confidence ranks 1 through 5", () => {
    const tracks = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `cluster-${index + 1}`,
        artist: `artist-${index + 1}`,
        title: `title-${index + 1}`,
        episode_id: "clustered-episode",
        taste_score: 0.95 - index / 100,
        metadata: { genres: ["house"], _score_confidence: 0.9 },
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `alternative-${index + 1}`,
        artist: `alternative-artist-${index + 1}`,
        title: `alternative-title-${index + 1}`,
        episode_id: `alternative-episode-${index + 1}`,
        taste_score: 0.8 - index / 100,
        metadata: { genres: [`genre-${index + 1}`], _score_confidence: 0.9 },
      })),
    ];

    const result = diversifyTracks(tracks);
    expect(result.slice(0, 5).map((track) => track.id)).toEqual([
      "cluster-1", "cluster-2", "cluster-3", "cluster-4", "cluster-5",
    ]);
    expect(result[5].id).toStartWith("alternative-");
  });

  test("never promotes negative or placeholder candidates into exploration", () => {
    const tracks = Array.from({ length: 30 }, (_, index) => ({
      id: `track-${index}`,
      artist: index === 28 ? "tracklist" : `artist-${index}`,
      title: `title-${index}`,
      taste_score: index === 29 ? -0.6 : 0.4 - index / 100,
      metadata: { _score_confidence: index >= 20 ? 0 : 0.9 },
    }));
    const result = diversifyTracks(tracks);
    expect(result.findIndex((track) => track.id === "track-29")).toBeGreaterThanOrEqual(28);
    expect(result.findIndex((track) => track.id === "track-28")).toBeGreaterThanOrEqual(27);
    expect(result.findIndex((track) => Number(track.id.slice(6)) >= 20 && Number(track.id.slice(6)) < 28)).toBeLessThan(20);
  });
});