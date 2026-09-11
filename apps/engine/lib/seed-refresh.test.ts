import { describe, expect, test } from "bun:test";
import { createQueueMutationSerializer, refreshSeedOwnerQueue } from "./seed-refresh";

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