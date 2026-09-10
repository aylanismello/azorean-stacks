import { describe, expect, test } from "bun:test";
import {
  applySeriesSeedContext,
  filterClaimedPreparationTracks,
  orderPreparationTracks,
  diversifyQueueCandidates,
  highConfidencePrefixLength,
  isObviousPlaceholderCandidate,
  isPreparationTrack,
  SERIES_SEED_CONTEXT_BOOST,
  seriesSeedContextTrackIds,
  warmQueueRowsNeedingPreparation,
  type PreparationTrack,
  type WarmQueueRow,
} from "./predictive-queue";

describe("applySeriesSeedContext", () => {
  const candidate = (id: string, score: number) => ({
    id,
    artist: `artist-${id}`,
    title: `title-${id}`,
    taste_score: score,
    metadata: { _score_confidence: 0.5, _score_components: { artist: 0.2 } },
  });

  test("adjusts ordering among existing eligible tracks with a bounded explainable component", () => {
    const eligible = [candidate("unseeded", 0.21), candidate("seeded", 0.2)];
    const ranked = applySeriesSeedContext(eligible, ["seeded"])
      .sort((left, right) => Number(right.taste_score) - Number(left.taste_score));

    expect(ranked.map((track) => track.id)).toEqual(["seeded", "unseeded"]);
    expect(ranked[0].taste_score).toBeCloseTo(0.2 + SERIES_SEED_CONTEXT_BOOST);
    expect(ranked[0].metadata?._score_components).toEqual({
      artist: 0.2,
      series_seed_context: SERIES_SEED_CONTEXT_BOOST,
    });
    expect(ranked[0].metadata?._score_confidence).toBe(0.5);
    expect(SERIES_SEED_CONTEXT_BOOST).toBeLessThan(0.1);
    expect(SERIES_SEED_CONTEXT_BOOST).toBeLessThan(1);
  });

  test("does not boost unseeded or foreign-series tracks", () => {
    const eligible = [candidate("owned-series", 0.2), candidate("foreign-series", 0.2)];
    const ranked = applySeriesSeedContext(eligible, ["owned-series", "not-this-users-track"]);

    expect(ranked[0].taste_score).toBe(0.24);
    expect(ranked[1]).toEqual(eligible[1]);
  });

  test("never admits series-only tracks or mutates the eligible candidate set", () => {
    const eligible = [candidate("already-in-user-tracks", 0.2)];
    const ranked = applySeriesSeedContext(eligible, ["series-only-track"]);

    expect(ranked).toEqual(eligible);
    expect(ranked.map((track) => track.id)).not.toContain("series-only-track");
  });

  test("scopes the series join to the user and eligible tracks without writes", async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      user_series_seeds: [
        { user_id: "user-a", series_id: "owned-series" },
        { user_id: "user-b", series_id: "foreign-series" },
      ],
      episodes: [
        { id: "owned-episode", series_id: "owned-series" },
        { id: "foreign-episode", series_id: "foreign-series" },
      ],
      episode_track_entries: [
        { episode_id: "owned-episode", track_id: "eligible-owned" },
        { episode_id: "owned-episode", track_id: "series-only" },
        { episode_id: "foreign-episode", track_id: "eligible-foreign" },
      ],
    };
    const operations: string[] = [];
    const db = {
      from(table: string) {
        let rows = [...(tables[table] || [])];
        operations.push(`select:${table}`);
        const query: any = {
          select() { return query; },
          eq(column: string, value: unknown) {
            rows = rows.filter((row) => row[column] === value);
            return query;
          },
          in(column: string, values: unknown[]) {
            rows = rows.filter((row) => values.includes(row[column]));
            return query;
          },
          not(column: string, operator: string) {
            if (operator === "is") rows = rows.filter((row) => row[column] !== null);
            return query;
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return query;
      },
    };

    const matches = await seriesSeedContextTrackIds(
      db as any,
      "user-a",
      ["eligible-owned", "eligible-foreign"],
    );

    expect([...matches]).toEqual(["eligible-owned"]);
    expect(matches.has("eligible-foreign")).toBe(false);
    expect(matches.has("series-only")).toBe(false);
    expect(operations).toEqual([
      "select:user_series_seeds",
      "select:episodes",
      "select:episode_track_entries",
    ]);
  });
});

