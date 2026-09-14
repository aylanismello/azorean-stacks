import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  advanceRequestOwnsNavigation,
  explicitDecisionOwnsAdvance,
  implicitSkipTrackId,
  persistImplicitSkip,
} from "./implicit-skip";

const voteRoute = readFileSync(new URL("../app/api/tracks/[id]/route.ts", import.meta.url), "utf8");
const seedRoute = readFileSync(new URL("../app/api/seeds/toggle/route.ts", import.meta.url), "utf8");
const serializedInteractionMigration = readFileSync(
  new URL("../../supabase/migrations/041_serialize_implicit_skip_and_reseed.sql", import.meta.url),
  "utf8",
);
const reseedCorrectionMigration = readFileSync(
  new URL("../../supabase/migrations/042_retract_raced_implicit_skip_on_reseed.sql", import.meta.url),
  "utf8",
);
const timestampAlignmentMigration = readFileSync(
  new URL("../../supabase/migrations/044_fix_implicit_skip_timestamp_alignment.sql", import.meta.url),
  "utf8",
);

const pendingTrack = {
  id: "appearance-1",
  catalogTrackId: "track-1",
  vote_status: "pending",
  status: "pending",
  neutralSkipOnManualAdvance: true,
};

describe("implicit neutral skip on manual next", () => {
  test("recognizes only undecided discovery tracks", () => {
    expect(implicitSkipTrackId(pendingTrack)).toBe("track-1");
    expect(implicitSkipTrackId({ ...pendingTrack, neutralSkipOnManualAdvance: false })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, vote_status: "approved" })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, vote_status: "pending", status: "approved" })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, vote_status: "rejected" })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, vote_status: "skipped" })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, vote_status: "bad_source" })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, super_liked: true })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, is_seed: true })).toBeNull();
    expect(implicitSkipTrackId({ ...pendingTrack, is_re_seed: true })).toBeNull();
  });

  test("does nothing for natural completion", () => {
    expect(implicitSkipTrackId(pendingTrack, "ended")).toBeNull();
  });

  test("an explicit decision in flight or begun during the request owns navigation", () => {
    expect(explicitDecisionOwnsAdvance(1, 2, 2)).toBeTrue();
    expect(explicitDecisionOwnsAdvance(0, 2, 3)).toBeTrue();
    expect(explicitDecisionOwnsAdvance(0, 2, 2)).toBeFalse();
  });

  test("a delayed next request cannot advance from a newly selected track", () => {
    expect(advanceRequestOwnsNavigation(4, 4)).toBeTrue();
    expect(advanceRequestOwnsNavigation(4, 5)).toBeFalse();
  });

  test("persists through the existing neutral skipped outcome", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await persistImplicitSkip(pendingTrack, async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    });

    expect(result).toEqual({ trackId: "track-1", status: "skipped", applied: true });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/tracks/track-1");
    expect(requests[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({
      status: "skipped",
      implicit_skip: true,
    });
  });

  test("preserves a concurrent explicit decision returned by the server", async () => {
    const result = await persistImplicitSkip(pendingTrack, async () => new Response(JSON.stringify({
      status: "approved",
      implicit_skip_applied: false,
    }), { status: 200 }));
    expect(result).toEqual({ trackId: "track-1", status: "approved", applied: false });
  });

  test("the server serializes implicit skips with re-seeds", () => {
    expect(voteRoute).toContain('implicit_skip === true');
    expect(voteRoute).toContain('supabase.rpc("record_implicit_skip"');
    expect(seedRoute).toContain('db.rpc("create_reseed"');
    expect(serializedInteractionMigration).toContain("pg_advisory_xact_lock");
    expect(serializedInteractionMigration).toContain("public.record_implicit_skip");
    expect(serializedInteractionMigration).toContain("public.create_reseed");
    expect(serializedInteractionMigration).toContain("select public.record_ranking_outcome");
    expect(serializedInteractionMigration).toContain("and status = 'skipped'");
    expect(serializedInteractionMigration).toContain("set status = 'pending'");
    expect(reseedCorrectionMigration).toContain("delete from public.ranking_outcomes ro");
    expect(reseedCorrectionMigration).toContain("ro.outcome_at = ut.voted_at");
    expect(reseedCorrectionMigration).toContain("old.outcome = 'skipped'");
    expect(timestampAlignmentMigration).toContain("update public.user_tracks ut");
    expect(timestampAlignmentMigration).toContain("set voted_at = recorded_outcome_at");
    expect(voteRoute).toContain('implicit_skip_applied: implicitResult.applied === true');
  });

  test("does not request a write for decided, replay, or seeded tracks", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return new Response("{}", { status: 200 });
    };

    expect(await persistImplicitSkip({ ...pendingTrack, vote_status: "approved" }, fetcher)).toBeNull();
    expect(await persistImplicitSkip({ ...pendingTrack, neutralSkipOnManualAdvance: false }, fetcher)).toBeNull();
    expect(await persistImplicitSkip({ ...pendingTrack, is_re_seed: true }, fetcher)).toBeNull();
    expect(calls).toBe(0);
  });

  test("fails closed when the neutral decision cannot be saved", async () => {
    await expect(persistImplicitSkip(pendingTrack, async () => (
      new Response("nope", { status: 503 })
    ))).rejects.toThrow("Implicit skip failed (503)");
  });
});
