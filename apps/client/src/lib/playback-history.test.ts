import { describe, expect, test } from "bun:test";
import { nextPlaybackHistory } from "./playback-history";

type Track = {
  id: string;
  artist: string;
  title: string;
  audioUrl?: string | null;
  audioRefreshUrl?: string | null;
};

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  artist: `Artist ${id}`,
  title: `Track ${id}`,
  ...extra,
});

describe("playback history", () => {
  test("records the passed track newest first", () => {
    expect(nextPlaybackHistory([track("a")], track("b"), "c").map((item) => item.id)).toEqual(["b", "a"]);
  });

  test("does not record a reload of the same track", () => {
    const current = [track("a")];
    expect(nextPlaybackHistory(current, track("b"), "b")).toBe(current);
  });

  test("moves an existing track to the front without duplicates", () => {
    expect(nextPlaybackHistory([track("a"), track("b")], track("b"), "c").map((item) => item.id)).toEqual(["b", "a"]);
  });

  test("drops expiring signed audio when a refresh endpoint exists", () => {
    const result = nextPlaybackHistory([], track("a", {
      audioUrl: "https://signed.example/audio",
      audioRefreshUrl: "/api/tracks/a/audio",
    }), "b");
    expect(result[0].audioUrl).toBeNull();
    expect(result[0].audioRefreshUrl).toBe("/api/tracks/a/audio");
  });

  test("caps retained history", () => {
    expect(nextPlaybackHistory([track("a"), track("b")], track("c"), "d", 2).map((item) => item.id)).toEqual(["c", "a"]);
  });
});
