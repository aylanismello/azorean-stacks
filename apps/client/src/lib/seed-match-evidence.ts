export interface SeedMatchEvidenceTrack {
  artist: string | null;
  title: string | null;
}

export interface SeedMatchEvidence {
  matchType: "full" | "artist";
  matchedTrack: { artist: string; title: string };
}

function identity(value: string | null | undefined): string {
  return (value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function artistCreditKeys(value: string | null | undefined): Set<string> {
  const raw = (value || "").trim();
  const keys = raw
    .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+/gi, ",")
    .replace(/\s+(?:and|x)\s+/gi, ",")
    .split(/\s*(?:,|&|\/|\+|;)\s*/)
    .map((credit) => identity(credit))
    .filter(Boolean);
  return new Set(keys);
}

export function hasExactArtistCredits(trackArtist: string | null, seedArtist: string): boolean {
  const trackKeys = artistCreditKeys(trackArtist);
  const seedKeys = artistCreditKeys(seedArtist);
  return trackKeys.size > 0
    && trackKeys.size === seedKeys.size
    && [...trackKeys].every((key) => seedKeys.has(key));
}

export function seedMatchEvidence(
  seedArtist: string,
  seedTitle: string,
  tracks: SeedMatchEvidenceTrack[],
): SeedMatchEvidence | null {
  const artistMatches = tracks.filter((track): track is { artist: string; title: string } =>
    Boolean(track.artist && track.title && hasExactArtistCredits(track.artist, seedArtist))
  );
  const seedTitleKey = identity(seedTitle);
  const exact = artistMatches.find((track) => identity(track.title) === seedTitleKey);
  if (exact) return { matchType: "full", matchedTrack: exact };
  const artist = artistMatches[0];
  return artist ? { matchType: "artist", matchedTrack: artist } : null;
}
