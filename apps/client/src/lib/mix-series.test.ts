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

  test("uses the effective date across mixed null date columns with deterministic ties", () => {
    const episodes = [
      { id: "b", title: "Same", release_date: "2026-09-01", aired_date: null },
      { id: "new", title: "Newest", release_date: null, aired_date: "2026-09-10" },
      { id: "a", title: "Same", release_date: "2026-09-01", aired_date: null },
    ];

    expect(recentFirst(episodes).map((episode) => episode.id)).toEqual(["new", "a", "b"]);
  });
});

describe("mix series archive display contract", () => {
  test("shows eight recent episodes initially and reveals eight more per batch", () => {
    const page = readFileSync(
      new URL("../app/mixes/[slug]/page.tsx", import.meta.url),
      "utf8",
    );

    expect(page).toContain("const INITIAL_EPISODES = 8;");
    expect(page).toContain("useState(INITIAL_EPISODES)");
    expect(page).toContain("value + INITIAL_EPISODES");
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

  test("loads fishable canonical availability in one entries query", () => {
    const route = readFileSync(
      new URL("../app/api/series/[slug]/route.ts", import.meta.url),
      "utf8",
    );
    expect(route.match(/db\.from\("episode_track_entries"\)/g)).toHaveLength(1);
    expect(route).toContain("resolution_state,tracks(youtube_url,storage_path,preview_url,spotify_url)");
    expect(route).toContain("canonicalEntryAvailability(entry)");
    expect(route).toContain("acquisition_ready_count");
    expect(route).not.toContain("playable_count");
    expect(route).toContain("fishing_reason");
  });

  test("merges bounded release and aired-only candidates before slicing by effective date", () => {
    const route = readFileSync(
      new URL("../app/api/series/[slug]/route.ts", import.meta.url),
      "utf8",
    );
    expect(route).toContain("const EPISODE_CANDIDATE_WINDOW = 22;");
    expect(route).toContain('.is("release_date", null)');
    expect(route).toContain("const episodes = recentFirst([");
    expect(route).toContain("]).slice(0, 12);");
  });
});
