import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  injectSeriesExploration,
  loadSeriesExploration,
} from "./series-exploration";

const fypRoute = readFileSync(new URL("../app/api/fyp/route.ts", import.meta.url), "utf8");

type Call = {
  table: string;
  filters: Array<[string, string, unknown]>;
  limit?: number;
  orders: Array<[string, Record<string, unknown> | undefined]>;
};

function fixtureDb(fixtures: Record<string, any[]>) {
  const calls: Call[] = [];
  let writes = 0;

  class Query {
    private filters: Array<[string, string, unknown]> = [];
    private orders: Array<[string, Record<string, unknown> | undefined]> = [];
    private rowLimit: number | undefined;

    constructor(private table: string) {}
    select() { return this; }
    eq(column: string, value: unknown) { this.filters.push(["eq", column, value]); return this; }
    gt(column: string, value: unknown) { this.filters.push(["gt", column, value]); return this; }
    in(column: string, value: unknown) { this.filters.push(["in", column, value]); return this; }
    is(column: string, value: unknown) { this.filters.push(["is", column, value]); return this; }
    not(column: string, operator: string, value: unknown) {
      this.filters.push(["not", column, `${operator}:${value}`]);
      return this;
    }
    order(column: string, options?: Record<string, unknown>) {
      this.orders.push([column, options]);
      return this;
    }
    limit(value: number) { this.rowLimit = value; return this; }
    insert() { writes++; return this; }
    upsert() { writes++; return this; }
    update() { writes++; return this; }
    delete() { writes++; return this; }
    then(resolve: (value: { data: any[]; error: null }) => unknown) {
      calls.push({ table: this.table, filters: this.filters, limit: this.rowLimit, orders: this.orders });
      let data = [...(fixtures[this.table] || [])];
      for (const [operator, column, value] of this.filters) {
        if (operator === "eq") data = data.filter((row) => row[column] === value);
        if (operator === "in") data = data.filter((row) => (value as unknown[]).includes(row[column]));
        if (operator === "is") data = data.filter((row) => row[column] === value);
        if (operator === "gt") data = data.filter((row) => Number(row[column]) > Number(value));
      }
      for (const [column, options] of [...this.orders].reverse()) {
        const ascending = options?.ascending !== false;
        data.sort((a, b) => {
          const left = a[column];
          const right = b[column];
          if (left == null && right == null) return 0;
          if (left == null) return options?.nullsFirst ? -1 : 1;
          if (right == null) return options?.nullsFirst ? 1 : -1;
          const comparison = String(left).localeCompare(String(right));
          return ascending ? comparison : -comparison;
        });
      }
      if (this.table === "user_tracks") {
        const ids = this.filters.find((filter) => filter[0] === "in" && filter[1] === "track_id")?.[2] as string[] | undefined;
        if (ids) data = data.filter((row) => ids.includes(row.track_id));
      }
      if (this.rowLimit !== undefined) data = data.slice(0, this.rowLimit);
      return Promise.resolve(resolve({ data, error: null }));
    }
  }

  return {
    db: { from(table: string) { return new Query(table); } },
    calls,
    get writes() { return writes; },
  };
}

const series = {
  id: "series-1",
  title: "Soulection Radio",
  source: "soulection",
  source_url: "https://soulection.com/radio",
};

function track(id: string, storage_path: string | null = `audio/${id}.mp3`) {
  return {
    id,
    artist: `Artist ${id}`,
    title: `Track ${id}`,
    source: "soundcloud",
    source_url: `https://soundcloud.com/${id}`,
    source_context: null,
    storage_path,
    preview_url: null,
    spotify_url: null as string | null,
    youtube_url: null as string | null,
    metadata: { original: true },
  };
}

function entry(episode_id: string, position: number, id: string | null, options: { state?: string; playable?: boolean } = {}) {
  return {
    episode_id,
    position,
    track_id: id,
    resolution_state: options.state || "canonical",
    track: id ? track(id, options.playable === false ? null : undefined) : null,
  };
}

