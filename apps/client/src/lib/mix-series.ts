export interface MixPreparationEntry {
  position: number;
  track_id: string | null;
  tracks?: { storage_path?: string | null; youtube_url?: string | null; metadata?: Record<string, unknown> | null } | null;
}

export interface DatedEpisode {
  release_date?: string | null;
  aired_date?: string | null;
  title?: string | null;
}

export function recentFirst<T extends DatedEpisode>(episodes: T[]): T[] {
  return [...episodes].sort((a, b) => {
    const aDate = Date.parse(a.release_date || a.aired_date || "") || 0;
    const bDate = Date.parse(b.release_date || b.aired_date || "") || 0;
    return bDate - aDate || (a.title || "").localeCompare(b.title || "");
  });
}

export function acquisitionSource(entry: MixPreparationEntry): string | null {
  const track = entry.tracks;
  if (!entry.track_id || !track || track.storage_path) return null;
  return track.youtube_url || null;
}

export function boundedPreparationWindow(entries: MixPreparationEntry[], currentPosition: number, lookAhead = 5) {
  const ordered = [...entries].sort((a, b) => a.position - b.position);
  const resolvable = (entry: MixPreparationEntry) => Boolean(entry.track_id && entry.tracks);
  const current = ordered.find((entry) => entry.position === currentPosition && resolvable(entry));
  const nextResolvable = ordered.filter((entry) => entry.position > currentPosition && resolvable(entry)).slice(0, Math.max(0, lookAhead));
  return [...(current ? [current] : []), ...nextResolvable];
}
