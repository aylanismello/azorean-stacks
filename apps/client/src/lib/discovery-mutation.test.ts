import { describe, expect, test } from "bun:test";
import {
  beginDiscoveryMutation,
  completeDiscoveryMutation,
  queueTrackChanges,
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
