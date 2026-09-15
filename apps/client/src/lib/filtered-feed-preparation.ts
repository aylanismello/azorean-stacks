export const FILTERED_FEED_WARM_TARGET = 20;

export interface FeedPreparationCandidate {
  id: string;
  storage_path?: string | null;
  youtube_url?: string | null;
  source_url?: string | null;
  spotify_url?: string | null;
  dl_attempts?: number | null;
}

export interface FeedAppearance {
  episode_id: string;
  track_id: string;
}

export interface FeedCount {
  eligible: number;
  ready: number;
}

export function genreFeedCounts(
  candidates: Array<FeedPreparationCandidate & { metadata?: { genres?: unknown } | null }>,
): Map<string, FeedCount> {
  const counts = new Map<string, FeedCount>();
  for (const track of candidates) {
    const genres = Array.isArray(track.metadata?.genres) ? track.metadata.genres : [];
    for (const value of genres) {
      if (typeof value !== "string" || !value.trim()) continue;
      const key = value.trim();
      const count = counts.get(key) || { eligible: 0, ready: 0 };
      count.eligible += 1;
      if (track.storage_path) count.ready += 1;
      counts.set(key, count);
    }
  }
  return counts;
}

export function seedFeedCount(
  candidates: FeedPreparationCandidate[],
  episodeIds: string[],
  appearances: FeedAppearance[],
  seedTrackId?: string | null,
): FeedCount {
  const candidateById = new Map(candidates.map((track) => [track.id, track]));
  const episodeSet = new Set(episodeIds);
  const eligibleIds = new Set(
    appearances
      .filter((row) => episodeSet.has(row.episode_id) && candidateById.has(row.track_id))
      .map((row) => row.track_id),
  );
  if (seedTrackId && candidateById.has(seedTrackId)) eligibleIds.add(seedTrackId);
  return {
    eligible: eligibleIds.size,
    ready: [...eligibleIds].filter((id) => Boolean(candidateById.get(id)?.storage_path)).length,
  };
}

export function filteredFeedWarmCandidates<T extends FeedPreparationCandidate>(
  candidates: T[],
  warmTarget = FILTERED_FEED_WARM_TARGET,
): Array<T & { acquisitionUrl: string }> {
  const unresolved: Array<T & { acquisitionUrl: string }> = [];
  let represented = 0;
  for (const track of candidates) {
    if (track.storage_path) {
      represented += 1;
    } else if (Number(track.dl_attempts || 0) < 3) {
      const acquisitionUrl = track.youtube_url || track.spotify_url || track.source_url;
      if (acquisitionUrl) {
        unresolved.push({ ...track, acquisitionUrl });
        represented += 1;
      }
    }
    if (represented >= Math.max(0, warmTarget)) break;
  }
  return unresolved;
}

export async function queueFilteredFeedPreparation(
  db: any,
  userId: string,
  candidates: FeedPreparationCandidate[],
): Promise<number> {
  const warm = filteredFeedWarmCandidates(candidates);
  if (!warm.length) return 0;

  const active = await db.from("download_requests")
    .select("track_id")
    .in("track_id", warm.map((track) => track.id))
    .in("status", ["pending", "downloading"]);
  if (active.error) throw active.error;
  const activeIds = new Set((active.data || []).map((row: any) => row.track_id));
  const missing = warm.filter((track) => !activeIds.has(track.id));

  const insertions = await Promise.all(missing.map((track) =>
    db.from("download_requests").insert({
      track_id: track.id,
      user_id: userId,
      youtube_url: track.acquisitionUrl,
      status: "pending",
    })
  ));
  const failure = insertions.find((result: any) => result.error && result.error.code !== "23505");
  if (failure?.error) throw failure.error;
  return missing.length;
}

/** IDs still being prepared inside the ordinary 4U warm window. */
export async function loadFypPreparationTrackIds(
  db: any,
  userId: string,
  warmTarget = FILTERED_FEED_WARM_TARGET,
): Promise<string[]> {
  const result = await db.from("audio_preparation_queue")
    .select("track_id")
    .eq("user_id", userId)
    .in("state", ["ranked", "preparing"])
    .lte("rank", Math.max(0, warmTarget))
    .gt("expires_at", new Date().toISOString())
    .order("rank", { ascending: true });
  if (result.error) throw result.error;
  return Array.from(new Set((result.data || []).map((row: { track_id: string }) => row.track_id)));
}
