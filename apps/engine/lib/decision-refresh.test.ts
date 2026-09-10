import { describe, expect, test } from "bun:test";
import { isExplicitDecision, refreshDecisionQueue } from "./decision-refresh";

describe("decision refresh", () => {
  test("recognizes only explicit taste decisions", () => {
    for (const status of ["approved", "rejected", "skipped", "listened"]) {
      expect(isExplicitDecision(status)).toBe(true);
    }
    for (const status of ["pending", "bad_source", null]) {
      expect(isExplicitDecision(status)).toBe(false);
    }
  });

  test("refreshes personalized scores before materializing the user's queue", async () => {
    const events: string[] = [];
    await refreshDecisionQueue("user-a", {
      async refreshPersonalizedScores(userId) { events.push(`scores:${userId}`); },
      async materializeUserQueue(userId) { events.push(`queue:${userId}`); },
    });
    expect(events).toEqual(["scores:user-a", "queue:user-a"]);
  });

  test("does not materialize stale scores when refresh fails", async () => {
    let materialized = false;
    await expect(refreshDecisionQueue("user-a", {
      async refreshPersonalizedScores() { throw new Error("score refresh failed"); },
      async materializeUserQueue() { materialized = true; },
    })).rejects.toThrow("score refresh failed");
    expect(materialized).toBe(false);
  });
});
