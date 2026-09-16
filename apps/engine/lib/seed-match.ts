export type SeedMatchType = "full" | "artist";

export interface SeedTrackIdentity {
  artist: string;
  title: string;
}

export interface SeedTracklistMatch {
  matchType: SeedMatchType;
  matchedTracks: SeedTrackIdentity[];
}

function identity(value: string | null | undefined): string {
  return (value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Normalize an artist credit into its complete credited-artist set. */
export function artistCreditKeys(value: string | null | undefined): Set<string> {
  const credits = (value || "")
    .trim()
    .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+/gi, ",")
    .replace(/\s+(?:and|x)\s+/gi, ",")
    .split(/\s*(?:,|&|\/|\+|;)\s*/)
    .map((credit) => identity(credit))
    .filter(Boolean);
  return new Set(credits);
}

/** Artist matches require the same complete credit set, in any order. */
export function hasExactArtistCredits(a: string, b: string): boolean {
  const aKeys = artistCreditKeys(a);
  const bKeys = artistCreditKeys(b);
  return aKeys.size > 0
    && aKeys.size === bKeys.size
    && [...aKeys].every((key) => bKeys.has(key));
}

export function classifySeedTracklist(
  tracklist: SeedTrackIdentity[],
  seed: SeedTrackIdentity,
): SeedTracklistMatch | null {
  const seedTitle = identity(seed.title);
  const artistMatches = tracklist.filter((track) => hasExactArtistCredits(track.artist, seed.artist));
  const exactMatches = artistMatches.filter((track) => identity(track.title) === seedTitle);
  if (exactMatches.length > 0) return { matchType: "full", matchedTracks: exactMatches };
  if (artistMatches.length > 0) return { matchType: "artist", matchedTracks: artistMatches };
  return null;
}

export function isSameSeedTrack(a: SeedTrackIdentity, b: SeedTrackIdentity): boolean {
  return classifySeedTracklist([a], b)?.matchType === "full";
}

export function seedMatchStrength(matchType: SeedMatchType): number {
  return matchType === "full" ? 2 : 1;
}