describe("diversifyQueueCandidates", () => {
  test("preserves clustered high-confidence ranks 1 through 5 before applying caps", () => {
    const candidates = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `cluster-${index + 1}`,
        artist: `artist-${index + 1}`,
        title: `title-${index + 1}`,
        taste_score: 0.95 - index / 100,
        episode_ids: ["clustered-episode"],
        source_contexts: ["clustered-show"],
        metadata: { _score_confidence: 0.92 },
      })),
      ...Array.from({ length: 42 }, (_, index) => ({
        id: `alternative-${index + 1}`,
        artist: `alternative-artist-${index + 1}`,
        title: `alternative-title-${index + 1}`,
        taste_score: 0.8 - index / 100,
        episode_ids: [`alternative-episode-${index + 1}`],
        source_contexts: [`alternative-show-${index + 1}`],
        metadata: { _score_confidence: 0.9 },
      })),
    ];

    const result = diversifyQueueCandidates(candidates, 50);
    expect(result.slice(0, 5).map((track) => track.id)).toEqual([
      "cluster-1", "cluster-2", "cluster-3", "cluster-4", "cluster-5",
    ]);
    expect(result[5].id).toStartWith("alternative-");
  });

  test("bounds the reserved prefix and stops at the first weak score", () => {
    const track = (id: string, score: number, confidence = 0.9) => ({
      id, taste_score: score, metadata: { _score_confidence: confidence },
    });
    expect(highConfidencePrefixLength(Array.from({ length: 8 }, (_, i) => track(`${i}`, 0.9)), 50)).toBe(5);
    expect(highConfidencePrefixLength([
      track("1", 0.9), track("2", 0.49), track("3", 0.95),
    ], 50)).toBe(1);
    expect(highConfidencePrefixLength([track("1", 0.9, 0.79), track("2", 0.95)], 50)).toBe(0);
  });

  test("balances a 50-track slate dominated by two episodes when alternatives exist", () => {
    const candidate = (id: string, episode: string, source: string, score: number) => ({
      id,
      artist: `artist-${id}`,
      taste_score: score,
      episode_ids: [episode],
      source_contexts: [source],
      metadata: { _score_confidence: 0.8 },
    });
    const candidates = [
      ...Array.from({ length: 26 }, (_, index) => candidate(`a-${index}`, "episode-a", "show-a", 1 - index / 1000)),
      ...Array.from({ length: 18 }, (_, index) => candidate(`b-${index}`, "episode-b", "show-b", 0.9 - index / 1000)),
      ...Array.from({ length: 56 }, (_, index) => candidate(`alt-${index}`, `episode-${index + 2}`, `show-${index + 2}`, 0.8 - index / 1000)),
    ];

    const result = diversifyQueueCandidates(candidates, 50);
    const episodeCounts = result.flatMap((track) => track.episode_ids || []).reduce((counts, id) => {
      counts.set(id, (counts.get(id) || 0) + 1);
      return counts;
    }, new Map<string, number>());

    expect(result).toHaveLength(50);
    expect(episodeCounts.get("episode-a")).toBeLessThanOrEqual(5);
    expect(episodeCounts.get("episode-b")).toBeLessThanOrEqual(5);
    const prefixLength = highConfidencePrefixLength(candidates, 50);
    for (let index = Math.max(2, prefixLength); index < result.length; index++) {
      expect(new Set(result.slice(index - 2, index + 1).map((track) => track.episode_ids?.[0])).size).toBeGreaterThan(1);
    }
  });

  test("reserves bounded exploration outside raw top 20 without disturbing a strong prefix", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      id: `rank-${index + 1}`,
      artist: `artist-${index + 1}`,
      title: `title-${index + 1}`,
      taste_score: 1 - index / 100,
      episode_ids: [`episode-${index + 1}`],
      source_contexts: [`series-${index + 1}`],
      metadata: { _score_confidence: index >= 20 ? 0.05 : 0.95 },
    }));
    const result = diversifyQueueCandidates(candidates, 24);
    expect(result.slice(0, 5).map((track) => track.id)).toEqual(candidates.slice(0, 5).map((track) => track.id));
    const promotedExploration = result.filter((track) => Number(track.metadata?._queue_original_rank) > 20
      && Number(track.metadata?._queue_diversity_rank_delta) > 0);
    expect(promotedExploration.length).toBeGreaterThan(0);
    expect(promotedExploration.length).toBeLessThanOrEqual(3);
  });

  test("retains candidates when no alternatives can satisfy diversity caps", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      id: `only-${index}`,
      artist: "same artist",
      taste_score: 1 - index / 100,
      episode_ids: ["only-episode"],
      source_contexts: ["only-show"],
    }));
    expect(diversifyQueueCandidates(candidates, 10)).toHaveLength(10);
  });
});

