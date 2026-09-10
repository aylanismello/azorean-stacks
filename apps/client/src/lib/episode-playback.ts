import type { EpisodeAppearance } from "@/app/mixes/types";
import type { PlayerTrack } from "@/components/GlobalPlayerProvider";

export interface EpisodeQueueContext {
  episodeId: string;
  sessionId: string;
  episodeTitle: string | null;
  seriesTitle: string;
}

export interface PreparationEntry {
  position: number;
  track_id: string | null;
}

export type PreparationBucket =
  | PreparationEntry[]
  | { count?: number; entries?: PreparationEntry[] }
  | null
  | undefined;

export interface EpisodePreparationResponse {
  ready?: PreparationBucket;
  queued?: PreparationBucket;
  unavailable?: PreparationBucket;
}

/** Normalize both the original array response and the count+entries response. */
export function preparationEntries(bucket: PreparationBucket): PreparationEntry[] {
  if (Array.isArray(bucket)) return bucket;
  return Array.isArray(bucket?.entries) ? bucket.entries : [];
}

export function preparationCount(bucket: PreparationBucket): number {
  if (Array.isArray(bucket)) return bucket.length;
  return typeof bucket?.count === "number" ? bucket.count : preparationEntries(bucket).length;
}

/**
 * Build a lossless episode queue. Player identity is the source appearance,
 * while catalogTrackId remains the canonical identity used for votes.
 */
export function buildEpisodeQueue(
  rows: EpisodeAppearance[],
  context: EpisodeQueueContext,
): PlayerTrack[] {
  return [...rows]
    .sort((left, right) => left.position - right.position)
    .map((row) => ({
      id: row.appearance_id,
      appearanceId: row.appearance_id,
      episodePosition: row.position,
      catalogTrackId: row.track?.id ?? null,
      artist: row.track?.artist || row.artist || row.source_artist || "Unknown artist",
      title: row.track?.title || row.title || row.source_title || "Unidentified track",
      coverArtUrl: row.audio_url ? row.cover_art_url : row.track?.cover_art_url || row.cover_art_url,
      spotifyUrl: row.spotify_url || row.track?.spotify_url || null,
      audioUrl: row.audio_url || row.preview_url || null,
      youtubeUrl: row.youtube_url || row.track?.youtube_url || null,
      audioRefreshUrl: row.track
        ? `/api/episodes/${encodeURIComponent(context.episodeId)}/audio?session_id=${encodeURIComponent(context.sessionId)}&appearance_id=${encodeURIComponent(row.appearance_id)}`
        : null,
      episodeId: context.episodeId,
      episodeTitle: context.episodeTitle,
      source_context: context.seriesTitle,
      episodeAvailability: row.track
        ? (row.audio_status === "failed" ? "unavailable" : row.audio_url || row.preview_url || row.spotify_url ? "ready" : "queued")
        : "unresolved",
    }));
}

export function episodePositionAt(queue: PlayerTrack[], index: number): number | null {
  const position = queue[index]?.episodePosition;
  return Number.isInteger(position) && position! >= 0 ? position! : null;
}

export function nextEpisodePositionToPrepare(
  queue: PlayerTrack[],
  index: number,
  lastScheduledPosition: number | null,
): number | null {
  const position = episodePositionAt(queue, index);
  return position === null || position === lastScheduledPosition ? null : position;
}
