import { describe, expect, spyOn, test } from "bun:test";
import {
  applySeriesSeedContext,
  filterClaimedPreparationTracks,
  orderPreparationTracks,
  diversifyQueueCandidates,
  highConfidencePrefixLength,
  isObviousPlaceholderCandidate,
  isPreparationTrack,
  materializeUserQueue,
  mergeSoulectionPreparationSlice,
  SERIES_SEED_CONTEXT_BOOST,
  SOULECTION_EXPLORATION_EPISODE_LIMIT,
  SOULECTION_EXPLORATION_TRACK_LIMIT,
  soulectionExplorationCandidates,
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

describe("soulection exploration preparation", () => {
  function fakeDb(tables: Record<string, Array<Record<string, any>>>, operations: string[]) {
    return {
      from(table: string) {
        let rows = [...(tables[table] || [])];
        const orders: Array<{ column: string; options: { ascending?: boolean; nullsFirst?: boolean } }> = [];
        const applyOrder = () => rows.sort((left, right) => {
          for (const { column, options } of orders) {
            const a = left[column];
            const b = right[column];
            if (a == null || b == null) {
              if (a == null && b == null) continue;
              const comparison = (a == null ? -1 : 1) * (options.nullsFirst ? 1 : -1);
              if (comparison) return comparison;
            } else {
              const comparison = String(a).localeCompare(String(b));
              if (comparison) return options.ascending === false ? -comparison : comparison;
            }
          }
          return 0;
        });
        const query: any = {
          select() { operations.push(`select:${table}`); return query; },
          eq(column: string, value: unknown) {
            rows = rows.filter((row) => row[column] === value);
            return query;
          },
          is(column: string, value: unknown) {
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
          order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
            orders.push({ column, options });
            return query;
          },
          limit(limit: number) { applyOrder(); rows = rows.slice(0, limit); return query; },
          insert() { operations.push(`insert:${table}`); return query; },
          update() { operations.push(`update:${table}`); return query; },
          upsert() { operations.push(`upsert:${table}`); return query; },
          then(resolve: (value: unknown) => unknown) {
            applyOrder();
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return query;
      },
    };
  }

  test("draws at most three ready-or-acquirable candidates from the newest two episodes", async () => {
    const track = (id: string, youtube_url: string | null, storage_path: string | null = null) => ({
      id, artist: `artist-${id}`, title: `title-${id}`, youtube_url, storage_path,
    });
    const tables = {
      episodes: [
        { id: "release-new", source: "soulection", release_date: "2026-09-10", aired_date: null },
        { id: "aired-new", source: "soulection", release_date: null, aired_date: "2026-09-09" },
        { id: "old", source: "soulection", release_date: "2026-08-01", aired_date: null },
        { id: "foreign", source: "nts", release_date: "2026-09-11", aired_date: null },
      ],
      episode_track_entries: [
        { episode_id: "release-new", position: 0, track_id: "actioned", resolution_state: "canonical", track: track("actioned", "https://youtube.test/actioned") },
        { episode_id: "release-new", position: 1, track_id: "blank", resolution_state: "canonical", track: track("blank", "   ") },
        { episode_id: "release-new", position: 2, track_id: "release-a", resolution_state: "canonical", track: track("release-a", "https://youtube.test/release-a") },
        { episode_id: "aired-new", position: 0, track_id: "stored", resolution_state: "canonical", track: track("stored", "", "tracks/stored.mp3") },
        { episode_id: "aired-new", position: 1, track_id: "aired-a", resolution_state: "canonical", track: track("aired-a", "https://youtube.test/aired-a") },
        { episode_id: "aired-new", position: 2, track_id: "aired-b", resolution_state: "canonical", track: track("aired-b", "https://youtube.test/aired-b") },
        { episode_id: "old", position: 0, track_id: "old-a", resolution_state: "canonical", track: track("old-a", "https://youtube.test/old-a") },
      ],
      user_tracks: [
        { user_id: "user-a", track_id: "actioned", status: "rejected" },
        { user_id: "user-b", track_id: "release-a", status: "approved" },
      ],
    };
    const operations: string[] = [];

    const result = await soulectionExplorationCandidates(fakeDb(tables, operations) as any, "user-a");

    expect(SOULECTION_EXPLORATION_EPISODE_LIMIT).toBe(2);
    expect(SOULECTION_EXPLORATION_TRACK_LIMIT).toBe(3);
    expect(result.map((candidate) => candidate.id)).toEqual(["release-a", "stored", "aired-a"]);
    expect(result.map((candidate) => candidate.episode_id)).toEqual(["release-new", "aired-new", "aired-new"]);
    expect(result.every((candidate) => candidate.metadata?._series_exploration === true)).toBe(true);
    expect(operations).toEqual([
      "select:episodes", "select:episodes", "select:episode_track_entries", "select:user_tracks",
    ]);
    expect(operations.some((operation) => /^(insert|update|upsert):user_(tracks|series_seeds)$/.test(operation))).toBe(false);
  });

  test("keeps the same deterministic candidates after their audio becomes ready", async () => {
    const track = (id: string) => ({
      id,
      artist: `artist-${id}`,
      title: `title-${id}`,
      youtube_url: `https://youtube.test/${id}`,
      storage_path: null as string | null,
    });
    const releaseA = track("release-a");
    const releaseB = track("release-b");
    const airedA = track("aired-a");
    const airedB = track("aired-b");
    const tables = {
      episodes: [
        { id: "release-new", source: "soulection", release_date: "2026-09-10", aired_date: null },
        { id: "aired-new", source: "soulection", release_date: null, aired_date: "2026-09-09" },
      ],
      episode_track_entries: [
        { episode_id: "release-new", position: 0, track_id: releaseA.id, resolution_state: "canonical", track: releaseA },
        { episode_id: "release-new", position: 1, track_id: releaseB.id, resolution_state: "canonical", track: releaseB },
        { episode_id: "aired-new", position: 0, track_id: airedA.id, resolution_state: "canonical", track: airedA },
        { episode_id: "aired-new", position: 1, track_id: airedB.id, resolution_state: "canonical", track: airedB },
      ],
      user_tracks: [],
    };

    const first = await soulectionExplorationCandidates(fakeDb(tables, []) as any, "user-a");
    expect(first.map((candidate) => candidate.id)).toEqual(["release-a", "aired-a", "release-b"]);

    for (const candidate of [releaseA, airedA, releaseB]) {
      candidate.storage_path = `users/user-a/exploration/${candidate.id}.mp3`;
      candidate.youtube_url = "";
    }
    const second = await soulectionExplorationCandidates(fakeDb(tables, []) as any, "user-a");

    expect(second.map((candidate) => candidate.id)).toEqual(first.map((candidate) => candidate.id));
    expect(second.every((candidate) => Boolean(candidate.storage_path))).toBe(true);

    const ordinary = Array.from({ length: 50 }, (_, index) => ({ id: `ordinary-${index + 1}` }));
    const firstQueue = mergeSoulectionPreparationSlice(ordinary, first, 50, 20);
    const secondQueue = mergeSoulectionPreparationSlice(ordinary, second, 50, 20);
    expect(secondQueue).toHaveLength(50);
    expect(secondQueue.slice(17, 20).map((candidate) => candidate.id)).toEqual(
      firstQueue.slice(17, 20).map((candidate) => candidate.id),
    );
  });

  test("keeps 50 rows while placing exploration at the warm-window tail", () => {
    const ordinary = Array.from({ length: 50 }, (_, index) => ({ id: `ordinary-${index + 1}` }));
    const exploration = Array.from({ length: 4 }, (_, index) => ({ id: `exploration-${index + 1}` }));

    const result = mergeSoulectionPreparationSlice(ordinary, exploration, 50, 20);

    expect(result).toHaveLength(50);
    expect(result.slice(0, 17).map((track) => track.id)).toEqual(
      ordinary.slice(0, 17).map((track) => track.id),
    );
    expect(result.slice(17, 20).map((track) => track.id)).toEqual([
      "exploration-1", "exploration-2", "exploration-3",
    ]);
    expect(result.slice(20).map((track) => track.id)).toEqual(
      ordinary.slice(17, 47).map((track) => track.id),
    );
  });

  function materializationDb(options: { failSoulection?: boolean; failRanking?: boolean }) {
    const upsertedRows: Array<Record<string, unknown>> = [];
    return {
      upsertedRows,
      db: {
        from(table: string) {
          const filters: Record<string, unknown> = {};
          let operation = "select";
          const query: any = {
            select() { return query; },
            eq(column: string, value: unknown) { filters[column] = value; return query; },
            is(column: string, value: unknown) { filters[column] = value; return query; },
            in(column: string, values: unknown[]) { filters[column] = values; return query; },
            not() { return query; },
            order() { return query; },
            limit() { return query; },
            range() { return query; },
            update() { operation = "update"; return query; },
            upsert(rows: Array<Record<string, unknown>>) {
              operation = "upsert";
              upsertedRows.push(...rows);
              return query;
            },
            then(resolve: (value: unknown) => unknown) {
              let result: { data: any[]; error: { message: string } | null } = { data: [], error: null };
              if (table === "user_tracks" && filters.status === "pending") {
                result = options.failRanking
                  ? { data: [], error: { message: "ranking unavailable" } }
                  : { data: [{ track_id: "ordinary" }], error: null };
              } else if (table === "user_track_scores") {
                result = {
                  data: [{
                    score: 0.8,
                    confidence: 0.9,
                    components: {},
                    track: {
                      id: "ordinary",
                      artist: "Ordinary Artist",
                      title: "Ordinary Track",
                      youtube_url: "https://youtube.test/ordinary",
                      storage_path: null,
                    },
                  }],
                  error: null,
                };
              } else if (table === "episodes" && filters.source === "soulection" && options.failSoulection) {
                result = { data: [], error: { message: "soulection unavailable" } };
              } else if (table === "audio_preparation_queue" && operation === "upsert") {
                result = { data: [], error: null };
              }
              return Promise.resolve(result).then(resolve);
            },
          };
          return query;
        },
      },
    };
  }

  test("logs and skips Soulection when its optional lookup fails", async () => {
    const { db, upsertedRows } = materializationDb({ failSoulection: true });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(materializeUserQueue("user-a", db as any, 50)).resolves.toBe(1);
      expect(upsertedRows.map((row) => row.track_id)).toEqual(["ordinary"]);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("Soulection exploration failed open");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("keeps ordinary ranking failures fatal", async () => {
    const { db, upsertedRows } = materializationDb({ failRanking: true });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(materializeUserQueue("user-a", db as any, 50)).rejects.toThrow(
        "queue candidate eligibility: ranking unavailable",
      );
      expect(upsertedRows).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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
