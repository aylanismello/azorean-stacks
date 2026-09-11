interface QueueTrack {
  id: string;
}

/**
 * Keep uninterrupted playback outside a newly selected queue. An index of -1
 * means the current player track is foreign to this queue, so next enters rank 1.
 */
export function destinationQueueStartIndex(
  tracks: QueueTrack[],
  playingTrackId?: string | null,
): number {
  if (!playingTrackId) return 0;
  return tracks.findIndex((track) => track.id === playingTrackId);
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
