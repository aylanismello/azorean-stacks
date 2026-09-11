import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createQueueMutationSerializer,
  isPriorityManagedSeed,
  latestStatelessUserSeeds,
  needsSeedFypRefresh,
  recoverSeedFypRefreshes,
  refreshSeedOwnerQueue,
} from "./seed-refresh";

describe("createQueueMutationSerializer", () => {
  test("runs overlapping queue mutations strictly in submission order", async () => {
    const serialize = createQueueMutationSerializer();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = serialize(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = serialize(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});

describe("refreshSeedOwnerQueue", () => {
  test("refreshes only the seed owner", async () => {
    const refreshed: string[] = [];
    const result = await refreshSeedOwnerQueue("owner-user", async (userId) => {
      refreshed.push(userId);
    });

    expect(result).toBe(true);
    expect(refreshed).toEqual(["owner-user"]);
  });

  test("skips shared seeds without a user", async () => {
    let called = false;
    const result = await refreshSeedOwnerQueue(null, async () => {
      called = true;
    });

    expect(result).toBe(false);
    expect(called).toBe(false);
  });

  test("fails open when queue refresh fails", async () => {
    const errors: unknown[] = [];
    const result = await refreshSeedOwnerQueue(
      "owner-user",
      async () => { throw new Error("refresh failed"); },
      (error) => errors.push(error),
    );

    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe("durable fresh-seed FYP refresh", () => {
  const pending = {
    id: "seed-a",
    user_id: "user-a",
    pipeline_status: { state: "done" },
    fyp_refresh_required_at: "2026-09-11T20:00:00Z",
  };

  test("routes only stateful user-owned seeds through the priority pipeline", () => {
    expect(isPriorityManagedSeed({ user_id: "user-a", pipeline_status: { state: "queued" } })).toBe(true);
    expect(isPriorityManagedSeed({ user_id: "user-a", pipeline_status: { state: "discovering" } })).toBe(true);
    expect(isPriorityManagedSeed({ user_id: "user-a", pipeline_status: null })).toBe(false);
    expect(isPriorityManagedSeed({ user_id: "user-a", pipeline_status: {} })).toBe(false);
    expect(isPriorityManagedSeed({ user_id: null, pipeline_status: { state: "queued" } })).toBe(false);
  });

  test("recovers only the latest stateless seed per user", () => {
    const seeds = [
      { id: "old-a", user_id: "user-a", pipeline_status: null },
      { id: "shared", user_id: null, pipeline_status: null },
      { id: "new-a", user_id: "user-a", pipeline_status: {} },
      { id: "managed-b", user_id: "user-b", pipeline_status: { state: "done" } },
      { id: "legacy-b", user_id: "user-b", pipeline_status: null },
    ];
    expect(latestStatelessUserSeeds(seeds).map((seed) => seed.id)).toEqual(["new-a", "legacy-b"]);
  });

  test("recovers only completed user-owned seeds missing a checkpoint", () => {
    expect(needsSeedFypRefresh(pending)).toBe(true);
    expect(needsSeedFypRefresh({ ...pending, user_id: null })).toBe(false);
    expect(needsSeedFypRefresh({ ...pending, pipeline_status: { state: "discovering" } })).toBe(false);
    expect(needsSeedFypRefresh({ ...pending, fyp_refresh_required_at: null })).toBe(false);
    expect(needsSeedFypRefresh({ ...pending, fyp_refreshed_at: "2026-09-11T20:01:00Z" })).toBe(false);
  });

  test("database and every user seed route persist the recovery marker", () => {
    const migration = readFileSync(
      new URL("../../client/supabase/migrations/030_seed_fyp_refresh_recovery.sql", import.meta.url),
      "utf8",
    ).toLowerCase();
    const routes = [
      "../../client/src/app/api/seeds/route.ts",
      "../../client/src/app/api/seeds/playlist/route.ts",
      "../../client/src/app/api/seeds/toggle/route.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    const claimMigration = readFileSync(
      new URL("../../client/supabase/migrations/031_claim_seed_fyp_refresh.sql", import.meta.url),
      "utf8",
    ).toLowerCase();
    const generationFenceMigration = readFileSync(
      new URL("../../client/supabase/migrations/032_fence_seed_fyp_refresh_generation.sql", import.meta.url),
      "utf8",
    ).toLowerCase();
    const watcher = readFileSync(new URL("../scripts/watcher.ts", import.meta.url), "utf8");

    expect(migration).toContain("before insert or update of active, user_id on public.seeds");
    expect(migration).toContain("add column if not exists fyp_refresh_required_at timestamptz");
    expect(migration).toContain("add column if not exists fyp_refreshed_at timestamptz");
    expect(migration).toContain("fyp_refresh_required_at");
    expect(migration).toContain("status := jsonb_set(status, '{state}', to_jsonb('queued'::text), true)");
    expect(claimMigration).toContain("pg_advisory_xact_lock");
    expect(claimMigration).toContain("fyp_refresh_claimed_at");
    expect(claimMigration).toContain("grant execute on function public.claim_seed_fyp_refresh(uuid, timestamptz) to service_role");
    expect(claimMigration).toContain("row_number() over (partition by user_id order by created_at desc, id desc)");
    expect(generationFenceMigration).toContain("old.user_id is distinct from new.user_id");
    expect(generationFenceMigration).toContain("new.fyp_refresh_required_at := clock_timestamp()");
    expect(generationFenceMigration).toContain("status := jsonb_set(status, '{state}', to_jsonb('queued'::text), true)");
    expect(watcher).toContain('.eq("user_id", seed.user_id)');
    expect(watcher).toContain('.eq("active", true)');
    expect(watcher).toContain("if (!isPriorityManagedSeed(seed))");
    expect(watcher).toContain("await queueLegacyUserSeedForPriority");
    expect(watcher).toContain('.filter("pipeline_status->>state", "is", null)');
    expect(watcher).toContain("!isPriorityManagedSeed(seed)");
    expect(watcher).toContain("if (isPriorityManagedSeed(payload.new || {}))");
    expect(watcher).toContain('.not("user_id", "is", null)');
    expect(watcher).toContain(".range(from, from + PAGE - 1)");
    expect(watcher).toContain("type SeedPipelineFence");
    expect(watcher).toContain('.eq("fyp_refresh_required_at", fence.fyp_refresh_required_at)');
    expect(watcher).toContain("fence.fyp_refresh_required_at");
    for (const route of routes) expect(route).toContain("fyp_refresh_required_at");
  });

  test("checkpoints only after refresh succeeds and retries failures later", async () => {
    const events: string[] = [];
    const failures: string[] = [];
    const failed = { ...pending, id: "seed-b", user_id: "user-b" };
    const checkpointFailed = { ...pending, id: "seed-c", user_id: "user-c" };
    const alreadyClaimed = { ...pending, id: "seed-d", user_id: "user-d" };
    const result = await recoverSeedFypRefreshes(
      [pending, failed, checkpointFailed, alreadyClaimed],
      async (seed) => {
        events.push(`claim:${seed.id}`);
        return seed.id === "seed-d" ? null : `claim-${seed.id}`;
      },
      async (userId) => {
        events.push(`refresh:${userId}`);
        if (userId === "user-b") throw new Error("temporary refresh failure");
      },
      async (seed, claimToken) => {
        events.push(`checkpoint:${seed.id}:${claimToken}`);
        if (seed.id === "seed-c") throw new Error("temporary checkpoint failure");
      },
      async (seed, claimToken) => { events.push(`release:${seed.id}:${claimToken}`); },
      (seed) => failures.push(seed.id),
    );

    expect(result).toEqual({ pending: 4, claimed: 3, recovered: 1 });
    expect(events).toEqual([
      "claim:seed-a",
      "refresh:user-a",
      "checkpoint:seed-a:claim-seed-a",
      "claim:seed-b",
      "refresh:user-b",
      "release:seed-b:claim-seed-b",
      "claim:seed-c",
      "refresh:user-c",
      "checkpoint:seed-c:claim-seed-c",
      "release:seed-c:claim-seed-c",
      "claim:seed-d",
    ]);
    expect(failures).toEqual(["seed-b", "seed-c"]);
  });
});