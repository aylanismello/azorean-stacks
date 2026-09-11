import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { acquisitionSource, boundedPreparationWindow, recentFirst } from "./mix-series";

const resolvable = (position: number, track = `track-${position}`) => ({
  position, track_id: track,
  tracks: { youtube_url: `https://youtube.com/watch?v=${position}`, storage_path: null, metadata: {} },
});

describe("mix episode audio preparation", () => {
  test("queues current plus at most five later resolvable appearances", () => {
    const entries = [resolvable(0, "repeat"), { position: 1, track_id: null, tracks: null }, resolvable(2, "repeat"), ...[3, 4, 5, 6, 7, 8].map((position) => resolvable(position))];
    expect(boundedPreparationWindow(entries, 0).map((entry) => entry.position)).toEqual([0, 2, 3, 4, 5, 6]);
  });
  test("does not request already-private or source-less tracks", () => {
    const entries = [
      { position: 0, track_id: "ready", tracks: { storage_path: "ready.mp3", youtube_url: "https://youtube.com/ready" } },
      { position: 1, track_id: "unknown", tracks: { storage_path: null, youtube_url: null, metadata: {} } },
      resolvable(2),
    ];
    expect(boundedPreparationWindow(entries, 0)).toEqual(entries);
    expect(entries.map(acquisitionSource)).toEqual([null, null, "https://youtube.com/watch?v=2"]);
  });

  test("never treats a full-mix or metadata URL as a per-track acquisition source", () => {
    const entry = { position: 0, track_id: "track", tracks: { storage_path: null, youtube_url: null, metadata: { soundcloud_url: "https://soundcloud.com/show/full-mix" } } };
    expect(acquisitionSource(entry)).toBeNull();
  });
});

describe("mix episode ordering", () => {
  test("sorts newest first without mutating input", () => {
    const episodes = [{ title: "Older", release_date: "2026-08-01" }, { title: "Newest", release_date: "2026-09-10" }, { title: "Middle", aired_date: "2026-09-01" }];
    expect(recentFirst(episodes).map((episode) => episode.title)).toEqual(["Newest", "Middle", "Older"]);
    expect(episodes[0].title).toBe("Older");
  });
});

describe("mix series API schema contract", () => {
  test("does not select mix-series-only featured from episodes", () => {
    const route = readFileSync(
      new URL("../app/api/series/[slug]/route.ts", import.meta.url),
      "utf8",
    );
    expect(route).not.toContain("apple_music_url,featured");
    expect(route).toContain('db.from("mix_series").select("*")');
  });
});
