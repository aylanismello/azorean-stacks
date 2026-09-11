import { episodeFishingPotential, trackIsFishable } from "./episode-fishing";
import { recentFirst } from "./mix-series";

const MAX_EXPLORATION_TRACKS = 3;
const MAX_EXPLORATION_EPISODES = 2;
const EPISODE_CANDIDATE_WINDOW = 22;
const USER_TRACK_IN_BATCH_SIZE = 500;
const ORDINARY_SPACING = 5;

export interface SeriesExplorationOptions {
  now?: Date;
}

type EpisodeRow = {
  id: string;
  series_id: string;
  title?: string | null;
  source?: string | null;
  release_date?: string | null;
  aired_date?: string | null;
  artwork_url?: string | null;
  url?: string | null;
};

type SeriesRow = {
  id: string;
  title?: string | null;
  source?: string | null;
  source_url?: string | null;
};

type EpisodeEntry = {
  episode_id: string;
  position: number;
  track_id?: string | null;
  resolution_state?: string | null;
  track?: any;
};

function joined<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function episodeDate(episode: EpisodeRow): number {
  return Date.parse(episode.release_date ?? episode.aired_date ?? "") || 0;
}

function newestEpisodes(episodes: EpisodeRow[]): EpisodeRow[] {
  return recentFirst(episodes).slice(0, MAX_EXPLORATION_EPISODES);
}

