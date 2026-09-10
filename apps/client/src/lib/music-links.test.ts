import { describe, expect, test } from "bun:test";
import { diversifyTracks, highConfidencePrefixLength } from "./diversify";
import { extractSpotifyTrackId } from "./spotify-link";
import { extractVideoId } from "./youtube";

describe("external music links", () => {
  test("extracts Spotify track IDs including localized URLs", () => {
    expect(extractSpotifyTrackId("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x")).toBe("4uLU6hMCjMI75M1A2tKUQC");
    expect(extractSpotifyTrackId("https://open.spotify.com/intl-pt/track/4uLU6hMCjMI75M1A2tKUQC")).toBe("4uLU6hMCjMI75M1A2tKUQC");
    expect(extractSpotifyTrackId("https://example.com/track/4uLU6hMCjMI75M1A2tKUQC")).toBeNull();
  });

  test("extracts common YouTube video URL forms", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=2")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});

describe("front-page diversification", () => {
  test("preserves every track while avoiding three repeated contexts when alternatives exist", () => {
    const tracks = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      artist: index < 4 ? "same artist" : `artist ${index}`,
      episode_id: index < 4 ? "same episode" : `episode ${index}`,
      taste_score: 1 - index / 12,
      metadata: { genres: [index < 4 ? "same genre" : `genre ${index}`], _score_confidence: 0.8 },
    }));

    const result = diversifyTracks(tracks);
    expect(result).toHaveLength(tracks.length);
    expect(new Set(result.map((track) => track.id)).size).toBe(tracks.length);
    const prefixLength = highConfidencePrefixLength(tracks);
    for (let index = Math.max(2, prefixLength); index < result.length; index++) {
      const triple = result.slice(index - 2, index + 1);
      expect(new Set(triple.map((track) => track.artist.toLowerCase())).size).toBeGreaterThan(1);
      expect(new Set(triple.map((track) => track.episode_id)).size).toBeGreaterThan(1);
      expect(new Set(triple.map((track) => track.metadata.genres[0])).size).toBeGreaterThan(1);
    }
  });
});
