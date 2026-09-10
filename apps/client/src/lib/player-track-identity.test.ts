import { describe, expect, test } from "bun:test";
import type { PlayerTrack } from "@/components/GlobalPlayerProvider";
import {
  canonicalPlayerTrackId,
  displayedPlayerTrackId,
  playerTrackActionId,
  playerTrackMatchesCanonicalId,
  trackCardActionTargets,
} from "./player-track-identity";

const track = (values: Partial<PlayerTrack> & Pick<PlayerTrack, "id">): PlayerTrack => ({
  artist: "Artist", title: "Title", coverArtUrl: null, spotifyUrl: null, audioUrl: null, ...values,
});

describe("player track identity", () => {
  test("uses ordinary FYP ids for actions and completed-listen evidence", () => {
    expect(canonicalPlayerTrackId(track({ id: "fyp-track" }))).toBe("fyp-track");
  });

  test("uses canonical ids while preserving episode appearance queue ids", () => {
    const appearance = track({ id: "appearance-1", appearanceId: "appearance-1", catalogTrackId: "canonical-1" });
    expect(appearance.id).toBe("appearance-1");
    expect(displayedPlayerTrackId(appearance)).toBe("canonical-1");
    expect(playerTrackActionId("appearance-1", appearance, [appearance])).toBe("canonical-1");
    expect(playerTrackMatchesCanonicalId(appearance, "canonical-1")).toBe(true);
    expect(playerTrackMatchesCanonicalId(appearance, "appearance-1")).toBe(false);
    expect(trackCardActionTargets(canonicalPlayerTrackId(appearance))).toEqual({
      trackId: "canonical-1",
      trackPatchUrl: "/api/tracks/canonical-1",
      engagementUrl: "/api/user-tracks/canonical-1/engagement",
    });
  });

  test("does not submit unresolved episode appearances", () => {
    const appearance = track({ id: "appearance-unresolved", appearanceId: "appearance-unresolved", catalogTrackId: null });
    expect(canonicalPlayerTrackId(appearance)).toBeNull();
    expect(playerTrackActionId(appearance.id, appearance, [appearance])).toBeNull();
    expect(playerTrackMatchesCanonicalId(appearance, null)).toBe(false);
    expect(trackCardActionTargets(canonicalPlayerTrackId(appearance))).toBeNull();
  });
});