function mergeEpisodeCandidates(...groups: EpisodeRow[][]): EpisodeRow[] {
  return [...new Map(groups.flat().map((episode) => [episode.id, episode])).values()];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function trackIsPlayable(track: any): boolean {
  return Boolean(track?.storage_path || track?.preview_url || track?.spotify_url);
}

function fishingPotential(episode: EpisodeRow, entries: EpisodeEntry[], now: Date) {
  const datedAt = episodeDate(episode);
  const ageDays = datedAt > 0 ? Math.max(0, (now.getTime() - datedAt) / 86_400_000) : 365;
  const canonical = entries.filter((entry) => entry.resolution_state === "canonical" && entry.track_id && joined(entry.track));
  const playable = canonical.filter((entry) => trackIsPlayable(joined(entry.track)));
  const fishable = canonical.filter((entry) => trackIsFishable(joined(entry.track)));
  const potential = episodeFishingPotential({
    trackCount: entries.length,
    resolvedCount: canonical.length,
    fishableCount: fishable.length,
    releaseDate: episode.release_date || episode.aired_date || null,
    now,
  });
  const components = {
    freshness: clamp01(1 - ageDays / 180),
    resolution: entries.length ? canonical.length / entries.length : 0,
    playability: canonical.length ? playable.length / canonical.length : 0,
    track_depth: clamp01(playable.length / 20),
  };
  return { ...potential, components };
}

async function actionedTrackIds(db: any, userId: string, trackIds: string[]) {
  const result = new Set<string>();
  for (let start = 0; start < trackIds.length; start += USER_TRACK_IN_BATCH_SIZE) {
    const batch = trackIds.slice(start, start + USER_TRACK_IN_BATCH_SIZE);
    const [opinions, plays, seeds] = await Promise.all([
      db.from("user_tracks")
        .select("track_id")
        .eq("user_id", userId)
        .in("track_id", batch),
      db.from("user_track_play_totals")
        .select("track_id")
        .eq("user_id", userId)
        .in("track_id", batch)
        .gt("play_count", 0),
      db.from("seeds")
        .select("track_id")
        .eq("user_id", userId)
        .eq("active", true)
        .in("track_id", batch),
    ]);
    if (opinions.error) throw opinions.error;
    if (plays.error) throw plays.error;
    if (seeds.error) throw seeds.error;
    for (const row of [...(opinions.data || []), ...(plays.data || []), ...(seeds.data || [])]) {
      result.add(row.track_id);
    }
  }
  return result;
}

/**
 * Read a small exploration lane from the authenticated user's followed series.
 * This function is intentionally read-only: appearing here is not eligibility or
 * taste evidence, and any existing user_tracks row excludes a candidate.
 */
export async function loadSeriesExploration(
  db: any,
  userId: string,
  ordinaryTrackIds: Set<string>,
  options: SeriesExplorationOptions = {},
) {
  const followedResult = await db.from("user_series_seeds")
    .select("series_id")
    .eq("user_id", userId);
  if (followedResult.error) throw followedResult.error;

  const followedSeriesIds = [...new Set<string>(
    (followedResult.data || []).map((follow: { series_id: string }) => follow.series_id),
  )].sort();
  const [followedSeriesResult, defaultSeriesResult] = await Promise.all([
    followedSeriesIds.length
      ? db.from("mix_series").select("id,title,source,source_url").in("id", followedSeriesIds)
      : { data: [], error: null },
    db.from("mix_series").select("id,title,source,source_url").eq("source", "soulection"),
  ]);
  if (followedSeriesResult.error) throw followedSeriesResult.error;
  if (defaultSeriesResult.error) throw defaultSeriesResult.error;

  const seriesById = new Map<string, SeriesRow>();
  for (const series of defaultSeriesResult.data || []) seriesById.set(series.id, series);
  for (const series of followedSeriesResult.data || []) seriesById.set(series.id, series);
  const existingFollowedIds = followedSeriesIds.filter((id) => seriesById.has(id));
  const defaultSeriesIds = (defaultSeriesResult.data || [])
    .map((series: SeriesRow) => series.id)
    .filter((id: string) => !existingFollowedIds.includes(id))
    .sort();
  if (!existingFollowedIds.length && !defaultSeriesIds.length) return [];

  const loadEpisodes = async (seriesIds: string[]) => {
    if (!seriesIds.length) return { data: [], error: null };
    const select = "id,series_id,title,source,release_date,aired_date,artwork_url,url";
    const [released, airedOnly] = await Promise.all([
      db.from("episodes").select(select)
        .in("series_id", seriesIds)
        .order("release_date", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .limit(EPISODE_CANDIDATE_WINDOW),
      db.from("episodes").select(select)
        .in("series_id", seriesIds)
        .is("release_date", null)
        .order("aired_date", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .limit(EPISODE_CANDIDATE_WINDOW),
    ]);
    return {
      data: mergeEpisodeCandidates(released.data || [], airedOnly.data || []),
      error: released.error || airedOnly.error,
    };
  };
  const [followedEpisodesResult, defaultEpisodesResult] = await Promise.all([
    loadEpisodes(existingFollowedIds),
    loadEpisodes(defaultSeriesIds),
  ]);
  if (followedEpisodesResult.error) throw followedEpisodesResult.error;
  if (defaultEpisodesResult.error) throw defaultEpisodesResult.error;

  // Re-check allowed series after service-role reads. Followed episodes win,
  // then curated Soulection fills any remaining bounded episode slots.
  const followedEpisodes = newestEpisodes((followedEpisodesResult.data || [])
    .filter((episode: EpisodeRow) => existingFollowedIds.includes(episode.series_id)));
  const defaultEpisodes = newestEpisodes((defaultEpisodesResult.data || [])
    .filter((episode: EpisodeRow) => defaultSeriesIds.includes(episode.series_id)));
  const episodes = [...followedEpisodes, ...defaultEpisodes].slice(0, MAX_EXPLORATION_EPISODES);
  const episodeIds = episodes.map((episode) => episode.id);
  if (!episodeIds.length) return [];

  const entryResult = await db.from("episode_track_entries")
    .select("episode_id,position,track_id,resolution_state,track:tracks(*)")
    .in("episode_id", episodeIds)
    .order("episode_id", { ascending: true })
    .order("position", { ascending: true });
  if (entryResult.error) throw entryResult.error;

  const episodeRank = new Map(episodeIds.map((id, index) => [id, index]));
  const allEntries = (entryResult.data || [])
    .filter((entry: EpisodeEntry) => episodeRank.has(entry.episode_id))
    .sort((a: EpisodeEntry, b: EpisodeEntry) =>
      (episodeRank.get(a.episode_id)! - episodeRank.get(b.episode_id)!)
        || a.position - b.position
        || String(a.track_id || "").localeCompare(String(b.track_id || "")),
    );
  const candidateEntries = allEntries.filter((entry: EpisodeEntry) => {
    const track = joined<any>(entry.track);
    return entry.resolution_state === "canonical"
      && Boolean(entry.track_id)
      && track?.id === entry.track_id
      && trackIsPlayable(track)
      && !ordinaryTrackIds.has(entry.track_id!);
  });

  const uniqueCandidateIds: string[] = [...new Set<string>(
    candidateEntries.map((entry: EpisodeEntry) => entry.track_id!),
  )];
  if (!uniqueCandidateIds.length) return [];
  const excluded = await actionedTrackIds(db, userId, uniqueCandidateIds);

  const entriesByEpisode = new Map<string, EpisodeEntry[]>();
  for (const entry of allEntries) {
    const bucket = entriesByEpisode.get(entry.episode_id) || [];
    bucket.push(entry);
    entriesByEpisode.set(entry.episode_id, bucket);
  }
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const fishingByEpisode = new Map(episodes.map((episode) => [
    episode.id,
    fishingPotential(episode, entriesByEpisode.get(episode.id) || [], options.now || new Date()),
  ]));
  const candidatesByEpisode = new Map<string, EpisodeEntry[]>();
  for (const entry of candidateEntries) {
    const bucket = candidatesByEpisode.get(entry.episode_id) || [];
    bucket.push(entry);
    candidatesByEpisode.set(entry.episode_id, bucket);
  }
  const cursors = new Map(episodeIds.map((id) => [id, 0]));

  const output: any[] = [];
  const seen = new Set<string>();
  while (output.length < MAX_EXPLORATION_TRACKS) {
    let addedThisRound = false;
    for (const episodeId of episodeIds) {
      const bucket = candidatesByEpisode.get(episodeId) || [];
      let cursor = cursors.get(episodeId) || 0;
      let entry: EpisodeEntry | undefined;
      let track: any;
      while (cursor < bucket.length) {
        entry = bucket[cursor++];
        track = joined<any>(entry.track);
        if (track && !seen.has(track.id) && !excluded.has(track.id)) break;
        entry = undefined;
      }
      cursors.set(episodeId, cursor);
      if (!entry || !track) continue;

      const episode = episodeById.get(entry.episode_id)!;
      const series = seriesById.get(episode.series_id)!;
      const source = series.source || episode.source || track.source;
      const sourceUrl = episode.url || series.source_url || null;
      const fishing = fishingByEpisode.get(episode.id)!;
      seen.add(track.id);
      output.push({
        ...track,
        vote_status: "pending",
        status: "pending",
        super_liked: false,
        voted_at: null,
        source,
        source_context: episode.title || series.title || null,
        source_url: sourceUrl,
        episode_id: episode.id,
        episode: {
          id: episode.id,
          title: episode.title || null,
          source,
          aired_date: episode.aired_date || episode.release_date || null,
          artwork_url: episode.artwork_url || null,
          url: sourceUrl,
        },
        taste_score: 0,
        _series_exploration: true,
        _fishing_score: fishing.score,
        _fishing_label: fishing.label,
        metadata: {
          ...(track.metadata || {}),
          _series_exploration: true,
          _fishing_score: fishing.score,
          _fishing_label: fishing.label,
          _fishing_reason: fishing.reason,
          _fishing_components: fishing.components,
        },
      });
      addedThisRound = true;
      if (output.length === MAX_EXPLORATION_TRACKS) break;
    }
    if (!addedThisRound) break;
  }
  return output;
}

/** Insert up to three exploration rows after each five ordinary rows. */
export function injectSeriesExploration<T extends { id: string }>(ordinary: T[], exploration: T[]): T[] {
  const ordinaryIds = new Set(ordinary.map((track) => track.id));
  const seen = new Set<string>();
  const bounded = exploration.filter((track) => {
    if (ordinaryIds.has(track.id) || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  }).slice(0, MAX_EXPLORATION_TRACKS);
  if (!bounded.length) return [...ordinary];

  const result: T[] = [];
  let explorationIndex = 0;
  for (let index = 0; index < ordinary.length; index++) {
    result.push(ordinary[index]);
    if ((index + 1) % ORDINARY_SPACING === 0 && explorationIndex < bounded.length) {
      result.push(bounded[explorationIndex++]);
    }
  }
  while (explorationIndex < bounded.length) result.push(bounded[explorationIndex++]);
  return result;
}
