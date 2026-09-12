import { describe, expect, test } from "bun:test";
import {
  createRecurringTaskLoop,
  fetchNtsEpisodeArtwork,
  mapConcurrent,
  recoverArtwork,
  resolveTrackArtwork,
  type ArtworkRecoveryCursor,
  type ArtworkRecoveryStore,
  type EpisodeArtworkCandidate,
  type TrackArtworkCandidate,
} from "./artwork-recovery";
import { parseArtworkRecoveryArgs } from "../scripts/backfill-artwork";

function jsonResponse(body: unknown, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

describe("fetchNtsEpisodeArtwork", () => {
  test("uses the NTS API, verifies JSON, and normalizes relative artwork", async () => {
    const requests: Array<{ url: string; accept: string | null; hasSignal: boolean }> = [];
    const artwork = await fetchNtsEpisodeArtwork(
      "https://www.nts.live/shows/test/episodes/test-11th-september-2026?foo=bar",
      {
        fetchImpl: (async (input, init) => {
          requests.push({
            url: String(input),
            accept: new Headers(init?.headers).get("accept"),
            hasSignal: Boolean(init?.signal),
          });
          return jsonResponse({ media: { picture_large: "/images/show.jpg" } });
        }),
      },
    );

    expect(artwork).toBe("https://www.nts.live/images/show.jpg");
    expect(requests).toEqual([{
      url: "https://www.nts.live/api/v2/shows/test/episodes/test-11th-september-2026?foo=bar",
      accept: "application/json",
      hasSignal: true,
    }]);
  });

  test("rejects non-NTS URLs and non-JSON responses", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("<html>not json</html>", { headers: { "content-type": "text/html" } });
    });

    expect(await fetchNtsEpisodeArtwork("https://example.com/shows/a/episodes/b", { fetchImpl })).toBeNull();
    expect(await fetchNtsEpisodeArtwork("https://www.nts.live/shows/a/episodes/b", { fetchImpl })).toBeNull();
    expect(calls).toBe(1);
  });

  test("retries transient HTTP and network failures with bounded attempts", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const artwork = await fetchNtsEpisodeArtwork("https://www.nts.live/shows/a/episodes/b", {
      retries: 2,
      retryDelayMs: 10,
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) return jsonResponse({}, 503);
        if (calls === 2) throw new Error("temporary network failure");
        return jsonResponse({ media: { background_large: "https://images.example/art.jpg" } });
      }),
    });

    expect(artwork).toBe("https://images.example/art.jpg");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });
});

describe("mapConcurrent", () => {
  test("never exceeds the configured concurrency", async () => {
    let active = 0;
    let peak = 0;
    await mapConcurrent([1, 2, 3, 4, 5], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    });
    expect(peak).toBe(2);
  });
});

