import { describe, expect, test } from "bun:test";
import { seedMatchEvidence } from "./seed-match-evidence";

describe("seed match evidence", () => {
  test("rejects a collaboration for a solo-artist seed", () => {
    expect(seedMatchEvidence("Ludwig Göransson", "Ithaca", [
      { artist: "Ludwig Göransson, Busiswa", title: "We Know What You Whisper" },
      { artist: "Other Artist", title: "Elsewhere" },
    ])).toBeNull();
  });

  test("names the actual solo-artist track behind an artist match", () => {
    expect(seedMatchEvidence("Ludwig Göransson", "Ithaca", [
      { artist: "Ludwig Göransson", title: "Sator" },
    ])).toEqual({
      matchType: "artist",
      matchedTrack: {
        artist: "Ludwig Göransson",
        title: "Sator",
      },
    });
  });

  test("prefers an exact song over another song by the seed artist", () => {
    expect(seedMatchEvidence("DjRUM", "Frekm, Pt. 1", [
      { artist: "DjRUM", title: "Mountains Pt. 1" },
      { artist: "DjRUM", title: "Frekm Pt.1" },
    ])?.matchType).toBe("full");
  });

  test("rejects an episode with no seed-artist credit", () => {
    expect(seedMatchEvidence("Ludwig Göransson", "Ithaca", [
      { artist: "Busiswa", title: "Different Song" },
    ])).toBeNull();
  });
});
