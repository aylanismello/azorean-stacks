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

/** Full credit plus conservatively split collaboration credits. */
export function artistCreditKeys(value: string | null | undefined): Set<string> {
  const raw = (value || "").trim();
  const keys = new Set<string>();
  const fullKey = identity(raw);
  if (fullKey) keys.add(fullKey);

  const credits = raw
    .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+/gi, ",")
    .replace(/\s+(?:and|x)\s+/gi, ",")
    .split(/\s*(?:,|&|\/|\+|;)\s*/)
    .map((credit) => identity(credit))
    .filter(Boolean);
  for (const credit of credits) keys.add(credit);
  return keys;
}

export function hasArtistCreditMatch(a: string, b: string): boolean {
  const aKeys = artistCreditKeys(a);
  const bKeys = artistCreditKeys(b);
  return [...aKeys].some((key) => bKeys.has(key));
}

export function classifySeedTracklist(
  tracklist: SeedTrackIdentity[],
  seed: SeedTrackIdentity,
): SeedTracklistMatch | null {
  const seedTitle = identity(seed.title);
  const artistMatches = tracklist.filter((track) => hasArtistCreditMatch(track.artist, seed.artist));
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