describe("createRecurringTaskLoop", () => {
  test("starts once and schedules the next run only after the current run settles", async () => {
    const scheduled: Array<() => void> = [];
    let release!: () => void;
    let runs = 0;
    const loop = createRecurringTaskLoop({
      initialDelayMs: 5,
      intervalMs: 10,
      setTimer: ((callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: () => {},
      task: async () => {
        runs++;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    });

    loop.start();
    loop.start();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(scheduled).toHaveLength(0);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(1);
    loop.stop();
  });
});

describe("resolveTrackArtwork", () => {
  test("prefers direct episode art then uses deterministic junction fallback", () => {
    const result = resolveTrackArtwork(
      [
        { id: "track-direct", episodeId: "episode-z" },
        { id: "track-junction", episodeId: null },
        { id: "track-none", episodeId: null },
      ],
      [
        { track_id: "track-direct", episode_id: "episode-a" },
        { track_id: "track-junction", episode_id: "episode-a" },
        { track_id: "track-junction", episode_id: "episode-z" },
      ],
      [
        { id: "episode-a", artwork_url: "https://img/a.jpg" },
        { id: "episode-z", artwork_url: "https://img/z.jpg" },
      ],
    );
    expect(Object.fromEntries(result)).toEqual({
      "track-direct": "https://img/z.jpg",
      "track-junction": "https://img/a.jpg",
    });
  });
});

class MemoryStore implements ArtworkRecoveryStore {
  episodeCursors: Array<string | null> = [];
  trackCursors: Array<string | null> = [];
  episodeWrites: string[] = [];
  trackWrites: string[] = [];
  existingTrackArt = new Set(["track-known"]);
  episodes: EpisodeArtworkCandidate[] = [
    { id: "episode-a", url: "https://www.nts.live/shows/a/episodes/a" },
    { id: "episode-b", url: "https://www.nts.live/shows/b/episodes/b" },
    { id: "episode-c", url: "https://www.nts.live/shows/c/episodes/c" },
  ];
  tracks: TrackArtworkCandidate[] = [
    { id: "track-a", episodeId: "episode-a" },
    { id: "track-b", episodeId: null },
    { id: "track-c", episodeId: null },
    { id: "track-known", episodeId: "episode-a" },
  ];

  async listMissingNtsEpisodes(afterId: string | null, limit: number) {
    this.episodeCursors.push(afterId);
    return this.episodes.filter((row) => (!afterId || row.id > afterId) && !this.episodeWrites.includes(row.id)).slice(0, limit);
  }
  async setEpisodeArtworkIfMissing(id: string) {
    if (this.episodeWrites.includes(id)) return false;
    this.episodeWrites.push(id);
    return true;
  }
  async listMissingTrackArtwork(afterId: string | null, limit: number) {
    this.trackCursors.push(afterId);
    return this.tracks.filter((row) => (!afterId || row.id > afterId) && !this.existingTrackArt.has(row.id)).slice(0, limit);
  }
  async getEpisodeArtworkForTracks(tracks: TrackArtworkCandidate[]) {
    return new Map(tracks.filter((track) => track.id !== "track-c").map((track) => [track.id, `https://img/${track.id}.jpg`]));
  }
  async setTrackArtworkIfMissing(id: string) {
    if (this.existingTrackArt.has(id)) return false;
    this.existingTrackArt.add(id);
    this.trackWrites.push(id);
    return true;
  }
}

describe("recoverArtwork", () => {
  test("keyset-paginates recovery, updates only missing rows, and reports metrics", async () => {
    const store = new MemoryStore();
    const metrics = await recoverArtwork({
      store,
      pageSize: 2,
      concurrency: 2,
      retries: 0,
      fetchImpl: async () => jsonResponse({ media: { picture_large: "https://img/episode.jpg" } }),
    });

    expect(store.episodeCursors).toEqual([null, "episode-b"]);
    expect(store.trackCursors).toEqual([null, "track-b"]);
    expect(store.episodeWrites.sort()).toEqual(["episode-a", "episode-b", "episode-c"]);
    expect(store.trackWrites.sort()).toEqual(["track-a", "track-b"]);
    expect(store.trackWrites).not.toContain("track-known");
    expect(metrics).toEqual({
      episodePages: 2,
      episodesScanned: 3,
      episodeArtworkFound: 3,
      episodesUpdated: 3,
      episodeUpdateRaces: 0,
      episodeFetchFailed: 0,
      trackPages: 2,
      tracksScanned: 3,
      trackFallbackFound: 2,
      tracksUpdated: 2,
      trackUpdateRaces: 0,
      tracksWithoutFallback: 1,
      writesSkipped: 0,
    });
  });

  test("bounds recurring pages and resumes from keyset cursors", async () => {
    const store = new MemoryStore();
    const cursor: ArtworkRecoveryCursor = { episodeAfterId: null, trackAfterId: null };
    const first = await recoverArtwork({
      store,
      cursor,
      pageSize: 1,
      maxPagesPerKind: 1,
      retries: 0,
      fetchImpl: async () => jsonResponse({ media: { picture_large: "https://img/episode.jpg" } }),
    });

    expect(first.episodesScanned).toBe(1);
    expect(first.tracksScanned).toBe(1);
    expect(cursor).toEqual({ episodeAfterId: "episode-a", trackAfterId: "track-a" });

    await recoverArtwork({
      store,
      cursor,
      pageSize: 1,
      maxPagesPerKind: 1,
      retries: 0,
      fetchImpl: async () => jsonResponse({ media: { picture_large: "https://img/episode.jpg" } }),
    });
    expect(store.episodeCursors).toEqual([null, "episode-a"]);
    expect(store.trackCursors).toEqual([null, "track-a"]);
  });

  test("dry-run discovers all changes without writing", async () => {
    const store = new MemoryStore();
    const metrics = await recoverArtwork({
      store,
      dryRun: true,
      pageSize: 10,
      retries: 0,
      fetchImpl: async () => jsonResponse({ media: { picture_large: "https://img/episode.jpg" } }),
    });

    expect(store.episodeWrites).toEqual([]);
    expect(store.trackWrites).toEqual([]);
    expect(metrics.episodesUpdated).toBe(0);
    expect(metrics.tracksUpdated).toBe(0);
    expect(metrics.writesSkipped).toBe(5);
  });
});

describe("artwork recovery CLI", () => {
  test("parses bounded recovery controls", () => {
    expect(parseArtworkRecoveryArgs([
      "--dry-run", "--page-size", "25", "--concurrency", "3",
      "--timeout-ms", "5000", "--retries", "0",
    ])).toEqual({
      dryRun: true,
      pageSize: 25,
      concurrency: 3,
      timeoutMs: 5000,
      retries: 0,
    });
    expect(() => parseArtworkRecoveryArgs(["--concurrency", "0"])).toThrow("positive integer");
    expect(() => parseArtworkRecoveryArgs(["--unknown"])).toThrow("Unknown option");
  });
});
