export interface SeedMatchEpisode {
  id: string;
  match_type: string;
}

export interface SeedMatchTrack {
  episode_id: string;
  track_id: string;
  artist: string | null;
  title: string | null;
}

export interface SeedMatchSummary {
  exact_episode_matches: number;
  artist_episode_matches: number;
  unverified_episode_matches: number;
  matching_artist_tracks: number;
  matching_artist_track_names: string[];
  related_tracks: number;
  related_artists: number;
}

function normalized(value: string | null | undefined): string {
  return (value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedIdentity(value: string | null | undefined): string {
  return normalized(value).normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

export function buildSeedMatchSummary(
  seedArtist: string,
  seedTitle: string,
  seedTrackId: string | null,
  episodes: SeedMatchEpisode[],
  tracks: SeedMatchTrack[],
): SeedMatchSummary {
  const episodeIds = new Set(episodes.map((episode) => episode.id));
  const exactEpisodeIds = new Set(
    episodes.filter((episode) => episode.match_type === "full").map((episode) => episode.id),
  );
  const seedArtistIdentity = normalizedIdentity(seedArtist);
  const seedTitleIdentity = normalizedIdentity(seedTitle);
  const isSeedTrack = (track: SeedMatchTrack) =>
    normalizedIdentity(track.artist) === seedArtistIdentity
    && normalizedIdentity(track.title) === seedTitleIdentity;
  for (const track of tracks) {
    if (episodeIds.has(track.episode_id) && isSeedTrack(track)) exactEpisodeIds.add(track.episode_id);
  }
  const artistEpisodeIds = new Set(
    episodes
      .filter((episode) => episode.match_type === "artist" && !exactEpisodeIds.has(episode.id))
      .map((episode) => episode.id),
  );
  const uniqueRelatedTracks = new Map<string, SeedMatchTrack>();

  for (const track of tracks) {
    if (!episodeIds.has(track.episode_id) || track.track_id === seedTrackId || isSeedTrack(track)) continue;
    if (!uniqueRelatedTracks.has(track.track_id)) uniqueRelatedTracks.set(track.track_id, track);
  }

  const seedArtistKey = normalized(seedArtist);
  const matchingArtistTracks = new Map<string, SeedMatchTrack>();
  for (const track of tracks) {
    if (
      artistEpisodeIds.has(track.episode_id)
      && track.track_id !== seedTrackId
      && normalized(track.artist) === seedArtistKey
      && !matchingArtistTracks.has(track.track_id)
    ) {
      matchingArtistTracks.set(track.track_id, track);
    }
  }
  const matchingArtistTrackNames = [...matchingArtistTracks.values()]
    .sort((a, b) => normalized(a.title).localeCompare(normalized(b.title)))
    .map((track) => track.title?.trim())
    .filter((title): title is string => Boolean(title));
  const relatedArtists = new Set(
    [...uniqueRelatedTracks.values()].map((track) => normalized(track.artist)).filter(Boolean),
  );

  return {
    exact_episode_matches: exactEpisodeIds.size,
    artist_episode_matches: artistEpisodeIds.size,
    unverified_episode_matches: episodes.filter(
      (episode) => !exactEpisodeIds.has(episode.id) && !artistEpisodeIds.has(episode.id),
    ).length,
    matching_artist_tracks: matchingArtistTracks.size,
    matching_artist_track_names: matchingArtistTrackNames.slice(0, 6),
    related_tracks: uniqueRelatedTracks.size,
    related_artists: relatedArtists.size,
  };
}