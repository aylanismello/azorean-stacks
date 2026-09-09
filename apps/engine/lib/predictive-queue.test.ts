import { describe, expect, test } from "bun:test";
import {
  filterClaimedPreparationTracks,
  orderPreparationTracks,
  warmQueueRowsNeedingPreparation,
  type PreparationTrack,
  type WarmQueueRow,
} from "./predictive-queue";

describe("warmQueueRowsNeedingPreparation", () => {
  test("prepares only non-ready rows inside the upcoming warm window", () => {
    const rows: WarmQueueRow[] = [
      { user_id: "user-a", track_id: "warm-ranked", state: "ranked", rank: 1 },
      { user_id: "user-a", track_id: "warm-ready", state: "ready", rank: 2 },
      { user_id: "user-a", track_id: "cold-ready", state: "ready", rank: 21 },
      { user_id: "user-a", track_id: "cold-ranked", state: "ranked", rank: 22 },
      { user_id: "user-b", track_id: "other-user-warm", state: "preparing", rank: 20 },
    ];

    expect(warmQueueRowsNeedingPreparation(rows, 20).map((row) => row.track_id)).toEqual([
      "warm-ranked",
      "other-user-warm",
    ]);
  });
});

describe("filterClaimedPreparationTracks", () => {
  test("keeps database-claimed tracks in preparation order", () => {
    const tracks = ["first", "second", "third"].map((id, index) => ({
      id,
      preparation_reason: "predictive_queue",
      preparation_rank: index + 1,
      queue_user_ids: ["user-a"],
    })) as PreparationTrack[];

    expect(filterClaimedPreparationTracks(tracks, ["third", "first"]).map((track) => track.id)).toEqual([
      "first",
      "third",
    ]);
  });
});

describe("orderPreparationTracks", () => {
  test("warms the front page before archival audio", () => {
    const track = (id: string, preparation_reason: PreparationTrack["preparation_reason"], preparation_rank = 0) => ({
      id,
      preparation_reason,
      preparation_rank,
      queue_user_ids: ["user-a"],
    }) as PreparationTrack;
    const ordered = orderPreparationTracks([
      track("seed", "active_seed"),
      track("approved", "approved"),
      track("front-page", "predictive_queue", 1),
      track("explicit", "explicit_request"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["explicit", "front-page", "approved", "seed"]);
  });
});
