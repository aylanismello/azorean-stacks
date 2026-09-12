export interface PlaybackHistoryTrack {
  id: string;
  artist: string;
  title: string;
  audioUrl?: string | null;
  audioRefreshUrl?: string | null;
}

export const PLAYBACK_HISTORY_LIMIT = 50;

/**
 * Keep a most-recent-first, deduplicated browser-tab history. Signed audio URLs
 * are omitted when the track has an authenticated refresh endpoint.
 */
export function nextPlaybackHistory<T extends PlaybackHistoryTrack>(
  current: T[],
  previous: T | null,
  nextTrackId: string,
  limit = PLAYBACK_HISTORY_LIMIT,
): T[] {
  if (!previous || previous.id === nextTrackId) return current;

  const safePrevious = (previous.audioRefreshUrl
    ? { ...previous, audioUrl: null }
    : previous) as T;

  return [
    safePrevious,
    ...current.filter((track) => track.id !== safePrevious.id),
  ].slice(0, Math.max(0, limit));
}
