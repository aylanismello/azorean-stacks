import { describe, expect, test } from "bun:test";
import {
  artistCreditKeys,
  classifySeedTracklist,
  hasExactArtistCredits,
  isSameSeedTrack,
  seedMatchStrength,
} from "./seed-match";

describe("seed tracklist matching", () => {
  const seed = { artist: "Ludwig Göransson", title: "Ithaca" };

  test("rejects an added collaborator for a solo-artist seed", () => {
    const result = classifySeedTracklist([
      { artist: "Ludwig Göransson, Busiswa", title: "We Know What You Whisper" },
      { artist: "Other Artist", title: "Elsewhere" },
    ], seed);

    expect(result).toBeNull();
  });

  test("exact song wins over other same-artist tracks", () => {
    const result = classifySeedTracklist([
      { artist: "Ludwig Göransson", title: "Sator" },
      { artist: "Ludwig Goransson", title: "Ithaca" },
    ], seed);
    expect(result?.matchType).toBe("full");
    expect(result?.matchedTracks).toEqual([
      { artist: "Ludwig Goransson", title: "Ithaca" },
    ]);
  });

  test("normalizes punctuation without accepting an unrelated artist", () => {
    expect(isSameSeedTrack(
      { artist: "DjRUM", title: "Frekm Pt.1" },
      { artist: "DjRUM", title: "Frekm, Pt. 1" },
    )).toBe(true);
    expect(classifySeedTracklist([
      { artist: "Busiswa", title: "Ithaca" },
    ], seed)).toBeNull();
  });

  test("supports the same multi-artist credit set in any order", () => {
    expect(hasExactArtistCredits("Frikstailers, El Guincho", "El Guincho & Frikstailers")).toBe(true);
    expect(hasExactArtistCredits("Frikstailers", "El Guincho, Frikstailers")).toBe(false);
    expect(artistCreditKeys("Ludwig Göransson feat. Busiswa")).toEqual(
      new Set(["ludwiggoransson", "busiswa"]),
    );
    expect(seedMatchStrength("full")).toBeGreaterThan(seedMatchStrength("artist"));
  });
});
