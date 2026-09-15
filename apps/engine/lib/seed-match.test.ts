import { describe, expect, test } from "bun:test";
import {
  artistCreditKeys,
  classifySeedTracklist,
  hasArtistCreditMatch,
  isSameSeedTrack,
  seedMatchStrength,
} from "./seed-match";

describe("seed tracklist matching", () => {
  const seed = { artist: "Ludwig Göransson", title: "Ithaca" };

  test("recognizes a seed artist inside a collaboration credit", () => {
    const result = classifySeedTracklist([
      { artist: "Ludwig Göransson, Busiswa", title: "We Know What You Whisper" },
      { artist: "Other Artist", title: "Elsewhere" },
    ], seed);

    expect(result).toEqual({
      matchType: "artist",
      matchedTracks: [
        { artist: "Ludwig Göransson, Busiswa", title: "We Know What You Whisper" },
      ],
    });
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

  test("supports multi-artist seeds while keeping exact matches stronger", () => {
    expect(hasArtistCreditMatch("Frikstailers", "El Guincho, Frikstailers")).toBe(true);
    expect(artistCreditKeys("Ludwig Göransson feat. Busiswa")).toContain("ludwiggoransson");
    expect(seedMatchStrength("full")).toBeGreaterThan(seedMatchStrength("artist"));
  });
});
