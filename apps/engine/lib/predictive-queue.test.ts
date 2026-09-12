import { describe, expect, spyOn, test } from "bun:test";
import {
  applyRecentSkipNoveltyPressure,
  applySeriesSeedContext,
  applyUserSonicContext,
  buildFypTangentDelta,
  filterClaimedPreparationTracks,
  orderPreparationTracks,
  diversifyQueueCandidates,
  highConfidencePrefixLength,
  isObviousPlaceholderCandidate,
  isPreparationTrack,
  materializeUserQueue,
  markPreparationState,
  mergeStableQueueCandidates,
  mergeSoulectionPreparationSlice,
  paceQueueCandidates,
  protectedPacingPrefixLength,
  shouldRefreshExplorationLane,
  SERIES_SEED_CONTEXT_BOOST,
  SOULECTION_EXPLORATION_EPISODE_LIMIT,
  SOULECTION_EXPLORATION_TRACK_LIMIT,
  soulectionExplorationCandidates,
  seriesSeedContextTrackIds,
  warmQueueRowsNeedingPreparation,
  type PreparationTrack,
  type WarmQueueRow,
} from "./predictive-queue";

describe("buildFypTangentDelta", () => {
  const track = (id: string) => ({ id });

  test("reports only seed-derived additions and movements with exact placement", () => {
    const delta = buildFypTangentDelta(
      [track("playing"), track("old-a"), track("fresh-existing"), track("retired")],
      [track("playing"), track("fresh-new"), track("fresh-existing"), track("old-a")],
      new Set(["fresh-new", "fresh-existing"]),
      3,
    );
    expect(delta).toEqual({
      trackIds: ["fresh-new"],
      addedTrackIds: ["fresh-new"],
      movedTrackIds: [],
      removedTrackIds: ["retired"],
      startRank: 2,
    });
  });

  test("returns no tangent when seed candidates did not actually change", () => {
    const queue = [track("playing"), track("fresh-a"), track("old-a")];
    expect(buildFypTangentDelta(queue, queue, new Set(["fresh-a"]), 3)).toEqual({
      trackIds: [],
      addedTrackIds: [],
      movedTrackIds: [],
      removedTrackIds: [],
      startRank: null,
    });
  });

  test("bounds affected seed tracks to the requested lane size", () => {
    const delta = buildFypTangentDelta(
      [track("playing")],
      [track("playing"), track("fresh-a"), track("fresh-b"), track("fresh-c"), track("fresh-d")],
      new Set(["fresh-a", "fresh-b", "fresh-c", "fresh-d"]),
      3,
    );
    expect(delta.trackIds).toEqual(["fresh-a", "fresh-b", "fresh-c"]);
    expect(delta.startRank).toBe(2);
  });
});

