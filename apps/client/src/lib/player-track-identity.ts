import type { PlayerTrack } from "@/components/GlobalPlayerProvider";

/**
 * Resolve the canonical catalog identity used by user actions and telemetry.
 * Episode appearances keep their own queue identity and are never submitted
 * when canonical resolution has not succeeded.
 */
export function canonicalPlayerTrackId(
  track: Pick<PlayerTrack, "id" | "appearanceId" | "catalogTrackId"> | null | undefined,
): string | null {
  if (!track) return null;
  return track.catalogTrackId ?? (track.appearanceId ? null : track.id);
}

/** Identity exposed to catalog-backed UI such as TrackCard. */
export function displayedPlayerTrackId(
  track: Pick<PlayerTrack, "id" | "appearanceId" | "catalogTrackId">,
): string {
  return canonicalPlayerTrackId(track) ?? track.id;
}

/** Match catalog-backed UI without confusing an episode appearance for a track. */
export function playerTrackMatchesCanonicalId(
  track: Pick<PlayerTrack, "id" | "appearanceId" | "catalogTrackId"> | null | undefined,
  canonicalTrackId: string | null,
): boolean {
  return canonicalTrackId !== null && canonicalPlayerTrackId(track) === canonicalTrackId;
}

export interface TrackCardActionTargets {
  trackId: string;
  trackPatchUrl: string;
  engagementUrl: string;
}

/** All TrackCard writes derive from the same resolved catalog identity. */
export function trackCardActionTargets(canonicalTrackId: string | null): TrackCardActionTargets | null {
  if (!canonicalTrackId) return null;
  return {
    trackId: canonicalTrackId,
    trackPatchUrl: `/api/tracks/${canonicalTrackId}`,
    engagementUrl: `/api/user-tracks/${canonicalTrackId}/engagement`,
  };
}

export function playerTrackActionId(
  requestedId: string,
  currentTrack: PlayerTrack | null,
  queue: PlayerTrack[],
): string | null {
  const track = currentTrack?.id === requestedId || currentTrack?.catalogTrackId === requestedId
    ? currentTrack
    : queue.find((candidate) => candidate.id === requestedId || candidate.catalogTrackId === requestedId);
  return track ? canonicalPlayerTrackId(track) : requestedId;
}
