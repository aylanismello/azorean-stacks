import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  describeFypMutation,
  fypGrowthLabel,
  reconcileLiveFypQueue,
  shouldApplyFypGeneration,
} from "./live-fyp";

const fypRoute = readFileSync(new URL("../app/api/fyp/route.ts", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../../supabase/migrations/033_live_fyp_generations.sql", import.meta.url),
  "utf8",
);

describe("live 4U generations", () => {
  test("applies only newer durable generations", () => {
    expect(shouldApplyFypGeneration(4, 5)).toBe(true);
    expect(shouldApplyFypGeneration(5, 5)).toBe(false);
    expect(shouldApplyFypGeneration(6, 5)).toBe(false);
  });

  test("describes inserted and moved branches deterministically", () => {
    expect(describeFypMutation(["a", "b", "c"], ["a", "x", "b"])).toEqual({
      added: 1,
      moved: 0,
      changedIds: ["x"],
    });
    expect(describeFypMutation(["a", "b", "c"], ["b", "a", "c"])).toEqual({
      added: 0,
      moved: 2,
      changedIds: ["b", "a"],
    });
  });

  test("uses growth language without presenting ranking internals", () => {
    expect(fypGrowthLabel({ added: 2, moved: 1, changedIds: [] }, "seed_refresh"))
      .toBe("4U grew 2 new branches");
    expect(fypGrowthLabel({ added: 0, moved: 3, changedIds: [] }, "ranking_refresh"))
      .toBe("4U bent 3 branches");
    expect(fypGrowthLabel({ added: 0, moved: 0, changedIds: [] }, "seed_refresh"))
      .toBe("4U followed the new direction");
  });

  test("preserves a currently playing row retired by a live refresh", () => {
    const previous = [{ id: "a" }, { id: "playing" }, { id: "b" }];
    const authoritative = [{ id: "a" }, { id: "fresh" }, { id: "b" }];
    expect(reconcileLiveFypQueue(previous, authoritative, "playing").map((track) => track.id))
      .toEqual(["a", "playing", "fresh", "b"]);
    expect(reconcileLiveFypQueue(previous, authoritative, "a")).toBe(authoritative);
  });

  test("owner-scopes generation reads and realtime visibility", () => {
    expect(fypRoute).toContain('.from("user_fyp_generations")');
    expect(fypRoute).toContain('.eq("user_id", user.id)');
    expect(migration).toContain("using (auth.uid() = user_id)");
    expect(migration).toContain("grant select on public.user_fyp_generations to authenticated");
    expect(migration).toContain("revoke all on function public.publish_fyp_generation(uuid, text, uuid) from public, anon, authenticated");
    expect(migration).toContain("alter publication supabase_realtime add table public.user_fyp_generations");
  });
});
