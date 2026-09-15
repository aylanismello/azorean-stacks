import { describe, expect, mock, test } from "bun:test";
import {
  filteredFeedWarmCandidates,
  genreFeedCounts,
  loadFypPreparationTrackIds,
  queueFilteredFeedPreparation,
  seedFeedCount,
} from "./filtered-feed-preparation";

const candidates = [
  { id: "ready", storage_path: "audio/ready.mp3", metadata: { genres: ["Ambient"] } },
  { id: "queue", youtube_url: "https://youtube.com/watch?v=queue", metadata: { genres: ["Ambient", "Drone"] } },
  { id: "failed", source_url: "https://example.com/failed", dl_attempts: 3, metadata: { genres: ["Drone"] } },
];

describe("filtered feed preparation", () => {
  test("warms unresolved candidates without requeueing ready or terminal rows", () => {
    expect(filteredFeedWarmCandidates(candidates).map((track) => track.id)).toEqual(["queue"]);
  });

  test("deduplicates active requests and attributes new work to the listener", async () => {
    const inserts: any[] = [];
    const db = {
      from(table: string) {
        if (table !== "download_requests") throw new Error(`unexpected table ${table}`);
        return {
          select() { return this; },
          in() { return this; },
          then(resolve: (value: any) => unknown) {
            return Promise.resolve(resolve({ data: [{ track_id: "already-active" }], error: null }));
          },
          insert: mock(async (row: any) => { inserts.push(row); return { error: null }; }),
        };
      },
    };
    const queued = await queueFilteredFeedPreparation(db, "user-a", [
      ...candidates,
      { id: "already-active", youtube_url: "https://youtube.com/watch?v=active" },
    ]);
    expect(queued).toBe(1);
    expect(inserts).toEqual([{
      track_id: "queue",
      user_id: "user-a",
      youtube_url: "https://youtube.com/watch?v=queue",
      status: "pending",
    }]);
  });

  test("reads only the listener's active warm 4U preparation rows", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const query = {
      select(value: string) { calls.push(["select", value]); return this; },
      eq(column: string, value: unknown) { calls.push(["eq", column, value]); return this; },
      in(column: string, value: unknown[]) { calls.push(["in", column, value]); return this; },
      lte(column: string, value: unknown) { calls.push(["lte", column, value]); return this; },
      gt(column: string, value: unknown) { calls.push(["gt", column, value]); return this; },
      order(column: string, value: unknown) {
        calls.push(["order", column, value]);
        return Promise.resolve({
          data: [{ track_id: "a" }, { track_id: "a" }, { track_id: "b" }],
          error: null,
        });
      },
    };
    const db = {
      from(table: string) {
        calls.push(["from", table]);
        return query;
      },
    };

    expect(await loadFypPreparationTrackIds(db, "user-a")).toEqual(["a", "b"]);
    expect(calls).toContainEqual(["eq", "user_id", "user-a"]);
    expect(calls).toContainEqual(["in", "state", ["ranked", "preparing"]]);
    expect(calls).toContainEqual(["lte", "rank", 20]);
  });
});

describe("filtered feed counts", () => {
  test("genre counts use the same eligible candidates and distinguish ready audio", () => {
    expect(genreFeedCounts(candidates).get("Ambient")).toEqual({ eligible: 2, ready: 1 });
    expect(genreFeedCounts(candidates).get("Drone")).toEqual({ eligible: 2, ready: 0 });
  });

  test("seed counts deduplicate appearances and include its direct track", () => {
    expect(seedFeedCount(candidates, ["episode-a"], [
      { episode_id: "episode-a", track_id: "ready" },
      { episode_id: "episode-a", track_id: "ready" },
      { episode_id: "episode-a", track_id: "queue" },
      { episode_id: "episode-b", track_id: "failed" },
    ], "failed")).toEqual({ eligible: 3, ready: 1 });
  });
});