describe("isObviousPlaceholderCandidate", () => {
  test("excludes only empty or structural tracklist rows", () => {
    expect(isObviousPlaceholderCandidate({ id: "a", artist: "tracklist", title: "Track 1" })).toBe(true);
    expect(isObviousPlaceholderCandidate({ id: "b", artist: "Artist", title: " TRACKLIST " })).toBe(true);
    expect(isObviousPlaceholderCandidate({ id: "c", artist: "", title: "Song" })).toBe(true);
    expect(isObviousPlaceholderCandidate({ id: "d", artist: "Track List", title: "A Weird Song" })).toBe(false);
  });
});

describe("isPreparationTrack", () => {
  test("requires downloader-safe artist, title, and URL strings", () => {
    expect(isPreparationTrack({ id: "ok", artist: "Artist", title: "Title", youtube_url: "https://example.test" })).toBe(true);
    expect(isPreparationTrack({ id: "artist", artist: null, title: "Title", youtube_url: "https://example.test" })).toBe(false);
    expect(isPreparationTrack({ id: "title", artist: "Artist", title: " ", youtube_url: "https://example.test" })).toBe(false);
    expect(isPreparationTrack({ id: "url", artist: "Artist", title: "Title", youtube_url: null })).toBe(false);
  });
});

describe("warmQueueRowsNeedingPreparation", () => {
  test("prepares only non-ready rows inside the upcoming warm window", () => {
    const rows: WarmQueueRow[] = [
      { user_id: "user-a", track_id: "warm-ranked", state: "ranked", rank: 1 },
      { user_id: "user-a", track_id: "warm-ready", state: "ready", rank: 2 },
      { user_id: "user-a", track_id: "cold-ready", state: "ready", rank: 21 },
      { user_id: "user-a", track_id: "cold-ranked", state: "ranked", rank: 22 },
      { user_id: "user-b", track_id: "other-user-warm", state: "preparing", rank: 20 },
    ];

    expect(warmQueueRowsNeedingPreparation(rows, 20).map((row) => row.track_id)).toEqual([
      "warm-ranked",
      "other-user-warm",
    ]);
  });
});

describe("filterClaimedPreparationTracks", () => {
  test("keeps database-claimed tracks in preparation order", () => {
    const tracks = ["first", "second", "third"].map((id, index) => ({
      id,
      artist: "Artist",
      title: id,
      youtube_url: "https://example.test/audio",
      preparation_reason: "predictive_queue",
      preparation_rank: index + 1,
      queue_user_ids: ["user-a"],
    })) as PreparationTrack[];

    expect(filterClaimedPreparationTracks(tracks, ["third", "first"]).map((track) => track.id)).toEqual([
      "first",
      "third",
    ]);
  });
});

describe("orderPreparationTracks", () => {
  test("warms the front page before archival audio", () => {
    const track = (id: string, preparation_reason: PreparationTrack["preparation_reason"], preparation_rank = 0) => ({
      id,
      artist: "Artist",
      title: id,
      youtube_url: "https://example.test/audio",
      preparation_reason,
      preparation_rank,
      queue_user_ids: ["user-a"],
    }) as PreparationTrack;
    const ordered = orderPreparationTracks([
      track("seed", "active_seed"),
      track("approved", "approved"),
      track("front-page", "predictive_queue", 1),
      track("explicit", "explicit_request"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["explicit", "front-page", "approved", "seed"]);
  });
});
