import { describe, expect, test } from "bun:test";
import { diversifyTracks, paceTracks } from "./diversify";

describe("diversifyTracks", () => {
  test("does not let high-confidence tracks bypass episode pacing", () => {
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
      "cluster-1", "alternative-1", "cluster-2", "alternative-2", "alternative-3",
    ]);
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

  test("paces artist aliases, exact episodes, and originating shows after exploration insertion", () => {
    const showUrl = (episode: string) => `https://www.nts.live/shows/brainfeeder/episodes/${episode}`;
    const tracks = [
      { id: "flylo-1", artist: "Flying Lotus", episode_id: "ep-1", episode: { id: "ep-1", url: showUrl("one") } },
      { id: "flylo-2", artist: "FlyLo", episode_id: "ep-2", episode: { id: "ep-2", url: showUrl("two") } },
      { id: "flylo-3", artist: "Flying Lotus feat. Guest", episode_id: "ep-3", episode: { id: "ep-3", url: showUrl("three") } },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `other-${index}`,
        artist: `Other ${index}`,
        episode_id: index < 3 ? "ep-1" : `other-ep-${index}`,
        episode: {
          id: index < 3 ? "ep-1" : `other-ep-${index}`,
          url: index < 5 ? showUrl(`other-${index}`) : `https://www.nts.live/shows/show-${index}/episodes/latest`,
        },
      })),
    ];
    const result = paceTracks(tracks);
    const nearTerm = result.slice(0, 10);
    expect(nearTerm.filter((track) => ["Flying Lotus", "FlyLo", "Flying Lotus feat. Guest"].includes(track.artist)).length).toBeLessThanOrEqual(2);
    expect(nearTerm.filter((track) => track.episode_id === "ep-1").length).toBeLessThanOrEqual(2);
    expect(nearTerm.filter((track) => track.episode.url.includes("/shows/brainfeeder/")).length).toBeLessThanOrEqual(3);
    for (let index = 1; index < nearTerm.length; index++) {
      expect(nearTerm[index].episode_id).not.toBe(nearTerm[index - 1].episode_id);
      const currentShow = nearTerm[index].episode.url.match(/\/shows\/([^/]+)/)?.[1];
      const previousShow = nearTerm[index - 1].episode.url.match(/\/shows\/([^/]+)/)?.[1];
      expect(currentShow).not.toBe(previousShow);
    }
  });

  test("paces shared secondary episode and show appearances", () => {
    const tracks = [
      { id: "first", artist: "A", episode_ids: ["ep-a", "shared-ep"], source_contexts: ["show-a", "shared-show"] },
      { id: "second", artist: "B", episode_ids: ["ep-b", "shared-ep"], source_contexts: ["show-b", "shared-show"] },
      { id: "alternative", artist: "C", episode_ids: ["ep-c"], source_contexts: ["show-c"] },
    ];

    expect(paceTracks(tracks).map((track) => track.id)).toEqual([
      "first", "alternative", "second",
    ]);
  });
});