describe("applyUserSonicContext", () => {
  test("adds bounded sonic evidence only to eligible ranked candidates", async () => {
    const query: any = {
      select() { return this; },
      eq() { return this; },
      not() { return this; },
      limit: async () => ({
        data: [{ id: "seed-1", track_id: "seed-track", artist: "Artist", title: "Seed" }],
        error: null,
      }),
    };
    let rpcArgs: Record<string, unknown> | null = null;
    const db: any = {
      from: (table: string) => {
        expect(table).toBe("seeds");
        return query;
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe("match_user_sonic_neighbors");
        rpcArgs = args;
        return { data: [{ track_id: "candidate-1", sonic_similarity: 1 }], error: null };
      },
    };

    const [ranked, neutral] = await applyUserSonicContext(db, "user-1", [
      { id: "candidate-1", taste_score: 0.2, metadata: {} },
      { id: "candidate-2", taste_score: 0.2, metadata: {} },
    ], "seed-1");

    expect(ranked.taste_score).toBeCloseTo(0.3, 8);
    expect(ranked.metadata?._score_components).toEqual({ sonic_similarity: 1 });
    expect(ranked.metadata?._sonic_seed_name).toBe("Artist — Seed");
    expect(neutral.taste_score).toBe(0.2);
    const captured = rpcArgs as Record<string, unknown> | null;
    expect(captured?.["p_candidate_track_ids"]).toEqual(["candidate-1", "candidate-2"]);
    expect(captured?.["p_seed_track_ids"]).toEqual(["seed-track"]);
  });

  test("uses recent likes for attraction and rejects for bounded avoidance", async () => {
    const chain = (rows: any[]) => ({
      select() { return this; },
      eq() { return this; },
      not() { return this; },
      in() { return this; },
      order() { return this; },
      limit: async () => ({ data: rows, error: null }),
    });
    const references: string[][] = [];
    const db: any = {
      from: (table: string) => table === "seeds"
        ? chain([{ id: "seed-1", track_id: "seed-track", artist: "Artist", title: "Seed" }])
        : chain([
            { track_id: "liked-track", status: "approved" },
            { track_id: "rejected-track", status: "rejected" },
          ]),
      rpc: async (_name: string, args: Record<string, any>) => {
        references.push(args.p_seed_track_ids);
        const rejected = args.p_seed_track_ids.includes("rejected-track");
        return {
          data: [{ track_id: "candidate-1", sonic_similarity: rejected ? 1 : 0.9 }],
          error: null,
        };
      },
    };

    const [ranked] = await applyUserSonicContext(db, "user-1", [
      { id: "candidate-1", taste_score: 0.4, metadata: {} },
    ]);

    expect(references).toEqual([
      ["seed-track", "liked-track"],
      ["rejected-track"],
    ]);
    expect(ranked.taste_score).toBeCloseTo(0.38);
    expect((ranked.metadata?._score_components as Record<string, number>).sonic_similarity).toBeCloseTo(-0.2);
    expect(ranked.metadata?._sonic_seed_name).toBe("your active seeds and likes");
  });
});