describe("loadSeriesExploration", () => {
  test("loads only canonical playable unexplored tracks from the two newest followed episodes", async () => {
    const fixture = fixtureDb({
      user_series_seeds: [
        { user_id: "user-a", series_id: "series-1", series },
      ],
      mix_series: [series],
      episodes: [
        { id: "episode-old", series_id: "series-1", title: "Show 599", source: "soundcloud", release_date: "2026-08-01", aired_date: null, artwork_url: "old.jpg", url: "https://soulection.com/599" },
        { id: "episode-new", series_id: "series-1", title: "Show 601", source: "soundcloud", release_date: "2026-09-01", aired_date: null, artwork_url: "new.jpg", url: "https://soulection.com/601" },
        { id: "episode-mid", series_id: "series-1", title: "Show 600", source: "soundcloud", release_date: "2026-08-15", aired_date: null, artwork_url: "mid.jpg", url: "https://soulection.com/600" },
        { id: "episode-rogue", series_id: "series-rogue", title: "Rogue", source: "other", release_date: "2026-09-10", aired_date: null, artwork_url: null, url: "https://invalid/rogue" },
      ],
      episode_track_entries: [
        entry("episode-new", 0, "ordinary"),
        entry("episode-new", 1, "actioned"),
        entry("episode-new", 2, "unresolved", { state: "unresolved" }),
        entry("episode-new", 3, "unplayable", { playable: false }),
        entry("episode-new", 4, "played"),
        entry("episode-new", 5, "new-a"),
        entry("episode-new", 6, "new-b"),
        entry("episode-mid", 0, "mid-a"),
        entry("episode-mid", 1, "new-a"),
        entry("episode-old", 0, "old-a"),
        entry("episode-rogue", 0, "rogue-a"),
      ],
      user_tracks: [{ user_id: "user-a", track_id: "actioned", status: "rejected" }],
      user_track_play_totals: [{ user_id: "user-a", track_id: "played", play_count: 1 }],
    });

    const rows = await loadSeriesExploration(fixture.db, "user-a", new Set(["ordinary"]), {
      now: new Date("2026-09-10T00:00:00Z"),
    });

    expect(rows.map((row) => row.id)).toEqual(["new-a", "mid-a", "new-b"]);
    expect(rows.every((row) => row.storage_path && row._series_exploration === true)).toBe(true);
    expect(rows[0]).toMatchObject({
      source: "soulection",
      source_context: "Show 601",
      source_url: "https://soulection.com/601",
      episode_id: "episode-new",
      episode: {
        id: "episode-new",
        title: "Show 601",
        source: "soulection",
        url: "https://soulection.com/601",
      },
      metadata: {
        original: true,
        _series_exploration: true,
        _fishing_label: expect.any(String),
        _fishing_score: expect.any(Number),
        _fishing_components: {
          freshness: expect.any(Number),
          resolution: expect.any(Number),
          playability: expect.any(Number),
          track_depth: expect.any(Number),
        },
      },
    });
    expect(fixture.writes).toBe(0);

    const followedCall = fixture.calls.find((call) => call.table === "user_series_seeds")!;
    expect(followedCall.filters).toContainEqual(["eq", "user_id", "user-a"]);
    const episodeCall = fixture.calls.find((call) => call.table === "episodes")!;
    expect(episodeCall.filters).toContainEqual(["in", "series_id", ["series-1"]]);
    const entryCall = fixture.calls.find((call) => call.table === "episode_track_entries")!;
    expect(entryCall.filters).toContainEqual(["in", "episode_id", ["episode-new", "episode-mid"]]);
    const opinionsCall = fixture.calls.find((call) => call.table === "user_tracks")!;
    expect(opinionsCall.filters).toContainEqual(["eq", "user_id", "user-a"]);
    const playsCall = fixture.calls.find((call) => call.table === "user_track_play_totals")!;
    expect(playsCall.filters).toContainEqual(["gt", "play_count", 0]);
  });

  test("keeps YouTube-only tracks out of 4U until playable audio exists", async () => {
    const youtubeOnly = entry("episode-new", 0, "youtube-only", { playable: false });
    youtubeOnly.track!.youtube_url = "https://youtube.com/watch?v=ready-to-pull";
    const fixture = fixtureDb({
      user_series_seeds: [{ user_id: "user-a", series_id: "series-1" }],
      mix_series: [series],
      episodes: [{ id: "episode-new", series_id: "series-1", title: "Show 601", source: "soulection", release_date: "2026-09-01", aired_date: null, artwork_url: null, url: "https://soulection.com/601" }],
      episode_track_entries: [youtubeOnly],
      user_tracks: [],
    });

    expect(await loadSeriesExploration(fixture.db, "user-a", new Set())).toEqual([]);
  });

  test("selects a newer aired-only episode ahead of older release-dated episodes", async () => {
    const fixture = fixtureDb({
      user_series_seeds: [{ user_id: "user-a", series_id: "series-1" }],
      mix_series: [series],
      episodes: [
        { id: "episode-oldest", series_id: "series-1", title: "Show 600", release_date: "2026-08-01", aired_date: null },
        { id: "episode-older", series_id: "series-1", title: "Show 601", release_date: "2026-09-01", aired_date: null },
        { id: "episode-newest", series_id: "series-1", title: "Show 602", release_date: null, aired_date: "2026-09-10" },
      ],
      episode_track_entries: [
        entry("episode-oldest", 0, "stale-track"),
        entry("episode-older", 0, "older-track"),
        entry("episode-newest", 0, "newest-track"),
      ],
      user_tracks: [],
    });

    const rows = await loadSeriesExploration(fixture.db, "user-a", new Set());

    expect(rows.map((row) => row.id)).toEqual(["newest-track", "older-track"]);
    const entryCall = fixture.calls.find((call) => call.table === "episode_track_entries")!;
    expect(entryCall.filters).toContainEqual([
      "in", "episode_id", ["episode-newest", "episode-older"],
    ]);
    const episodeCalls = fixture.calls.filter((call) => call.table === "episodes");
    expect(episodeCalls).toHaveLength(2);
    expect(episodeCalls.every((call) => call.limit === 22)).toBe(true);
  });

  test("neutralizes shared canonical vote fields on response-only rows without writing", async () => {
    const contaminatedEntry = entry("episode-new", 0, "shared-track");
    Object.assign(contaminatedEntry.track!, {
      vote_status: "approved",
      status: "rejected",
      super_liked: true,
      voted_at: "2026-09-09T23:58:00.000Z",
    });
    const fixture = fixtureDb({
      user_series_seeds: [{ user_id: "user-a", series_id: "series-1" }],
      mix_series: [series],
      episodes: [{ id: "episode-new", series_id: "series-1", title: "Show 601", source: "soulection", release_date: "2026-09-01", aired_date: null, artwork_url: null, url: "https://soulection.com/601" }],
      episode_track_entries: [contaminatedEntry],
      user_tracks: [],
    });

    const rows = await loadSeriesExploration(fixture.db, "user-a", new Set());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "shared-track",
      vote_status: "pending",
      status: "pending",
      super_liked: false,
      voted_at: null,
    });
    expect(fixture.writes).toBe(0);
  });

  test("batches user-track exclusions without changing deterministic bounded output", async () => {
    const entries = Array.from({ length: 1001 }, (_, index) => entry("episode-new", index, `track-${index}`));
    const fixture = fixtureDb({
      user_series_seeds: [{ user_id: "user-a", series_id: "series-1", series }],
      mix_series: [series],
      episodes: [{ id: "episode-new", series_id: "series-1", title: "Show 601", source: "soundcloud", release_date: "2026-09-01", aired_date: null, artwork_url: null, url: "https://soulection.com/601" }],
      episode_track_entries: entries,
      user_tracks: [],
    });

    const rows = await loadSeriesExploration(fixture.db, "user-a", new Set());

    expect(rows.map((row) => row.id)).toEqual(["track-0", "track-1", "track-2"]);
    const opinionCalls = fixture.calls.filter((call) => call.table === "user_tracks");
    expect(opinionCalls.map((call) => (call.filters.find((filter) => filter[1] === "track_id")?.[2] as string[]).length)).toEqual([500, 500, 1]);
  });

  test("uses curated Soulection as the default when the user follows no series", async () => {
    const spotifyOnly = entry("episode-new", 0, "default-a", { playable: false });
    spotifyOnly.track!.spotify_url = "https://open.spotify.com/track/default-a";
    const fixture = fixtureDb({
      user_series_seeds: [],
      mix_series: [
        series,
        { id: "series-other", title: "Other", source: "other", source_url: "https://other.test" },
      ],
      episodes: [{ id: "episode-new", series_id: "series-1", title: "Show 601", source: "soulection", release_date: "2026-09-01", aired_date: null, artwork_url: null, url: "https://soulection.com/601" }],
      episode_track_entries: [spotifyOnly],
      user_tracks: [],
    });

    const rows = await loadSeriesExploration(fixture.db, "user-a", new Set());

    expect(rows.map((row) => row.id)).toEqual(["default-a"]);
    expect(rows[0]).toMatchObject({
      storage_path: null,
      spotify_url: "https://open.spotify.com/track/default-a",
    });
    const defaultSeriesCall = fixture.calls.find((call) =>
      call.table === "mix_series" && call.filters.some((filter) => filter[1] === "source"),
    )!;
    expect(defaultSeriesCall.filters).toContainEqual(["eq", "source", "soulection"]);
  });

  test("does not leak another user's followed series or opinions", async () => {
    const otherSeries = { id: "series-other", title: "Private Follow", source: "other", source_url: "https://other.test" };
    const fixture = fixtureDb({
      user_series_seeds: [{ user_id: "user-b", series_id: "series-other", series: otherSeries }],
      mix_series: [series, otherSeries],
      episodes: [
        { id: "episode-default", series_id: "series-1", title: "Default", source: "soulection", release_date: "2026-09-01", aired_date: null, artwork_url: null, url: "https://soulection.com/default" },
        { id: "episode-private", series_id: "series-other", title: "Private", source: "other", release_date: "2026-09-10", aired_date: null, artwork_url: null, url: "https://other.test/private" },
      ],
      episode_track_entries: [
        entry("episode-default", 0, "shared-track"),
        entry("episode-private", 0, "private-track"),
      ],
      user_tracks: [{ user_id: "user-b", track_id: "shared-track", status: "rejected" }],
    });

    const rows = await loadSeriesExploration(fixture.db, "user-a", new Set());

    expect(rows.map((row) => row.id)).toEqual(["shared-track"]);
    expect(rows.some((row) => row.id === "private-track")).toBe(false);
    expect(fixture.calls.find((call) => call.table === "user_series_seeds")?.filters)
      .toContainEqual(["eq", "user_id", "user-a"]);
    expect(fixture.calls.find((call) => call.table === "user_tracks")?.filters)
      .toContainEqual(["eq", "user_id", "user-a"]);
  });

  test("round robins candidates so both selected episodes are represented", async () => {
    const fixture = fixtureDb({
      user_series_seeds: [{ user_id: "user-a", series_id: "series-1" }],
      mix_series: [series],
      episodes: [
        { id: "episode-a", series_id: "series-1", title: "A", source: "soulection", release_date: "2026-09-02", aired_date: null, artwork_url: null, url: "https://soulection.com/a" },
        { id: "episode-b", series_id: "series-1", title: "B", source: "soulection", release_date: "2026-09-01", aired_date: null, artwork_url: null, url: "https://soulection.com/b" },
      ],
      episode_track_entries: [
        entry("episode-a", 0, "a-1"),
        entry("episode-a", 1, "a-2"),
        entry("episode-a", 2, "a-3"),
        entry("episode-b", 0, "b-1"),
        entry("episode-b", 1, "b-2"),
      ],
      user_tracks: [],
    });

    const rows = await loadSeriesExploration(fixture.db, "user-a", new Set());

    expect(rows.map((row) => row.id)).toEqual(["a-1", "b-1", "a-2"]);
    expect(new Set(rows.map((row) => row.episode_id))).toEqual(new Set(["episode-a", "episode-b"]));
  });
});

