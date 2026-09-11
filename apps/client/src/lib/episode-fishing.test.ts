import { describe, expect, test } from "bun:test";
import {
  canonicalEntryAvailability,
  episodeFishingPotential,
  trackIsFishable,
} from "./episode-fishing";

const NOW = new Date("2026-09-10T12:00:00Z");

describe("episode fishing potential", () => {
  test("labels a deep, fresh, mostly fishable episode Prime fishing", () => {
    expect(episodeFishingPotential({
      trackCount: 20,
      resolvedCount: 18,
      fishableCount: 15,
      releaseDate: "2026-09-01",
      now: NOW,
    })).toEqual({
      label: "Prime fishing",
      score: 89,
      reason: "15/20 fishable · 18/20 resolved · 9 days old",
    });
  });

  test("uses inclusive 70 and 45 label boundaries", () => {
    expect(episodeFishingPotential({
      trackCount: 20,
      resolvedCount: 10,
      fishableCount: 10,
      releaseDate: "2026-09-10",
      now: NOW,
    })).toMatchObject({ label: "Prime fishing", score: 70 });

    expect(episodeFishingPotential({
      trackCount: 20,
      resolvedCount: 9,
      fishableCount: 5,
      releaseDate: "2024-01-01",
      now: NOW,
    })).toMatchObject({ label: "Good fishing", score: 45 });

    expect(episodeFishingPotential({
      trackCount: 20,
      resolvedCount: 8,
      fishableCount: 5,
      releaseDate: "2024-01-01",
      now: NOW,
    })).toMatchObject({ label: "Light fishing", score: 44 });
  });

  test("keeps shallow or unavailable episodes Light fishing", () => {
    expect(episodeFishingPotential({
      trackCount: 4,
      resolvedCount: 4,
      fishableCount: 4,
      releaseDate: "2026-09-10",
      now: NOW,
    }).label).toBe("Light fishing");

    expect(episodeFishingPotential({
      trackCount: 20,
      resolvedCount: 8,
      fishableCount: 0,
      releaseDate: "2024-01-01",
      now: NOW,
    })).toMatchObject({ label: "Light fishing", score: 35 });
  });

  test("clamps inconsistent counts and explains missing dates", () => {
    expect(episodeFishingPotential({
      trackCount: 10,
      resolvedCount: 30,
      fishableCount: 20,
      releaseDate: null,
      now: NOW,
    })).toEqual({
      label: "Prime fishing",
      score: 73,
      reason: "10/10 fishable · 10/10 resolved · date unknown",
    });
  });

  test("treats a YouTube-only episode as high acquisition potential", () => {
    expect(trackIsFishable({ youtube_url: "https://youtube.com/watch?v=source" })).toBe(true);
    expect(episodeFishingPotential({
      trackCount: 20,
      resolvedCount: 20,
      fishableCount: 20,
      releaseDate: "2026-09-01",
      now: NOW,
    })).toMatchObject({
      label: "Prime fishing",
      score: 100,
      reason: "20/20 fishable · 20/20 resolved · 9 days old",
    });
  });

  test("does not treat empty or whitespace-only source values as fishable", () => {
    expect(trackIsFishable({
      youtube_url: "  ",
      storage_path: "",
      preview_url: "\n",
      spotify_url: null,
    })).toBe(false);
    expect(trackIsFishable(null)).toBe(false);
  });

  test("ignores retained track IDs on non-canonical appearances", () => {
    const fishableTrack = {
      youtube_url: "https://youtube.com/watch?v=retained",
      storage_path: null,
      preview_url: null,
      spotify_url: null,
    };

    expect(canonicalEntryAvailability({
      resolution_state: "unresolved",
      track_id: "retained-track",
      tracks: fishableTrack,
    })).toEqual({ resolved: false, fishable: false });
    expect(canonicalEntryAvailability({
      resolution_state: "canonical",
      track_id: "canonical-track",
      tracks: fishableTrack,
    })).toEqual({ resolved: true, fishable: true });
  });
});
