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
  return `${count} track${count === 1 ? "" : "s"} inspired by ${tangent.seed_name} ${count === 1 ? "is" : "are"} now in your queue`;
}

export function tangentDetail(tangent: FypTangent): string {
  const placement = tangent.start_rank
    ? tangent.tracks.length > 1
      ? `Coming up in spots ${tangent.start_rank}–${tangent.start_rank + tangent.tracks.length - 1}`
      : `Coming up in spot ${tangent.start_rank}`
    : "Added to what’s next";
  const retired = tangent.removed_track_ids.length;
  return retired > 0
    ? `${placement}. ${retired} older track${retired === 1 ? " was" : "s were"} moved out. Your music kept playing.`
    : `${placement}. Your music kept playing.`;
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
