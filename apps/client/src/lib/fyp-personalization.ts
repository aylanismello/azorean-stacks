import { paceTracks } from "./diversify";

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

export interface PersonalizedFeedResult {
  rows: any[];
  candidateTotal: number;
  candidates: any[];
}

function joinedTrack(row: any) {
  return Array.isArray(row.track) ? row.track[0] : row.track;
}

async function getPendingTrackIds(db: any, userId: string) {
  const loadPages = async (buildQuery: (page: number) => any) => {
    const rows: any[] = [];
    for (let page = 0; ; page++) {
      const { data, error } = await buildQuery(page);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < QUERY_PAGE_SIZE) break;
    }
    return rows;
  };
  const [opinions, playedTracks, activeSeeds] = await Promise.all([
    loadPages((page) => db.from("user_tracks")
      .select("track_id,status")
      .eq("user_id", userId)
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1)),
    loadPages((page) => db.from("user_track_play_totals")
      .select("track_id")
      .eq("user_id", userId)
      .gt("play_count", 0)
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1)),
    loadPages((page) => db.from("seeds")
      .select("track_id")
      .eq("user_id", userId)
      .eq("active", true)
      .not("track_id", "is", null)
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1)),
  ]);

  const pending = new Set<string>();
  const excluded = new Set<string>();
  for (const opinion of opinions) {
    if (opinion.status === "pending") pending.add(opinion.track_id);
    else excluded.add(opinion.track_id);
  }
  for (const row of [...playedTracks, ...activeSeeds]) {
    pending.delete(row.track_id);
    excluded.add(row.track_id);
  }
  return { pending, excluded };
}

/**
 * Select playable tracks from the authenticated user's durable queue. Ordinary
 * rows require pending ownership plus a score; engine-marked exploration rows
 * may be scoreless but are excluded as soon as this user acts, plays, or seeds.
 * Shared tracks.status and shared RPC rankings are never consulted.
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

  const { pending, excluded } = await getPendingTrackIds(db, userId);
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
      const exploration = queueRow.score_components?._series_exploration === true;
      const eligible = track && (pending.has(track.id) || (exploration && !excluded.has(track.id)));
      if (!track || !eligible || (!score && !exploration) || seen.has(track.id)) continue;
      const effectiveScore = score || {
        score: queueRow.score,
        confidence: 0,
        components: queueRow.score_components || {},
      };
      seen.add(track.id);
      ranked.push({
        ...track,
        // Shared tracks.status is legacy pipeline/catalog state, not this
        // user's opinion. Every row admitted here is user_tracks.pending.
        status: "pending",
        super_liked: false,
        voted_at: null,
        listen_pct: null,
        taste_score: Number(effectiveScore.score || 0),
        metadata: {
          ...(track.metadata || {}),
          _score_components: effectiveScore.components || {},
          _score_confidence: Number(effectiveScore.confidence || 0),
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

/** Ranked untouched candidates for a bespoke feed, including tracks whose
 * audio is still being prepared. */
export async function getPersonalizedCandidateTracks(
  db: any,
  userId: string,
  hideLow = false,
) {
  const { pending } = await getPendingTrackIds(db, userId);
  const ranked: any[] = [];
  const seen = new Set<string>();

  for (let page = 0; ; page++) {
    let query = db.from("user_track_scores")
      .select("track_id,score,confidence,components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .order("score", { ascending: false })
      .order("confidence", { ascending: false })
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (hideLow) query = query.gt("score", -0.3);

    const { data, error } = await query;
    if (error) throw error;
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
    }
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }

  return ranked;
}

/** Minimal candidate payload for discovery-card counts. This preserves the
 * same eligibility contract without loading every catalog/audio field. */
