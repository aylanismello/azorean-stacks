export interface FypTangentTrack {
  id: string;
  artist: string;
  title: string;
  cover_art_url?: string | null;
}

export interface FypTangent {
  id: string;
  seed_id: string;
  seed_name: string;
  generation: number;
  start_rank: number | null;
  added_track_ids: string[];
  moved_track_ids: string[];
  removed_track_ids: string[];
  tracks: FypTangentTrack[];
  removed_tracks: FypTangentTrack[];
  created_at: string;
}

export function tangentHeadline(tangent: FypTangent): string {
  const count = tangent.tracks.length;
  const verb = tangent.added_track_ids.length === count ? "added" : "brought forward";
  return `${count} track${count === 1 ? "" : "s"} from ${tangent.seed_name} ${verb} to your upcoming queue`;
}

export function tangentDetail(tangent: FypTangent): string {
  const positions = tangent.start_rank
    ? tangent.tracks.length > 1
      ? `positions ${tangent.start_rank}–${tangent.start_rank + tangent.tracks.length - 1}`
      : `position ${tangent.start_rank}`
    : "the upcoming queue";
  const retired = tangent.removed_track_ids.length;
  return retired > 0
    ? `Placed at ${positions}; ${retired} older track${retired === 1 ? "" : "s"} left the buffer. Your current track did not change.`
    : `Placed at ${positions}. Your current track did not change.`;
}

export function shouldRevealTangent(
  tangent: FypTangent | null | undefined,
  previousIds: string[],
  nextIds: string[],
  lastSeenTangentId: string | null,
): boolean {
  if (!tangent || tangent.id === lastSeenTangentId || tangent.tracks.length === 0) return false;
  const previousIndex = new Map(previousIds.map((id, index) => [id, index]));
  const nextIndex = new Map(nextIds.map((id, index) => [id, index]));
  return tangent.tracks.some((track) => {
    const next = nextIndex.get(track.id);
    if (next === undefined) return false;
    const previous = previousIndex.get(track.id);
    if (tangent.added_track_ids.includes(track.id)) return previous === undefined;
    return tangent.moved_track_ids.includes(track.id) && previous !== undefined && previous !== next;
  });
}
