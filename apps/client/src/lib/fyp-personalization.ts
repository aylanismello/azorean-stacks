const QUERY_PAGE_SIZE = 1000;
const MISSING_TABLE_RE = /could not find the table|does not exist|schema cache/i;

export interface PersonalizedFypOptions {
  limit: number;
  offset: number;
  hideLow: boolean;
  seedId?: string | null;
  genre?: string | null;
  seedArtist?: string | null;
}

function joinedTrack(row: any) {
  return Array.isArray(row.track) ? row.track[0] : row.track;
}

async function getPendingTrackIds(db: any, userId: string) {
  const pending = new Set<string>();
  for (let page = 0; ; page++) {
    const { data, error } = await db.from("user_tracks")
      .select("track_id,status")
      .eq("user_id", userId)
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    for (const opinion of data || []) if (opinion.status === "pending") pending.add(opinion.track_id);
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }
  for (let page = 0; ; page++) {
    const { data, error } = await db.from("user_track_play_totals")
      .select("track_id")
      .eq("user_id", userId)
      .gt("play_count", 0)
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    for (const played of data || []) pending.delete(played.track_id);
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }
  for (let page = 0; ; page++) {
    const { data, error } = await db.from("seeds")
      .select("track_id")
      .eq("user_id", userId)
      .eq("active", true)
      .not("track_id", "is", null)
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (error) throw error;
    for (const seed of data || []) pending.delete(seed.track_id);
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }
  return pending;
}

/**
 * Select playable tracks exclusively from the authenticated user's pending rows
 * and personalized score snapshot. Shared tracks.status and shared RPC rankings
 * are deliberately not consulted.
 */
export async function getPersonalizedTracks(
  db: any,
  userId: string,
  limit: number,
  offset: number,
  hideLow: boolean,
) {
  const target = offset + limit;
  if (target <= 0) return [];

  const pending = await getPendingTrackIds(db, userId);
  const ranked: any[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (let page = 0; ranked.length < target; page++) {
    let query = db.from("audio_preparation_queue")
      .select("track_id,rank,score,score_components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .eq("state", "ready")
      .gt("expires_at", now)
      .not("track.storage_path", "is", null)
      .order("rank", { ascending: true })
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (hideLow) query = query.gt("score", -0.3);

    const { data, error } = await query;
    if (error) {
      if (!MISSING_TABLE_RE.test(error.message)) throw error;
      break;
    }

    const queueIds = (data || []).map((row: any) => row.track_id).filter((id: string) => pending.has(id));
    const scores = queueIds.length ? await db.from("user_track_scores")
      .select("track_id,score,confidence,components")
      .eq("user_id", userId)
      .in("track_id", queueIds) : { data: [], error: null };
    if (scores.error) throw scores.error;
    const scoreMap = new Map((scores.data || []).map((row: any) => [row.track_id, row]));
    for (const queueRow of data || []) {
      const track = joinedTrack(queueRow);
      const score: any = track ? scoreMap.get(track.id) : null;
      if (!track || !pending.has(track.id) || !score || seen.has(track.id)) continue;
      seen.add(track.id);
      ranked.push({
        ...track,
        // Shared tracks.status is legacy pipeline/catalog state, not this
        // user's opinion. Every row admitted here is user_tracks.pending.
        status: "pending",
        super_liked: false,
        voted_at: null,
        listen_pct: null,
        taste_score: Number(score.score || 0),
        metadata: {
          ...(track.metadata || {}),
          _score_components: score.components || {},
          _score_confidence: Number(score.confidence || 0),
        },
      });
      if (ranked.length >= target) break;
    }
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }

  for (let page = 0; ranked.length < target; page++) {
    let query = db.from("user_track_scores")
      .select("track_id,score,confidence,components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .not("track.storage_path", "is", null)
      .order("score", { ascending: false })
      .order("confidence", { ascending: false })
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (hideLow) query = query.gt("score", -0.3);

    const { data, error } = await query;
    if (error) {
      if (!MISSING_TABLE_RE.test(error.message)) throw error;
      break;
    }

    for (const scoreRow of data || []) {
      const track = joinedTrack(scoreRow);
      if (!track || !pending.has(track.id) || seen.has(track.id)) continue;
      seen.add(track.id);
      ranked.push({
        ...track,
        status: "pending",
        super_liked: false,
        voted_at: null,
        listen_pct: null,
        taste_score: Number(scoreRow.score || 0),
        metadata: {
          ...(track.metadata || {}),
          _score_components: scoreRow.components || {},
          _score_confidence: Number(scoreRow.confidence || 0),
        },
      });
      if (ranked.length >= target) break;
    }
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }

  return ranked.slice(offset, target);
}

/** Load filtered or unfiltered FYP rows without any global-score fallback. */
export async function loadPersonalizedFyp(
  db: any,
  userId: string,
  options: PersonalizedFypOptions,
) {
  const { limit, offset, hideLow, seedId = null, genre = null, seedArtist = null } = options;
  const isFiltered = Boolean(seedId || genre || seedArtist);
  if (!isFiltered) return getPersonalizedTracks(db, userId, limit, offset, hideLow);

  let allowedBySeed: Set<string> | null = null;
  if (seedId) {
    const { data: ownedSeed, error: seedError } = await db.from("seeds")
      .select("id,track_id")
      .eq("id", seedId)
      .eq("user_id", userId)
      .maybeSingle();
    if (seedError) throw seedError;
    if (!ownedSeed) {
      const error = new Error("Seed not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    const episodeLinks = await db.from("episode_seeds").select("episode_id").eq("seed_id", seedId);
    if (episodeLinks.error) throw episodeLinks.error;
    const episodeIds = (episodeLinks.data || []).map((link: any) => link.episode_id);
    const appearances = episodeIds.length
      ? await db.from("episode_tracks").select("track_id").in("episode_id", episodeIds)
      : { data: [], error: null };
    if (appearances.error) throw appearances.error;
    allowedBySeed = new Set((appearances.data || []).map((link: any) => link.track_id));
    if (ownedSeed.track_id) allowedBySeed.add(ownedSeed.track_id);
  }

  const personalized = await getPersonalizedTracks(db, userId, 10_000, 0, hideLow);
  const genreKey = genre?.toLowerCase();
  const seedArtistKey = seedArtist?.toLowerCase();
  return personalized.filter((track: any) => {
    if (allowedBySeed && !allowedBySeed.has(track.id)) return false;
    const metadata = (track.metadata || {}) as Record<string, unknown>;
    if (genreKey) {
      const genres = Array.isArray(metadata.genres) ? metadata.genres : [];
      if (!genres.some((value) => typeof value === "string" && value.toLowerCase() === genreKey)) return false;
    }
    if (seedArtistKey && String(metadata.seed_artist || "").toLowerCase() !== seedArtistKey) return false;
    return true;
  }).slice(offset, offset + limit);
}