export async function getPersonalizedCandidateTrackSummaries(
  db: any,
  userId: string,
  hideLow = false,
) {
  const { pending } = await getPendingTrackIds(db, userId);
  const rows: Array<{ id: string; storage_path: string | null; metadata: Record<string, unknown> }> = [];
  const seen = new Set<string>();

  for (let page = 0; ; page++) {
    let query = db.from("user_track_scores")
      .select("track_id,score,track:tracks!inner(id,storage_path,metadata)")
      .eq("user_id", userId)
      .order("score", { ascending: false })
      .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
    if (hideLow) query = query.gt("score", -0.3);

    const { data, error } = await query;
    if (error) throw error;
    for (const scoreRow of data || []) {
      const track = joinedTrack(scoreRow);
      if (!track || !pending.has(track.id) || seen.has(track.id)) continue;
      seen.add(track.id);
      rows.push({
        id: track.id,
        storage_path: track.storage_path || null,
        metadata: track.metadata || {},
      });
    }
    if (!data || data.length < QUERY_PAGE_SIZE) break;
  }

  return rows;
}

export async function loadPersonalizedFeed(
  db: any,
  userId: string,
  options: PersonalizedFypOptions,
): Promise<PersonalizedFeedResult> {
  const { limit, offset, hideLow, seedId = null, genre = null, seedArtist = null } = options;
  const isFiltered = Boolean(seedId || genre || seedArtist);
  if (!isFiltered) {
    const rows = await getPersonalizedTracks(db, userId, limit, offset, hideLow);
    return { rows, candidateTotal: rows.length, candidates: rows };
  }

  let allowedBySeed: Set<string> | null = null;
  if (seedId) {
    const { data: ownedSeed, error: seedError } = await db.from("seeds")
      .select("id,track_id,artist,title")
      .eq("id", seedId)
      .eq("user_id", userId)
      .maybeSingle();
    if (seedError) throw seedError;
    if (!ownedSeed) {
      const error = new Error("Seed not found") as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    const episodeLinks = await db.from("episode_seeds")
      .select("episode_id")
      .eq("seed_id", seedId)
      .in("match_type", ["full", "artist"]);
    if (episodeLinks.error) throw episodeLinks.error;
    const episodeIds = (episodeLinks.data || []).map((link: any) => link.episode_id);
    allowedBySeed = new Set<string>();
    if (episodeIds.length) {
      for (let page = 0; ; page++) {
        const appearances = await db.from("episode_tracks")
          .select("track_id,track:tracks!inner(artist,title)")
          .in("episode_id", episodeIds)
          .range(page * QUERY_PAGE_SIZE, (page + 1) * QUERY_PAGE_SIZE - 1);
        if (appearances.error) throw appearances.error;
        for (const link of appearances.data || []) allowedBySeed.add(link.track_id);
        if (!appearances.data || appearances.data.length < QUERY_PAGE_SIZE) break;
      }
    }
    if (ownedSeed.track_id) allowedBySeed.add(ownedSeed.track_id);
  }

  const personalized = await getPersonalizedCandidateTracks(db, userId, hideLow);
  const genreKey = genre?.toLowerCase();
  const seedArtistKey = seedArtist?.toLowerCase();
  const candidates = personalized.filter((track: any) => {
    if (allowedBySeed && !allowedBySeed.has(track.id)) return false;
    const metadata = (track.metadata || {}) as Record<string, unknown>;
    if (genreKey) {
      const genres = Array.isArray(metadata.genres) ? metadata.genres : [];
      if (!genres.some((value) => typeof value === "string" && value.toLowerCase() === genreKey)) return false;
    }
    if (seedArtistKey && String(metadata.seed_artist || "").toLowerCase() !== seedArtistKey) return false;
    return true;
  });
  const orderedCandidates = seedId ? paceTracks(candidates) : candidates;
  const ready = orderedCandidates.filter((track: any) => Boolean(track.storage_path));
  return {
    rows: ready.slice(offset, offset + limit),
    candidateTotal: orderedCandidates.length,
    candidates: orderedCandidates,
  };
}

/** Load filtered or unfiltered FYP rows without any global-score fallback. */
export async function loadPersonalizedFyp(
  db: any,
  userId: string,
  options: PersonalizedFypOptions,
) {
  return (await loadPersonalizedFeed(db, userId, options)).rows;
}