describe("mergeStableQueueCandidates", () => {
  const track = (id: string) => ({ id });

  test("ordinary refresh preserves the active queue and only backfills", () => {
    expect(mergeStableQueueCandidates(
      [track("old-1"), track("old-2")],
      [track("new-1"), track("old-2"), track("new-2")],
      4,
    ).map((row) => row.id)).toEqual(["old-1", "old-2", "new-1", "new-2"]);
  });

  test("ordinary refresh updates retained scores without changing order", () => {
    const result = mergeStableQueueCandidates(
      [{ id: "old-1", taste_score: 0.8, metadata: { _score_components: { seed_freshness: 0.3 } } }],
      [{ id: "old-1", taste_score: 0.2, metadata: { _score_components: { artist: 0.2 } } }],
      1,
    );
    expect(result[0].taste_score).toBe(0.2);
    expect(result[0].metadata?._score_components).toEqual({ artist: 0.2 });
  });

  test("seed refresh injects only a bounded fresh lane after the protected front", () => {
    expect(mergeStableQueueCandidates(
      [track("old-1"), track("old-2"), track("old-3"), track("old-4")],
      [track("other"), track("fresh-1"), track("fresh-2"), track("fresh-3")],
      6,
      2,
      2,
      new Set(["fresh-1", "fresh-2", "fresh-3"]),
    ).map((row) => row.id)).toEqual([
      "old-1", "old-2", "fresh-1", "fresh-2", "old-3", "old-4",
    ]);
  });

  test("repeated seed refresh does not inject beyond the active seed cap", () => {
    expect(mergeStableQueueCandidates(
      [track("old-1"), track("fresh-1"), track("fresh-2")],
      [track("fresh-1"), track("fresh-2"), track("fresh-3"), track("other")],
      3,
      2,
      1,
      new Set(["fresh-1", "fresh-2", "fresh-3"]),
    ).map((row) => row.id)).toEqual(["old-1", "fresh-1", "fresh-2"]);
  });

  test("never moves an existing latest-seed track out of the protected prefix", () => {
    const existing = ["fresh-1", "old-2", "old-3", "old-4", "old-5", "old-6"].map(track);
    const result = mergeStableQueueCandidates(
      existing,
      [track("fresh-2"), track("fresh-3")],
      7,
      3,
      5,
      new Set(["fresh-1", "fresh-2", "fresh-3"]),
    );
    expect(result.slice(0, 5).map((row) => row.id)).toEqual(existing.slice(0, 5).map((row) => row.id));
  });
});

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
  test("does not let a high-confidence prefix bypass episode and show pacing", () => {
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
    expect(result[0].id).toBe("cluster-1");
    expect(result[1].id).toStartWith("alternative-");
    expect(result.slice(0, 5).filter((track) => track.episode_ids?.[0] === "clustered-episode")).toHaveLength(2);
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
    expect(result).toHaveLength(50);
    for (let start = 0; start < result.length; start++) {
      const window = result.slice(start, start + 10);
      expect(window.filter((track) => track.episode_ids?.[0] === "episode-a").length).toBeLessThanOrEqual(2);
      expect(window.filter((track) => track.episode_ids?.[0] === "episode-b").length).toBeLessThanOrEqual(2);
    }
    for (let index = 1; index < result.length; index++) {
      expect(result[index].episode_ids?.[0]).not.toBe(result[index - 1].episode_ids?.[0]);
    }
  });

  test("spaces artist aliases, episodes, and shows in the final post-merge queue", () => {
    const candidates = [
      { id: "flylo-1", artist: "Flying Lotus", episode_id: "ep-a", source_contexts: ["show-a"] },
      { id: "flylo-2", artist: "FlyLo", episode_id: "ep-b", source_contexts: ["show-a"] },
      { id: "flylo-3", artist: "Flying Lotus feat. Guest", episode_id: "ep-c", source_contexts: ["show-a"] },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `other-${index}`,
        artist: `Other ${index}`,
        episode_id: index < 3 ? "ep-a" : `ep-${index}`,
        source_contexts: index < 5 ? ["show-a"] : [`show-${index}`],
      })),
    ];
    const result = paceQueueCandidates(candidates, candidates.length);
    for (let index = 1; index < Math.min(10, result.length); index++) {
      const pair = result.slice(index - 1, index);
      expect(pair[0].artist === result[index].artist && pair[0].artist === "Flying Lotus").toBe(false);
      expect(pair[0].episode_id).not.toBe(result[index].episode_id);
      expect(pair[0].source_contexts?.[0]).not.toBe(result[index].source_contexts?.[0]);
    }
    const nearTerm = result.slice(0, 10);
    expect(nearTerm.filter((track) => ["Flying Lotus", "FlyLo", "Flying Lotus feat. Guest"].includes(String(track.artist || ""))).length).toBeLessThanOrEqual(2);
    expect(nearTerm.filter((track) => track.episode_id === "ep-a").length).toBeLessThanOrEqual(2);
    expect(nearTerm.filter((track) => track.source_contexts?.[0] === "show-a").length).toBeLessThanOrEqual(3);
  });

  test("paces only after the protected stable prefix", () => {
    const candidates = [
      { id: "stable-1", artist: "A" },
      { id: "stable-2", artist: "A" },
      { id: "alternative", artist: "B" },
      { id: "tail", artist: "A" },
    ];

    expect(paceQueueCandidates(candidates, candidates.length, 2).map((track) => track.id)).toEqual([
      "stable-1", "stable-2", "alternative", "tail",
    ]);
  });

  test("protects the whole retained queue on routine refreshes and only five rows for seed branches", () => {
    expect(protectedPacingPrefixLength("ranking_refresh", 8, 10)).toBe(8);
    expect(protectedPacingPrefixLength("ranking_refresh", 12, 10)).toBe(10);
    expect(protectedPacingPrefixLength("seed_refresh", 8, 10)).toBe(5);
    expect(protectedPacingPrefixLength("seed_refresh", 3, 10)).toBe(3);
    expect(shouldRefreshExplorationLane("ranking_refresh", 20)).toBe(false);
    expect(shouldRefreshExplorationLane("ranking_refresh", 0)).toBe(true);
    expect(shouldRefreshExplorationLane("seed_refresh", 20)).toBe(true);
  });

  test("paces shared secondary episode and show appearances", () => {
    const candidates = [
      { id: "first", artist: "A", episode_ids: ["ep-a", "shared-ep"], source_contexts: ["show-a", "shared-show"] },
      { id: "second", artist: "B", episode_ids: ["ep-b", "shared-ep"], source_contexts: ["show-b", "shared-show"] },
      { id: "alternative", artist: "C", episode_ids: ["ep-c"], source_contexts: ["show-c"] },
    ];

    expect(paceQueueCandidates(candidates).map((track) => track.id)).toEqual([
      "first", "alternative", "second",
    ]);
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

describe("applyRecentSkipNoveltyPressure", () => {
  test("cools recently skipped artist, episode, and show without making skip a rejection", () => {
    const [cooled, untouched] = applyRecentSkipNoveltyPressure([
      {
        id: "candidate-a",
        artist: "FlyLo",
        episode_id: "episode-a",
        source_contexts: ["show-a"],
        taste_score: 0.7,
        metadata: { _score_components: { artist: 0.2 } },
      },
      {
        id: "candidate-b",
        artist: "Someone Else",
        episode_id: "episode-b",
        source_contexts: ["show-b"],
        taste_score: 0.7,
        metadata: { _score_components: { artist: 0.2 } },
      },
    ], [{
      id: "skipped",
      artist: "Flying Lotus feat. Guest",
      episode_id: "episode-a",
      source_contexts: ["show-a"],
    }]);

    expect(cooled.taste_score).toBe(0.64);
    expect(cooled.metadata?._score_components).toEqual({ artist: 0.2, novelty_cooldown: -0.06 });
    expect(untouched.taste_score).toBe(0.7);
    expect(untouched.metadata?._score_components).toEqual({ artist: 0.2 });
  });

  test("bounds repeated familiarity pressure and preserves candidate eligibility", () => {
    const candidates = [{ id: "candidate", artist: "Flying Lotus", taste_score: 0.5 }];
    const skipped = Array.from({ length: 20 }, (_, index) => ({ id: `skip-${index}`, artist: "FlyLo" }));
    const result = applyRecentSkipNoveltyPressure(candidates, skipped);
    expect(result).toHaveLength(1);
    expect(result[0].taste_score).toBe(0.42);
    expect(result[0].metadata?._score_components).toEqual({ novelty_cooldown: -0.08 });
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
        { episode_id: "release-new", position: 2, track_id: "seeded", resolution_state: "canonical", track: track("seeded", "https://youtube.test/seeded") },
        { episode_id: "release-new", position: 3, track_id: "release-a", resolution_state: "canonical", track: track("release-a", "https://youtube.test/release-a") },
        { episode_id: "aired-new", position: 0, track_id: "stored", resolution_state: "canonical", track: track("stored", "", "tracks/stored.mp3") },
        { episode_id: "aired-new", position: 1, track_id: "aired-a", resolution_state: "canonical", track: track("aired-a", "https://youtube.test/aired-a") },
        { episode_id: "aired-new", position: 2, track_id: "aired-b", resolution_state: "canonical", track: track("aired-b", "https://youtube.test/aired-b") },
        { episode_id: "old", position: 0, track_id: "old-a", resolution_state: "canonical", track: track("old-a", "https://youtube.test/old-a") },
      ],
      user_tracks: [
        { user_id: "user-a", track_id: "actioned", status: "rejected" },
        { user_id: "user-b", track_id: "release-a", status: "approved" },
      ],
      seeds: [{ user_id: "user-a", track_id: "seeded", active: true }],
    };
    const operations: string[] = [];

    const result = await soulectionExplorationCandidates(fakeDb(tables, operations) as any, "user-a");

    expect(SOULECTION_EXPLORATION_EPISODE_LIMIT).toBe(2);
    expect(SOULECTION_EXPLORATION_TRACK_LIMIT).toBe(3);
    expect(result.map((candidate) => candidate.id)).toEqual(["release-a", "stored", "aired-a"]);
    expect(result.map((candidate) => candidate.episode_id)).toEqual(["release-new", "aired-new", "aired-new"]);
    expect(result.every((candidate) => candidate.metadata?._series_exploration === true)).toBe(true);
    expect(operations).toEqual([
      "select:episodes", "select:episodes", "select:episode_track_entries", "select:user_tracks", "select:seeds",
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

  test("repositions retained exploration rows back into reserved ranks 18 through 20", () => {
    const exploration = [
      { id: "exploration-1" },
      { id: "exploration-2" },
      { id: "exploration-3" },
    ];
    const ordinary = [
      ...Array.from({ length: 17 }, (_, index) => ({ id: `ordinary-${index + 1}` })),
      ...exploration,
      ...Array.from({ length: 30 }, (_, index) => ({ id: `ordinary-${index + 18}` })),
    ];
    const shifted = [
      ...ordinary.slice(0, 5),
      { id: "seed-1" }, { id: "seed-2" }, { id: "seed-3" },
      ...ordinary.slice(5),
    ].slice(0, 50);

    const result = mergeSoulectionPreparationSlice(shifted, exploration, 50, 20);
    expect(result).toHaveLength(50);
    expect(result.slice(17, 20).map((track) => track.id)).toEqual(
      exploration.map((track) => track.id),
    );
  });

  function materializationDb(options: { failSoulection?: boolean; failRanking?: boolean; activeSeed?: boolean }) {
    const upsertedRows: Array<Record<string, unknown>> = [];
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      upsertedRows,
      rpcCalls,
      db: {
        async rpc(name: string, args: Record<string, unknown>) {
          rpcCalls.push({ name, args });
          return { data: 1, error: null };
        },
        from(table: string) {
          const filters: Record<string, unknown> = {};
          let operation = "select";
          const query: any = {
            select() { return query; },
            eq(column: string, value: unknown) { filters[column] = value; return query; },
            gt(column: string, value: unknown) { filters[column] = value; return query; },
            gte(column: string, value: unknown) { filters[column] = value; return query; },
            is(column: string, value: unknown) { filters[column] = value; return query; },
            in(column: string, values: unknown[]) { filters[column] = values; return query; },
            not() { return query; },
            order() { return query; },
            limit() { return query; },
            range() { return query; },
            async maybeSingle() { return { data: null, error: null }; },
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
              } else if (table === "seeds" && filters.active === true) {
                result = options.activeSeed
                  ? { data: [{ user_id: "user-a", track_id: "ordinary", active: true }], error: null }
                  : { data: [], error: null };
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

  test("removes active seed tracks from queue eligibility", async () => {
    const { db, upsertedRows } = materializationDb({ activeSeed: true });
    await expect(materializeUserQueue("user-a", db as any, 50)).resolves.toBe(0);
    expect(upsertedRows).toEqual([]);
  });

  test("publishes one durable generation after seed queue materialization", async () => {
    const { db, rpcCalls } = materializationDb({});
    await materializeUserQueue("user-a", db as any, 50, 3, {
      reason: "seed_refresh",
      seedId: "seed-a",
    });
    expect(rpcCalls).toEqual([{
      name: "publish_fyp_generation",
      args: {
        p_user_id: "user-a",
        p_reason: "seed_refresh",
        p_seed_id: "seed-a",
      },
    }]);
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

describe("markPreparationState", () => {
  test("publishes readiness once for every affected queue owner", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const query: any = {
      update() { return query; },
      eq() { return query; },
      in() { return query; },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    const db = {
      from() { return query; },
      async rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return { data: 1, error: null };
      },
    };
    const track = {
      id: "track-a",
      queue_user_ids: ["user-a", "user-a", "user-b"],
    } as PreparationTrack;

    await markPreparationState(track, "ready", null, db as any);
    expect(rpcCalls).toEqual([
      {
        name: "publish_fyp_generation",
        args: { p_user_id: "user-a", p_reason: "ranking_refresh", p_seed_id: null },
      },
      {
        name: "publish_fyp_generation",
        args: { p_user_id: "user-b", p_reason: "ranking_refresh", p_seed_id: null },
      },
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
