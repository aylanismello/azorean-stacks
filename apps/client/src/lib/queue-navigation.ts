interface QueueTrack {
  id: string;
}

/** A newly selected feed owns playback immediately and starts at rank one. */
export function destinationQueueStartIndex(tracks: QueueTrack[]): number {
  return tracks.length > 0 ? 0 : -1;
}

/** Treat a stale index as foreign instead of navigating relative to the wrong row. */
export function validatedQueueIndex(
  tracks: QueueTrack[],
  currentIndex: number,
  playingTrackId?: string | null,
): number {
  if (!playingTrackId) return -1;
  return tracks[currentIndex]?.id === playingTrackId ? currentIndex : -1;
}
