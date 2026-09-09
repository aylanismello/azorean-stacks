export type SeedBadge = "seed" | "re-seed" | null;

interface SeedFlags {
  is_seed?: boolean | null;
  is_re_seed?: boolean | null;
  is_artist_seed?: boolean | null;
}

/**
 * UI badges represent explicit user intent only. `is_artist_seed` is discovery
 * context and must not masquerade as a seed planted by the user.
 */
export function getSeedBadge(track: SeedFlags): SeedBadge {
  if (track.is_seed) return "seed";
  if (track.is_re_seed) return "re-seed";
  return null;
}
