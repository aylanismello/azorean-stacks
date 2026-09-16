import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildSeedMatchSummary } from "./seed-match-summary";

const seedsPage = readFileSync(new URL("../app/seeds/page.tsx", import.meta.url), "utf8");

describe("seed match summary", () => {
  test("separates exact-song and artist-only episode matches", () => {
    const summary = buildSeedMatchSummary("DjRUM", "Frekm, Pt. 1", "seed-track", [
      { id: "exact", match_type: "full" },
      { id: "artist-a", match_type: "artist" },
      { id: "artist-b", match_type: "artist" },
      { id: "legacy", match_type: "unknown" },
    ], [
      { episode_id: "exact", track_id: "seed-track", artist: "DjRUM", title: "Frekm, Pt. 1" },
      { episode_id: "artist-a", track_id: "djrum-a", artist: "Djrum", title: "Mountains Pt. 1" },
      { episode_id: "artist-b", track_id: "djrum-a", artist: "Djrum", title: "Mountains Pt. 1" },
      { episode_id: "artist-b", track_id: "related-a", artist: "Other Artist", title: "Elsewhere" },
      { episode_id: "legacy", track_id: "related-b", artist: "Second Artist", title: "Another" },
      { episode_id: "unlinked", track_id: "ignore", artist: "Ignore", title: "Ignore" },
    ]);

    expect(summary).toEqual({
      exact_episode_matches: 1,
      artist_episode_matches: 2,
      unverified_episode_matches: 1,
      matching_artist_tracks: 1,
      matching_artist_track_names: ["Mountains Pt. 1"],
      artist_match_breakdown: [{ artist: "DjRUM", episodes: 2, tracks: 1 }],
      related_tracks: 2,
      related_artists: 2,
    });
  });

  test("recognizes the actual seed song despite punctuation differences", () => {
    const summary = buildSeedMatchSummary("DjRUM", "Frekm, Pt. 1", null, [
      { id: "episode-a", match_type: "artist" },
    ], [
      { episode_id: "episode-a", track_id: "same-song", artist: "Djrum", title: "Frekm Pt.1" },
      { episode_id: "episode-a", track_id: "other-song", artist: "Djrum", title: "Frekm Pt.2" },
    ]);

    expect(summary.exact_episode_matches).toBe(1);
    expect(summary.artist_episode_matches).toBe(0);
    expect(summary.matching_artist_track_names).toEqual([]);
    expect(summary.related_tracks).toBe(1);
  });

  test("requires the complete credit set for a multi-artist seed", () => {
    const summary = buildSeedMatchSummary(
      "El Guincho, Frikstailers",
      "Kalise - Frikstailers Remix",
      "seed-track",
      [
        { id: "el-guincho-episode", match_type: "unknown" },
        { id: "frik-a", match_type: "unknown" },
        { id: "frik-b", match_type: "unknown" },
        { id: "frik-c", match_type: "unknown" },
      ],
      [
        { episode_id: "el-guincho-episode", track_id: "joint-track", artist: "Frikstailers & El Guincho", title: "Joint Work" },
        { episode_id: "frik-a", track_id: "frik-1", artist: "Frikstailers", title: "Afrotrip" },
        { episode_id: "frik-b", track_id: "frik-2", artist: "Frikstailers", title: "Kepler" },
        { episode_id: "frik-c", track_id: "frik-3", artist: "Frikstailers", title: "Klajnak" },
      ],
    );

    expect(summary.exact_episode_matches).toBe(0);
    expect(summary.artist_episode_matches).toBe(1);
    expect(summary.unverified_episode_matches).toBe(3);
    expect(summary.artist_match_breakdown).toEqual([
      { artist: "El Guincho", episodes: 1, tracks: 1 },
      { artist: "Frikstailers", episodes: 1, tracks: 1 },
    ]);
  });

  test("does not trust a stale artist label without matching track evidence", () => {
    const summary = buildSeedMatchSummary(
      "Ludwig Göransson",
      "Ithaca",
      null,
      [{ id: "nkisi", match_type: "artist" }],
      [{
        episode_id: "nkisi",
        track_id: "collaboration",
        artist: "Ludwig Göransson, Busiswa",
        title: "We Know What You Whisper",
      }],
    );

    expect(summary.artist_episode_matches).toBe(0);
    expect(summary.unverified_episode_matches).toBe(1);
    expect(summary.related_tracks).toBe(0);
  });

  test("renders a dedicated accessible match-details disclosure", () => {
    expect(seedsPage).toContain("How it matched");
    expect(seedsPage).toContain("aria-expanded={showMatchDetails}");
    expect(seedsPage).toContain("Exact song");
    expect(seedsPage).toContain("Same artist");
    expect(seedsPage).toContain("Artist-only links");
    expect(seedsPage).toContain("co-occurring track");
    expect(seedsPage).toContain("verified episodes");
  });
});