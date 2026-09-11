export type FishingLabel = "Prime fishing" | "Good fishing" | "Light fishing";

export interface EpisodeFishingInput {
  trackCount: number;
  resolvedCount: number;
  fishableCount: number;
  releaseDate: string | null;
  /** Injected for deterministic tests; API callers use the current time. */
  now?: Date;
}

export interface EpisodeFishingPotential {
  label: FishingLabel;
  score: number;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function wholeCount(value: number, ceiling?: number): number {
  const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return ceiling === undefined ? count : Math.min(count, ceiling);
}

function freshness(releaseDate: string | null, now: Date): { points: number; reason: string } {
  if (!releaseDate) return { points: 0, reason: "date unknown" };
  const releasedAt = new Date(releaseDate);
  if (Number.isNaN(releasedAt.getTime())) return { points: 0, reason: "date unknown" };

  const days = Math.max(0, Math.floor((now.getTime() - releasedAt.getTime()) / DAY_MS));
  const points = days <= 30 ? 15 : days <= 90 ? 10 : days <= 365 ? 5 : 0;
  return { points, reason: days === 1 ? "1 day old" : `${days} days old` };
}

/**
 * Scores an episode from catalog facts only (0–100): depth 25%, resolution
 * 25%, acquisition-ready coverage 35%, and freshness 15%.
 *
 * Prime requires at least eight entries and Good requires at least five, so a
 * tiny fully-resolved tracklist cannot look more promising than a deep crate.
 */
export function episodeFishingPotential(input: EpisodeFishingInput): EpisodeFishingPotential {
  const trackCount = wholeCount(input.trackCount);
  const resolvedCount = wholeCount(input.resolvedCount, trackCount);
  const fishableCount = wholeCount(input.fishableCount, resolvedCount);
  const divisor = Math.max(trackCount, 1);
  const age = freshness(input.releaseDate, input.now ?? new Date());

  const depthPoints = Math.min(trackCount / 20, 1) * 25;
  const resolutionPoints = (resolvedCount / divisor) * 25;
  const fishablePoints = (fishableCount / divisor) * 35;
  const score = Math.round(depthPoints + resolutionPoints + fishablePoints + age.points);

  let label: FishingLabel = "Light fishing";
  if (trackCount >= 8 && score >= 70) label = "Prime fishing";
  else if (trackCount >= 5 && score >= 45) label = "Good fishing";

  return {
    label,
    score,
    reason: `${fishableCount}/${trackCount} fishable · ${resolvedCount}/${trackCount} resolved · ${age.reason}`,
  };
}

/** A canonical track is fishable when it can play now or has a source to pull. */
export function trackIsFishable(track: {
  youtube_url?: string | null;
  storage_path?: string | null;
  preview_url?: string | null;
  spotify_url?: string | null;
} | null | undefined): boolean {
  return Boolean(track && [
    track.youtube_url,
    track.storage_path,
    track.preview_url,
    track.spotify_url,
  ].some((value) => typeof value === "string" && value.trim().length > 0));
}

type FishingTrack = Parameters<typeof trackIsFishable>[0];

/** Only canonical appearances contribute resolved or acquisition-ready counts. */
export function canonicalEntryAvailability(entry: {
  resolution_state?: string | null;
  track_id?: string | null;
  tracks?: FishingTrack | FishingTrack[];
}): { resolved: boolean; fishable: boolean } {
  if (entry.resolution_state !== "canonical" || !entry.track_id) {
    return { resolved: false, fishable: false };
  }

  const track = Array.isArray(entry.tracks) ? entry.tracks[0] : entry.tracks;
  return { resolved: true, fishable: trackIsFishable(track) };
}