describe("injectSeriesExploration", () => {
  test("protects the first five ordinary tracks and spaces exploration deterministically", () => {
    const ordinary = Array.from({ length: 15 }, (_, index) => ({ id: `ordinary-${index + 1}` }));
    const exploration = [1, 2, 3].map((id) => ({ id: `explore-${id}`, _series_exploration: true }));

    const result = injectSeriesExploration(ordinary, exploration);

    expect(result.slice(0, 5).map((row) => row.id)).toEqual([
      "ordinary-1", "ordinary-2", "ordinary-3", "ordinary-4", "ordinary-5",
    ]);
    expect(result.map((row) => row.id)).toEqual([
      "ordinary-1", "ordinary-2", "ordinary-3", "ordinary-4", "ordinary-5",
      "explore-1",
      "ordinary-6", "ordinary-7", "ordinary-8", "ordinary-9", "ordinary-10",
      "explore-2",
      "ordinary-11", "ordinary-12", "ordinary-13", "ordinary-14", "ordinary-15",
      "explore-3",
    ]);
  });

  test("deduplicates and never injects more than three tracks", () => {
    const result = injectSeriesExploration(
      [{ id: "ordinary" }],
      [{ id: "ordinary" }, { id: "a" }, { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    );
    expect(result.map((row) => row.id)).toEqual(["ordinary", "a", "b", "c"]);
  });
});

describe("unfiltered FYP integration", () => {
  test("injects exploration only on the first unfiltered page", () => {
    expect(fypRoute).toContain("if (offset === 0 && !seedId && !genre && !seedArtist)");
  });
});
