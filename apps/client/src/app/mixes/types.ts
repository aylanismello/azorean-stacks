export interface MixEpisode {
  id: string;
  title: string | null;
  description?: string | null;
  url?: string | null;
  release_date: string | null;
  aired_date: string | null;
  artwork_url: string | null;
  dj_name: string | null;
  soundcloud_url?: string | null;
  apple_music_url?: string | null;
  track_count?: number;
  resolved_count?: number;
}

export interface MixSeries {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  source: string | null;
  source_url: string | null;
  artwork_url: string | null;
  seeded: boolean;
  episode_count?: number;
  latest_episode: MixEpisode | null;
  episodes?: MixEpisode[];
}

export interface EpisodeAppearance {
  id: string;
  appearance_id: string;
  position: number;
  timestamp_text: string | null;
  source_artist: string | null;
  source_title: string | null;
  resolution_state: string | null;
  artist: string | null;
  title: string | null;
  spotify_url: string | null;
  youtube_url: string | null;
  cover_art_url: string | null;
  preview_url: string | null;
  audio_url: string | null;
  audio_status: string;
  storage_path: string | null;
  track: {
    id: string;
    artist: string;
    title: string;
    spotify_url: string | null;
    youtube_url: string | null;
    cover_art_url: string | null;
    preview_url: string | null;
    audio_url: string | null;
    storage_path: string | null;
  } | null;
}

export function episodeDate(episode: MixEpisode | null): string | null {
  return episode?.release_date || episode?.aired_date || null;
}

export function formatEpisodeDate(episode: MixEpisode | null): string {
  const value = episodeDate(episode);
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
