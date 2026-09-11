import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createTrackPlayHandler,
  parsePlayChunkBody,
  type PlayChunkResult,
  type TrackPlayDependencies,
} from "./track-play";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TRACK_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ONE = "33333333-3333-4333-8333-333333333333";
const SESSION_TWO = "44444444-4444-4444-8444-444444444444";

interface Aggregate {
  playCount: number;
  totalMs: number;
  status: string;
}

function createHarness(options: { userId?: string | null; status?: string } = {}) {
  const sessions = new Map<string, { listenedMs: number; qualified: boolean }>();
  const aggregate: Aggregate = {
    playCount: 0,
    totalMs: 0,
    status: options.status ?? "pending",
  };
  const calls: Parameters<TrackPlayDependencies["recordChunk"]>[0][] = [];

  const dependencies: TrackPlayDependencies = {
    async getUserId() {
      return options.userId === undefined ? USER_ID : options.userId;
    },
    async recordChunk(args) {
      calls.push(args);
      const key = `${args.p_user_id}:${args.p_track_id}:${args.p_session_id}`;
      const previous = sessions.get(key) ?? { listenedMs: 0, qualified: false };
      const listenedMs = Math.max(previous.listenedMs, args.p_listened_ms);
      const becameQualified = !previous.qualified && listenedMs >= 30_000;
      const deltaMs = listenedMs - previous.listenedMs;
      sessions.set(key, {
        listenedMs,
        qualified: previous.qualified || becameQualified,
      });
      aggregate.playCount += becameQualified ? 1 : 0;
      aggregate.totalMs += deltaMs;
      const result: PlayChunkResult = {
        session_listened_ms: listenedMs,
        qualified: previous.qualified || becameQualified,
        play_count: aggregate.playCount,
        total_listen_duration_ms: aggregate.totalMs,
        status: aggregate.status,
      };
      return { data: [result], error: null };
    },
  };

  const handler = createTrackPlayHandler(dependencies);
  const send = (sessionId: string, listenedMs: number) => handler(
    new Request("http://player.local/api/user-tracks/play", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, listened_ms: listenedMs }),
    }),
    { params: Promise.resolve({ id: TRACK_ID }) },
  );

  return { aggregate, calls, handler, send };
}

describe("play chunk validation and auth", () => {
  test("accepts only cumulative complete 30-second chunks", () => {
    expect(parsePlayChunkBody({ session_id: SESSION_ONE, listened_ms: 30_000 })).toEqual({
      session_id: SESSION_ONE,
      listened_ms: 30_000,
    });
    expect(parsePlayChunkBody({ session_id: SESSION_ONE, listened_ms: 29_999 })).toBeNull();
    expect(parsePlayChunkBody({ session_id: SESSION_ONE, listened_ms: 30_001 })).toBeNull();
    expect(parsePlayChunkBody({
      session_id: "abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase(),
      listened_ms: 30_000,
    })).toBeNull();
    expect(parsePlayChunkBody({ session_id: "not-a-uuid", listened_ms: 30_000 })).toBeNull();
  });

  test("rejects unauthenticated requests before persistence", async () => {
    const harness = createHarness({ userId: null });
    const response = await harness.send(SESSION_ONE, 30_000);
    expect(response.status).toBe(401);
    expect(harness.calls).toHaveLength(0);
  });

  test("derives the persisted user id from authentication", async () => {
    const harness = createHarness();
    const response = await harness.send(SESSION_ONE, 30_000);
    expect(response.status).toBe(200);
    expect(harness.calls[0]).toEqual({
      p_user_id: USER_ID,
      p_track_id: TRACK_ID,
      p_session_id: SESSION_ONE,
      p_listened_ms: 30_000,
    });
  });
});

describe("per-user play accounting", () => {
  test("counts a session once at 30 seconds and makes retries idempotent", async () => {
    const harness = createHarness();
    const [first, retry] = await Promise.all([
      harness.send(SESSION_ONE, 30_000),
      harness.send(SESSION_ONE, 30_000),
    ]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(harness.aggregate).toEqual({ playCount: 1, totalMs: 30_000, status: "pending" });
  });

  test("adds only newly reported chunks to accumulated listening time", async () => {
    const harness = createHarness();
    await harness.send(SESSION_ONE, 30_000);
    await harness.send(SESSION_ONE, 90_000);
    await harness.send(SESSION_ONE, 60_000); // stale/out-of-order retry
    expect(harness.aggregate).toEqual({ playCount: 1, totalMs: 90_000, status: "pending" });
  });

  test("counts a second playback session as another play", async () => {
    const harness = createHarness();
    await harness.send(SESSION_ONE, 60_000);
    const response = await harness.send(SESSION_TWO, 30_000);
    expect(await response.json()).toMatchObject({
      play_count: 2,
      total_listen_duration_ms: 90_000,
    });
  });

  test("preserves an explicit vote while updating play aggregates", async () => {
    const harness = createHarness({ status: "approved" });
    const response = await harness.send(SESSION_ONE, 30_000);
    expect(await response.json()).toMatchObject({
      status: "approved",
      play_count: 1,
      total_listen_duration_ms: 30_000,
    });
    expect(harness.aggregate.status).toBe("approved");
  });
});

describe("migration 029 isolated concurrency and replay contract", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/029_isolate_playback_totals.sql", import.meta.url),
    "utf8",
  ).toLowerCase();
  const rpc = migration.slice(
    migration.indexOf("create or replace function public.record_user_track_play_chunk"),
  );

  test("serializes each unique session before calculating its delta", () => {
    expect(rpc).toContain("on conflict (user_id, track_id, session_id) do nothing");
    expect(rpc).toContain("for update;");
    expect(rpc).toContain("v_delta_ms := v_new_listened_ms - v_previous_listened_ms");
    expect(rpc).toContain("not v_previous_qualified");
    expect(rpc).toContain("v_new_listened_ms >= 30000");
  });

  test("increments behavioral totals without creating FYP eligibility or assigning vote status", () => {
    const conflictBranch = rpc.slice(
      rpc.indexOf("on conflict (user_id, track_id) do update"),
      rpc.indexOf("return query"),
    );
    expect(conflictBranch).toContain("play_count = public.user_track_play_totals.play_count");
    expect(conflictBranch).toContain("total_listen_duration_ms = public.user_track_play_totals.total_listen_duration_ms");
    expect(conflictBranch).not.toContain("status =");
    expect(rpc).not.toContain("insert into public.user_tracks");
  });

  test("is replay-safe and restricts the invoker RPC to the server role", () => {
    expect(migration).toContain("create table if not exists public.user_track_play_totals");
    expect(migration).toContain("primary key (user_id, track_id)");
    expect(migration).toContain("create or replace function public.record_user_track_play_chunk");
    expect(migration).toContain("security invoker");
    expect(migration).toContain("grant execute on function public.record_user_track_play_chunk(uuid, uuid, uuid, bigint)\n  to service_role");
  });
});

describe("migration 028 server-owned aggregate contract", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/028_guard_play_accounting_aggregates.sql", import.meta.url),
    "utf8",
  ).toLowerCase();

  test("rejects client inserts and updates that mutate play aggregates", () => {
    expect(migration).toContain("before insert or update of play_count, total_listen_duration_ms");
    expect(migration).toContain("current_user not in ('service_role', 'postgres', 'supabase_admin')");
    expect(migration).toContain("tg_op = 'insert'");
    expect(migration).toContain("tg_op = 'update'");
    expect(migration).toContain("using errcode = '42501'");
    expect(migration).toContain("revoke delete on table public.user_tracks from anon, authenticated");
  });
});
