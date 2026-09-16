import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectNonFypPrewarmTargets } from "./non-fyp-prewarm";

const candidate = (id: string, extras: Record<string, unknown> = {}) => ({
  id,
  storage_path: null,
  youtube_url: `https://youtube.test/${id}`,
  dl_attempts: 0,
  metadata: {},
  ...extras,
});

describe("non-FYP stack prewarming", () => {
  test("selects and deduplicates one front track across genre and artist stacks", () => {
    const result = selectNonFypPrewarmTargets([
      candidate("shared", { metadata: { genres: ["Ambient", "Drone"], seed_artist: "Visible Cloaks" } }),
      candidate("later", { metadata: { genres: ["Ambient"] } }),
    ], [], [], []);

    expect(result.feeds).toEqual([
      { feedKey: "genre:ambient", trackId: "shared" },
      { feedKey: "genre:drone", trackId: "shared" },
      { feedKey: "seed-artist:visible cloaks", trackId: "shared" },
    ]);
    expect(result.requestCandidates.map((track) => track.id)).toEqual(["shared"]);
  });

  test("uses co-occurring episode membership for direct seed stacks", () => {
    const result = selectNonFypPrewarmTargets([
      candidate("collaboration", { artist: "Ludwig Göransson, Busiswa" }),
      candidate("seed-front", { artist: "Ludwig Göransson" }),
    ], [
      { id: "seed-a", track_id: "seed-source", artist: "Ludwig Göransson" },
    ], [
      { seed_id: "seed-a", episode_id: "episode-a" },
    ], [
      { episode_id: "episode-a", track_id: "collaboration" },
      { episode_id: "episode-a", track_id: "seed-front" },
    ]);

    expect(result.feeds).toEqual([{ feedKey: "seed:seed-a", trackId: "collaboration" }]);
    expect(result.requestCandidates.map((track) => track.id)).toEqual(["collaboration"]);
  });

  test("reserves an already ready front track without requesting it again", () => {
    const result = selectNonFypPrewarmTargets([
      candidate("ready", {
        storage_path: "tracks/ready.mp3",
        metadata: { genres: ["House"] },
      }),
      candidate("later", { metadata: { genres: ["House"] } }),
    ], [], [], []);

    expect(result.feeds).toEqual([{ feedKey: "genre:house", trackId: "ready" }]);
    expect(result.requestCandidates).toEqual([]);
  });

  test("skips failed or source-less tracks when choosing a stack front", () => {
    const result = selectNonFypPrewarmTargets([
      candidate("failed", { dl_attempts: 3, metadata: { genres: ["Jazz"] } }),
      candidate("missing-source", {
        youtube_url: null,
        spotify_url: null,
        source_url: null,
        metadata: { genres: ["Jazz"] },
      }),
      candidate("usable", { metadata: { genres: ["Jazz"] } }),
    ], [], [], []);

    expect(result.feeds).toEqual([{ feedKey: "genre:jazz", trackId: "usable" }]);
    expect(result.requestCandidates.map((track) => track.id)).toEqual(["usable"]);
  });

  test("protects only unexpired reservations from audio eviction", () => {
    const migration = readFileSync(
      resolve(import.meta.dir, "../../client/supabase/migrations/046_non_fyp_stack_prewarm.sql"),
      "utf8",
    );
    expect(migration).toContain("from non_fyp_stack_prewarm warm");
    expect(migration).toContain("where warm.expires_at > now()");
    const cleanup = readFileSync(resolve(import.meta.dir, "../scripts/cleanup-audio-cache.ts"), "utf8");
    expect(cleanup).toContain('fetchAll("non_fyp_stack_prewarm", "track_id,expires_at")');
    expect(cleanup).toContain('withRetry("current stack prewarm check"');
  });

  test("runs daily with a reservation TTL longer than the refresh cadence", () => {
    const watcher = readFileSync(resolve(import.meta.dir, "../scripts/watcher.ts"), "utf8");
    expect(watcher).toContain("const NON_FYP_PREWARM_INTERVAL_MS = 24 * 60 * 60 * 1000");
    expect(watcher).toContain("nonFypPrewarmLoop.start()");
    expect(watcher).toContain("nonFypPrewarmLoop.stop()");
    const queue = readFileSync(resolve(import.meta.dir, "predictive-queue.ts"), "utf8");
    expect(queue).toContain('.range(from, from + pageSize - 1)');
  });
});
