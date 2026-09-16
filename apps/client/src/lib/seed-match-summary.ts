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

export interface SeedArtistMatchBreakdown {
  artist: string;
  episodes: number;
  tracks: number;
}

export interface SeedMatchSummary {
  exact_episode_matches: number;
  artist_episode_matches: number;
  unverified_episode_matches: number;
  matching_artist_tracks: number;
  matching_artist_track_names: string[];
  artist_match_breakdown: SeedArtistMatchBreakdown[];
  related_tracks: number;
  related_artists: number;
}

function normalized(value: string | null | undefined): string {
  return (value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedIdentity(value: string | null | undefined): string {
  return normalized(value).normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

function splitArtistCredits(value: string | null | undefined): Array<{ label: string; key: string }> {
  const parts = (value || "")
    .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+/gi, ",")
    .replace(/\s+(?:and|x)\s+/gi, ",")
    .split(/\s*(?:,|&|\/|\+|;)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const credits = new Map<string, string>();
  for (const label of parts) {
    const key = normalizedIdentity(label);
    if (key && !credits.has(key)) credits.set(key, label);
  }
  return [...credits].map(([key, label]) => ({ key, label }));
}

export function buildSeedMatchSummary(
  seedArtist: string,
  seedTitle: string,
  seedTrackId: string | null,
  episodes: SeedMatchEpisode[],
  tracks: SeedMatchTrack[],
): SeedMatchSummary {
  const episodeIds = new Set(episodes.map((episode) => episode.id));
  const seedCredits = splitArtistCredits(seedArtist);
  const seedCreditKeys = new Set(seedCredits.map((credit) => credit.key));
  const seedTitleIdentity = normalizedIdentity(seedTitle);
  const trackCreditKeys = (track: SeedMatchTrack) =>
    new Set(splitArtistCredits(track.artist).map((credit) => credit.key));
  const matchingSeedCredits = (track: SeedMatchTrack) => {
    const trackKeys = trackCreditKeys(track);
    if (trackKeys.size !== seedCreditKeys.size) return [];
    return [...trackKeys].every((key) => seedCreditKeys.has(key))
      ? [...trackKeys]
      : [];
  };
  const isSeedTrack = (track: SeedMatchTrack) =>
    normalizedIdentity(track.title) === seedTitleIdentity && matchingSeedCredits(track).length > 0;

  // Stored episode labels are historical hints, not sufficient evidence.
  // Re-derive every current match from the actual credited track appearances.
  const exactEpisodeIds = new Set<string>();
  for (const track of tracks) {
    if (episodeIds.has(track.episode_id) && isSeedTrack(track)) exactEpisodeIds.add(track.episode_id);
  }

  const artistEvidenceEpisodeIds = new Set(
    tracks
      .filter((track) => episodeIds.has(track.episode_id) && matchingSeedCredits(track).length > 0)
      .map((track) => track.episode_id),
  );
  const artistEpisodeIds = new Set(
    episodes
      .filter((episode) => !exactEpisodeIds.has(episode.id) && artistEvidenceEpisodeIds.has(episode.id))
      .map((episode) => episode.id),
  );
  const verifiedEpisodeIds = new Set([...exactEpisodeIds, ...artistEpisodeIds]);

  const uniqueRelatedTracks = new Map<string, SeedMatchTrack>();
  for (const track of tracks) {
    if (!verifiedEpisodeIds.has(track.episode_id) || track.track_id === seedTrackId || isSeedTrack(track)) continue;
    if (!uniqueRelatedTracks.has(track.track_id)) uniqueRelatedTracks.set(track.track_id, track);
  }

  const matchingArtistTracks = new Map<string, SeedMatchTrack>();
  const breakdownState = new Map<string, { episodes: Set<string>; tracks: Set<string> }>();
  for (const credit of seedCredits) {
    breakdownState.set(credit.key, { episodes: new Set(), tracks: new Set() });
  }
  for (const track of tracks) {
    if (!artistEpisodeIds.has(track.episode_id) || track.track_id === seedTrackId || isSeedTrack(track)) continue;
    const creditMatches = matchingSeedCredits(track);
    if (creditMatches.length === 0) continue;
    matchingArtistTracks.set(track.track_id, track);
    for (const key of creditMatches) {
      breakdownState.get(key)?.episodes.add(track.episode_id);
      breakdownState.get(key)?.tracks.add(track.track_id);
    }
  }

  const matchingArtistTrackNames = [...matchingArtistTracks.values()]
    .sort((a, b) => normalized(a.title).localeCompare(normalized(b.title)))
    .map((track) => track.title?.trim())
    .filter((title): title is string => Boolean(title));
  const artistMatchBreakdown = seedCredits
    .map((credit) => ({
      artist: credit.label,
      episodes: breakdownState.get(credit.key)?.episodes.size || 0,
      tracks: breakdownState.get(credit.key)?.tracks.size || 0,
    }))
    .filter((entry) => entry.episodes > 0 || entry.tracks > 0);
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
    artist_match_breakdown: artistMatchBreakdown,
    related_tracks: uniqueRelatedTracks.size,
    related_artists: relatedArtists.size,
  };
}
