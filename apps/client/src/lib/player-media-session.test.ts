import { describe, expect, test } from "bun:test";
import {
  mediaSessionPositionState,
  mediaSessionSeekTarget,
  repeatIdForLoadedTrack,
  spotifyPlayCommand,
  toggleRepeatIdForCurrentTrack,
} from "./player-media-session";

describe("media session action mapping", () => {
  test("resumes a paused Spotify track instead of restarting it", () => {
    expect(spotifyPlayCommand(false)).toBe("start");
    expect(spotifyPlayCommand(true)).toBe("resume");
  });

  test("seeks backward and forward by 30 seconds by default", () => {
    expect(mediaSessionSeekTarget("seekbackward", 50, 120)).toBe(20);
    expect(mediaSessionSeekTarget("seekforward", 50, 120)).toBe(80);
  });

  test("uses supplied offsets and clamps every action to the track", () => {
    expect(mediaSessionSeekTarget("seekbackward", 5, 120, { seekOffset: 10 })).toBe(0);
    expect(mediaSessionSeekTarget("seekforward", 115, 120, { seekOffset: 10 })).toBe(120);
    expect(mediaSessionSeekTarget("seekto", 20, 120, { seekTime: 200 })).toBe(120);
    expect(mediaSessionSeekTarget("seekto", 20, 120, { seekTime: -1 })).toBe(0);
  });

  test("rejects seeks until duration and seek-to position are valid", () => {
    expect(mediaSessionSeekTarget("seekforward", 0, 0)).toBeNull();
    expect(mediaSessionSeekTarget("seekto", 20, 120)).toBeNull();
  });

  test("builds only valid position state payloads", () => {
    expect(mediaSessionPositionState(150, 120)).toEqual({ duration: 120, playbackRate: 1, position: 120 });
    expect(mediaSessionPositionState(10, Number.NaN)).toBeNull();
  });
});

describe("repeat identity", () => {
  test("preserves repeat only while the same canonical track is loaded", () => {
    expect(repeatIdForLoadedTrack("canonical-1", "canonical-1")).toBe("canonical-1");
    expect(repeatIdForLoadedTrack("canonical-1", "canonical-2")).toBeNull();
    expect(repeatIdForLoadedTrack("canonical-1", null)).toBeNull();
  });

  test("toggles only the loaded canonical track without accepting stale actions", () => {
    expect(toggleRepeatIdForCurrentTrack("canonical-1", "canonical-1", null)).toEqual({
      accepted: true,
      repeatTrackId: "canonical-1",
    });
    expect(toggleRepeatIdForCurrentTrack("canonical-1", "canonical-1", "canonical-1")).toEqual({
      accepted: true,
      repeatTrackId: null,
    });
    expect(toggleRepeatIdForCurrentTrack("canonical-2", "canonical-1", "canonical-1")).toEqual({
      accepted: false,
      repeatTrackId: "canonical-1",
    });
  });
});
