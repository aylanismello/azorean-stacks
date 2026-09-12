import { describe, expect, test } from "bun:test";
import {
  beginDiscoveryMutation,
  completeDiscoveryMutation,
  correlatedPendingMutation,
  queueTrackChanges,
  remainingPendingMutations,
  shouldShowCompletedMutation,
} from "./discovery-mutation";

const track = (id: string, artist = `artist-${id}`, title = `title-${id}`) => ({ id, artist, title });

describe("discovery mutation events", () => {
  test("describes skips as novelty pressure rather than dislike", () => {
    const event = beginDiscoveryMutation("skip", track("old"), 1, 10);
    expect(event.headline).toBe("Keep digging");
    expect(event.detail).toContain("not treating it as dislike");
    expect(event.outgoing?.id).toBe("old");
  });

  test("calculates exact additions and removals while protecting playback", () => {
    expect(queueTrackChanges(
      [track("playing"), track("old"), track("kept")],
      [track("kept"), track("new")],
      "playing",
    )).toEqual({
      outgoing: [track("old")],
      incoming: [track("new")],
      queueChanges: [
        { position: 2, outgoing: track("old"), incoming: track("new"), moved: null, fromPosition: null },
      ],
    });
  });

  test("upgrades an interaction with the exact outgoing-to-incoming swap", () => {
    const pending = beginDiscoveryMutation("like", track("source", "Loved Artist", "Loved Song"), 1, 10);
    const event = completeDiscoveryMutation(
      pending,
      [track("old", "Old Artist", "Old Song")],
      [track("new", "New Artist", "New Song")],
      2,
      { createdAt: 20 },
    );
    expect(event?.headline).toBe("Leaning this way");
    expect(event?.detail).toBe("Old Artist — Old Song out · New Artist — New Song in");
    expect(event?.incomingIds).toEqual(["new"]);
    expect(event?.queueChanges).toEqual([
      {
        position: 1,
        outgoing: track("old", "Old Artist", "Old Song"),
        incoming: track("new", "New Artist", "New Song"),
        moved: null,
        fromPosition: null,
      },
    ]);
  });

  test("keeps independent removals and additions position-aware", () => {
    const event = completeDiscoveryMutation(
      null,
      [track("out"), track("kept")],
      [track("kept"), track("in")],
      3,
    );

    expect(event?.queueChanges).toEqual([
      { position: 1, outgoing: track("out"), incoming: null, moved: null, fromPosition: null },
      { position: 2, outgoing: null, incoming: track("in"), moved: null, fromPosition: null },
    ]);
    expect(event?.detail).toBe("artist-out — title-out left the upcoming queue.");
  });

  test("does not complete or consume an action when membership did not change", () => {
    const pending = beginDiscoveryMutation("like", track("source"), 1, 10);
    expect(completeDiscoveryMutation(
      pending,
      [track("same")],
      [track("same")],
      2,
    )).toBeNull();
  });

  test("reports pure queue moves with their exact old and new positions", () => {
    const event = completeDiscoveryMutation(
      null,
      [track("a"), track("b")],
      [track("b"), track("a")],
      4,
    );
    expect(event?.headline).toBe("The dig reordered");
    expect(event?.queueChanges).toEqual([
      { position: 1, outgoing: null, incoming: null, moved: track("b"), fromPosition: 2 },
      { position: 2, outgoing: null, incoming: null, moved: track("a"), fromPosition: 1 },
    ]);
    expect(event?.detail).toBe("artist-b — title-b moved #2 → #1.");
  });

  test("attributes only an exact seed generation, never a generic ranking refresh", () => {
    const liked = beginDiscoveryMutation("like", track("liked"), 1, 10);
    const seeded = beginDiscoveryMutation("seed", track("seeded"), 2, 20, "seed-row");
    expect(correlatedPendingMutation(
      [liked],
      { reason: "ranking_refresh", seed_id: null },
    )).toBeNull();
    expect(correlatedPendingMutation(
      [seeded],
      { reason: "seed_refresh", seed_id: "other" },
    )).toBeNull();
    expect(correlatedPendingMutation(
      [seeded],
      { reason: "seed_refresh", seed_id: "seed-row" },
    )).toEqual(seeded);
    expect(correlatedPendingMutation(
      [liked, seeded],
      { reason: "seed_refresh", seed_id: "seed-row" },
    )).toEqual(seeded);
    expect(remainingPendingMutations([liked, seeded], null)).toEqual([seeded]);
    expect(remainingPendingMutations([liked, seeded], seeded)).toEqual([]);
  });

  test("does not let a generic readiness refresh overwrite visible action feedback", () => {
    expect(shouldShowCompletedMutation(0, false, "active-action")).toBe(false);
    expect(shouldShowCompletedMutation(1, false, "active-action")).toBe(true);
    expect(shouldShowCompletedMutation(0, true, "active-action")).toBe(true);
    expect(shouldShowCompletedMutation(0, false, null)).toBe(true);
  });

  test("adds durable tangent lineage to a material branch", () => {
    const event = completeDiscoveryMutation(
      null,
      [track("old")],
      [track("new", "Branch Artist", "Branch Track")],
      3,
      { tangentSeedName: "Pocket — Aquarium", createdAt: 30 },
    );
    expect(event?.action).toBe("tangent");
    expect(event?.detail).toContain("Branched from Pocket — Aquarium.");
  });
});
