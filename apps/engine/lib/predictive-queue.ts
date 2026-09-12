import { getSupabase } from "./supabase";
import { applySonicAffinityRanking } from "./sonic-ranking";
import { episodeContextKey } from "./taste-scoring";

export const QUEUE_TARGET = Number(process.env.AUDIO_QUEUE_TARGET || 50);
export const WARM_TARGET = Number(process.env.AUDIO_WARM_TARGET || 20);
export const SAFETY_FLOOR = Number(process.env.AUDIO_SAFETY_FLOOR || 10);
export const QUEUE_VERSION = process.env.AUDIO_QUEUE_VERSION || "taste_context_queue_v4";
const QUEUE_TTL_DAYS = Number(process.env.AUDIO_QUEUE_TTL_DAYS || 7);
const MAX_DL_ATTEMPTS = 3;
export const SERIES_SEED_CONTEXT_BOOST = 0.04;
export const SOULECTION_EXPLORATION_TRACK_LIMIT = 3;
export const SOULECTION_EXPLORATION_EPISODE_LIMIT = 2;

type Db = ReturnType<typeof getSupabase>;

export interface QueueCandidate {
  id: string;
  artist?: string | null;
  title?: string | null;
  episode_id?: string | null;
  episode_ids?: string[];
  source_contexts?: string[];
  taste_score?: number | null;
  sonic_similarity?: number | null;
  storage_path?: string | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: any;
}

export interface FypTangentDelta {
  trackIds: string[];
  addedTrackIds: string[];
  movedTrackIds: string[];
  removedTrackIds: string[];
  startRank: number | null;
}

/** Describe only the bounded seed-derived rows that actually changed the queue. */
export function buildFypTangentDelta(
  existing: QueueCandidate[],
  next: QueueCandidate[],
  preferredFreshTrackIds: Set<string>,
  freshLimit: number,
): FypTangentDelta {
  const previousRankById = new Map(existing.map((track, index) => [track.id, index + 1]));
  const nextRankById = new Map(next.map((track, index) => [track.id, index + 1]));
  const requestedTrackIds = next
    .filter((track) => preferredFreshTrackIds.has(track.id))
    .slice(0, Math.max(0, Math.floor(freshLimit)))
    .map((track) => track.id);
  const addedTrackIds = requestedTrackIds.filter((trackId) => !previousRankById.has(trackId));
  const movedTrackIds = requestedTrackIds.filter((trackId) => {
    const previousRank = previousRankById.get(trackId);
    const nextRank = nextRankById.get(trackId);
    return previousRank !== undefined && nextRank !== undefined && previousRank !== nextRank;
  });
  const affected = new Set([...addedTrackIds, ...movedTrackIds]);
  const trackIds = requestedTrackIds.filter((trackId) => affected.has(trackId));
  const removedTrackIds = existing
    .map((track) => track.id)
    .filter((trackId) => !nextRankById.has(trackId));
  const startRank = trackIds.length
    ? Math.min(...trackIds.map((trackId) => nextRankById.get(trackId) || Number.MAX_SAFE_INTEGER))
    : null;
  return { trackIds, addedTrackIds, movedTrackIds, removedTrackIds, startRank };
}

/** Keep an in-progress queue stable while allowing a bounded fresh seed lane. */
export function mergeStableQueueCandidates(
  existing: QueueCandidate[],
  ranked: QueueCandidate[],
  target = QUEUE_TARGET,
  freshInsertions = 0,
  protectedPrefix = 5,
  preferredFreshTrackIds?: Set<string>,
): QueueCandidate[] {
  const boundedTarget = Math.max(0, Math.floor(target));
  const rankedById = new Map(ranked.map((track) => [track.id, track]));
  const seen = new Set<string>();
  const stable = existing.filter((track) => {
    if (!track.id || seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  }).map((track) => {
    const refreshed = rankedById.get(track.id);
    return refreshed
      ? { ...track, ...refreshed, metadata: { ...(track.metadata || {}), ...(refreshed.metadata || {}) } }
      : track;
  });
  const freshSeen = new Set(seen);
  const allFresh = ranked.filter((track) => {
    if (!track.id || freshSeen.has(track.id)) return false;
    freshSeen.add(track.id);
    return true;
  });
  const prefixLength = Math.min(Math.max(0, protectedPrefix), stable.length, boundedTarget);
  const protectedTracks = stable.slice(0, prefixLength);
  const protectedIds = new Set(protectedTracks.map((track) => track.id));
  const movableStable = stable.slice(prefixLength);
  const preferredFresh = preferredFreshTrackIds
    ? allFresh.filter((track) => preferredFreshTrackIds.has(track.id))
    : allFresh;
  const activePreferred = preferredFreshTrackIds
    ? movableStable.filter((track) => preferredFreshTrackIds.has(track.id))
    : [];
  const protectedPreferredCount = preferredFreshTrackIds
    ? protectedTracks.filter((track) => preferredFreshTrackIds.has(track.id)).length
    : 0;
  const injectionCount = Math.min(
    Math.max(0, Math.floor(freshInsertions) - protectedPreferredCount),
    activePreferred.length + preferredFresh.length,
    Math.max(0, boundedTarget - protectedTracks.length),
  );
  const injected = [...activePreferred, ...preferredFresh].slice(0, injectionCount);
  const injectedIds = new Set(injected.map((track) => track.id));
  const stableRemainder = movableStable.filter((track) => !injectedIds.has(track.id));
  const merged = injectionCount > 0
    ? [
        ...protectedTracks,
        ...injected,
        ...stableRemainder,
        ...allFresh.filter((track) => !injectedIds.has(track.id) && !protectedIds.has(track.id)),
      ]
    : [...stable, ...allFresh];
  return merged.slice(0, boundedTarget);
}

export function isObviousPlaceholderCandidate(track: QueueCandidate): boolean {
  const artist = String(track.artist || "").trim().toLowerCase();
  const title = String(track.title || "").trim().toLowerCase();
  return !artist || !title || artist === "tracklist" || title === "tracklist";
}

function normalizeContextValue(value: unknown): string | null {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return normalized || null;
}

const ARTIST_ALIASES: Record<string, string> = {
  flylo: "flying lotus",
};

/** Artist identities used only for pacing—not for taste evidence. Structured
 * collaborator arrays are safe to expand; free-form group names stay intact. */
export function artistContextKeys(track: QueueCandidate): string[] {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeContextValue(value);
    if (!normalized) return;
    const primary = normalized.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim();
    keys.add(ARTIST_ALIASES[normalized] || normalized);
    if (primary) keys.add(ARTIST_ALIASES[primary] || primary);
  };
  add(track.artist);
  for (const field of ["artists", "spotify_artists", "artist_names"]) {
    const values = track.metadata?.[field];
    if (Array.isArray(values)) values.forEach(add);
  }
  return [...keys];
}

function primaryEpisodeKeys(track: QueueCandidate): string[] {
  const primary = normalizeContextValue(track.episode_id || track.episode_ids?.[0]);
  return primary ? [primary] : [];
}

function primaryShowKeys(track: QueueCandidate): string[] {
  const primary = normalizeContextValue(track.source_contexts?.[0]);
  return primary ? [primary] : [];
}

function overlaps(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((key) => rightSet.has(key));
}

function contextCount(
  tracks: QueueCandidate[],
  keys: string[],
  keyFor: (track: QueueCandidate) => string[],
): number {
  if (!keys.length) return 0;
  return tracks.reduce((count, track) => count + (overlaps(keys, keyFor(track)) ? 1 : 0), 0);
}

/** Final near-term pacing pass. Ranking remains the source order; this moves
 * only the first available alternative needed to keep the dig varied. */
export function paceQueueCandidates(
  candidates: QueueCandidate[],
  target = candidates.length,
): QueueCandidate[] {
  const pool = [...candidates];
  const result: QueueCandidate[] = [];
  const boundedTarget = Math.max(0, Math.min(pool.length, Math.floor(target)));

  const violatesImmediate = (track: QueueCandidate) => {
    const previous = result[result.length - 1];
    if (!previous) return false;
    return overlaps(artistContextKeys(track), artistContextKeys(previous))
      || overlaps(primaryEpisodeKeys(track), primaryEpisodeKeys(previous))
      || overlaps(primaryShowKeys(track), primaryShowKeys(previous));
  };
  const violatesWindow = (track: QueueCandidate) => {
    const recent = result.slice(-9);
    return contextCount(recent, artistContextKeys(track), artistContextKeys) >= 2
      || contextCount(recent, primaryEpisodeKeys(track), primaryEpisodeKeys) >= 2
      || contextCount(recent, primaryShowKeys(track), primaryShowKeys) >= 3;
  };

  while (result.length < boundedTarget && pool.length) {
    let index = pool.findIndex((track) => !violatesImmediate(track) && !violatesWindow(track));
    if (index < 0) index = pool.findIndex((track) => !violatesImmediate(track));
    if (index < 0) index = 0;
    result.push(pool.splice(index, 1)[0]);
  }
  return result;
}

function isSafeExplorationCandidate(track: QueueCandidate): boolean {
  if (isObviousPlaceholderCandidate(track)) return false;
  if (Number(track.taste_score || 0) < 0) return false;
  const components = track.metadata?._score_components as Record<string, unknown> | undefined;
  return ![components?.source_context, components?.episode_density]
    .some((value) => typeof value === "number" && value < 0);
}

const HIGH_CONFIDENCE_PREFIX_LIMIT = 5;
const HIGH_CONFIDENCE_MIN_SCORE = 0.5;
const HIGH_CONFIDENCE_MIN_CONFIDENCE = 0.8;

/** Preserve only a bounded contiguous prefix with strong score evidence. */
export function highConfidencePrefixLength(
  candidates: QueueCandidate[],
  target: number,
): number {
  const bound = Math.min(HIGH_CONFIDENCE_PREFIX_LIMIT, target, candidates.length);
  let length = 0;
  while (length < bound) {
    const track = candidates[length];
    const score = Number(track.taste_score);
    const confidence = Number(track.metadata?._score_confidence);
    if (!Number.isFinite(score) || score < HIGH_CONFIDENCE_MIN_SCORE
      || !Number.isFinite(confidence) || confidence < HIGH_CONFIDENCE_MIN_CONFIDENCE) break;
    length++;
  }
  return length;
}

/** Build a balanced slate, then enforce near-term artist/episode/show pacing. */
export function diversifyQueueCandidates(
  candidates: QueueCandidate[],
  target = QUEUE_TARGET,
): QueueCandidate[] {
  const ranked = [...candidates];
  const explorationCount = target >= 8 ? Math.max(1, Math.round(target * 0.125)) : 0;
  const explorationFloor = Math.max(20, Math.ceil(target * 0.25));
  const exploration = ranked
    .map((track, index) => {
      const confidence = Math.max(0, Math.min(1, Number(track.metadata?._score_confidence || 0)));
      const score = Number(track.taste_score || 0);
      return { track, index, uncertainty: (1 - confidence) * 0.75 + (1 - Math.min(1, Math.abs(score))) * 0.25 };
    })
    .filter(({ index, track }) => index >= explorationFloor && isSafeExplorationCandidate(track))
    .sort((a, b) => b.uncertainty - a.uncertainty || a.index - b.index)
    .slice(0, explorationCount);
  const explorationIds = new Set(exploration.map(({ track }) => track.id));
  const staged = ranked.filter((track) => !explorationIds.has(track.id));
  const explorationInterval = exploration.length
    ? Math.max(7, Math.round(target / exploration.length))
    : Number.POSITIVE_INFINITY;

  exploration.forEach(({ track }, index) => {
    const insertionIndex = Math.min(
      staged.length,
      Math.max(0, Math.round((index + 1) * explorationInterval) - 1),
    );
    staged.splice(insertionIndex, 0, track);
  });

  return paceQueueCandidates(staged, target).map((track, index) => {
    const originalRank = candidates.findIndex((candidate) => candidate.id === track.id) + 1;
    const nextRank = index + 1;
    return {
      ...track,
      metadata: {
        ...(track.metadata || {}),
        _queue_original_rank: originalRank,
        _queue_diversity_rank_delta: originalRank - nextRank,
      },
    };
  });
}

export interface PreparationTrack extends QueueCandidate {
  artist: string;
  title: string;
  youtube_url: string;
  preparation_reason: "explicit_request" | "permanent" | "super_liked" | "approved" | "active_seed" | "predictive_queue";
  preparation_rank: number;
  queue_user_ids: string[];
}

export function isPreparationTrack(
  track: QueueCandidate,
): track is QueueCandidate & Pick<PreparationTrack, "artist" | "title" | "youtube_url"> {
  return typeof track.artist === "string" && track.artist.trim().length > 0
    && typeof track.title === "string" && track.title.trim().length > 0
    && typeof track.youtube_url === "string" && track.youtube_url.trim().length > 0;
}

function requireOk(result: any, label: string): any[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return Array.isArray(result.data) ? result.data : [];
}

/**
 * Add a small, non-stacking rank context to existing candidates only.
 * This is intentionally separate from learned taste evidence and confidence.
 */
export function applySeriesSeedContext(
  candidates: QueueCandidate[],
  contextTrackIds: Iterable<string>,
): QueueCandidate[] {
  const matched = new Set(contextTrackIds);
  return candidates.map((track) => {
    if (!matched.has(track.id)) return track;
    const scoreComponents = (track.metadata?._score_components as Record<string, unknown> | undefined) || {};
    return {
      ...track,
      taste_score: Math.round((Number(track.taste_score || 0) + SERIES_SEED_CONTEXT_BOOST) * 1000) / 1000,
      metadata: {
        ...(track.metadata || {}),
        _score_components: {
          ...scoreComponents,
          series_seed_context: SERIES_SEED_CONTEXT_BOOST,
        },
      },
    };
  });
}

export async function seriesSeedContextTrackIds(
  db: Db,
  userId: string,
  eligibleTrackIds: string[],
): Promise<Set<string>> {
  if (!eligibleTrackIds.length) return new Set();
  const seedResult = await db.from("user_series_seeds")
    .select("series_id")
    .eq("user_id", userId);
  const seriesIds = Array.from(new Set(
    requireOk(seedResult, "series seed context lookup").map((row: any) => row.series_id).filter(Boolean),
  )) as string[];
  if (!seriesIds.length) return new Set();

  const episodeIds: string[] = [];
  for (let start = 0; start < seriesIds.length; start += 300) {
    const result = await db.from("episodes")
      .select("id")
      .in("series_id", seriesIds.slice(start, start + 300));
    episodeIds.push(...requireOk(result, "seeded series episode lookup").map((row: any) => row.id));
  }
  if (!episodeIds.length) return new Set();

  // Intersect at query time with the already user_tracks-eligible candidates.
  // Series membership can influence their order but cannot create candidates.
  const seededEpisodeIds = new Set(episodeIds);
  const matchedTrackIds = new Set<string>();
  for (let trackStart = 0; trackStart < eligibleTrackIds.length; trackStart += 300) {
    const result = await db.from("episode_track_entries")
      .select("track_id,episode_id")
      .in("track_id", eligibleTrackIds.slice(trackStart, trackStart + 300))
      .not("track_id", "is", null);
    for (const row of requireOk(result, "seeded series track context lookup")) {
      if (row.track_id && seededEpisodeIds.has(row.episode_id)) matchedTrackIds.add(row.track_id);
    }
  }
  return matchedTrackIds;
}

async function pendingUserTrackIds(db: Db, userId: string): Promise<string[]> {
  const trackIds: string[] = [];
  for (let start = 0; ; start += 1000) {
    const result = await db.from("user_tracks")
      .select("track_id")
      .eq("user_id", userId)
      .eq("status", "pending")
      .range(start, start + 999);
    const rows = requireOk(result, "queue candidate eligibility");
    trackIds.push(...rows.map((row: any) => row.track_id));
    if (rows.length < 1000) break;
  }

  const playedTrackIds = new Set<string>();
  for (let start = 0; ; start += 1000) {
    const result = await db.from("user_track_play_totals")
      .select("track_id")
      .eq("user_id", userId)
      .gt("play_count", 0)
      .range(start, start + 999);
    const rows = requireOk(result, "qualified playback exclusion");
    for (const row of rows) playedTrackIds.add(row.track_id);
    if (rows.length < 1000) break;
  }

  const seededTrackIds = new Set<string>();
  for (let start = 0; ; start += 1000) {
    const result = await db.from("seeds")
      .select("track_id")
      .eq("user_id", userId)
      .eq("active", true)
      .not("track_id", "is", null)
      .range(start, start + 999);
    const rows = requireOk(result, "active seed exclusion");
    for (const row of rows) seededTrackIds.add(row.track_id);
    if (rows.length < 1000) break;
  }

  return trackIds.filter((trackId) => !playedTrackIds.has(trackId) && !seededTrackIds.has(trackId));
}

async function activeQueueCandidates(
  db: Db,
  userId: string,
  eligibleTrackIds: Set<string>,
): Promise<QueueCandidate[]> {
  const result = await db.from("audio_preparation_queue")
    .select("track_id,rank,score,score_components,track:tracks!inner(*)")
    .eq("user_id", userId)
    .in("state", ["ranked", "preparing", "ready"])
    .order("rank", { ascending: true });
  return requireOk(result, "active queue continuity lookup")
    .filter((row: any) => eligibleTrackIds.has(row.track_id))
    .map((row: any) => {
      const track = Array.isArray(row.track) ? row.track[0] : row.track;
      return track ? {
        ...track,
        taste_score: Number(row.score || 0),
        metadata: {
          ...(track.metadata || {}),
          _score_components: row.score_components || {},
        },
      } : null;
    })
    .filter(Boolean);
}

async function seedCandidateTrackIds(db: Db, userId: string, seedId?: string | null): Promise<Set<string>> {
  let seedQuery = db.from("seeds")
    .select("id")
    .eq("user_id", userId)
    .eq("active", true);
  seedQuery = seedId
    ? seedQuery.eq("id", seedId)
    : seedQuery.order("created_at", { ascending: false }).limit(1);
  const seedResult = await seedQuery.maybeSingle();
  if (seedResult.error) throw new Error(`latest seed lookup: ${seedResult.error.message}`);
  if (!seedResult.data?.id) return new Set();

  const linksResult = await db.from("episode_seeds")
    .select("episode_id")
    .eq("seed_id", seedResult.data.id);
  const episodeIds = requireOk(linksResult, "latest seed episode lookup").map((row: any) => row.episode_id);
  if (!episodeIds.length) return new Set();

  const trackIds = new Set<string>();
  for (let start = 0; start < episodeIds.length; start += 300) {
    const tracksResult = await db.from("episode_tracks")
      .select("track_id")
      .in("episode_id", episodeIds.slice(start, start + 300));
    for (const row of requireOk(tracksResult, "latest seed candidate lookup")) {
      if (row.track_id) trackIds.add(row.track_id);
    }
  }
  return trackIds;
}

export async function applyUserSonicContext(
  db: Db,
  userId: string,
  candidates: QueueCandidate[],
  seedId?: string,
): Promise<QueueCandidate[]> {
  if (candidates.length === 0) return candidates;

  let seedQuery = db
    .from("seeds")
    .select("id, track_id, artist, title")
    .eq("user_id", userId)
    .eq("active", true)
    .not("track_id", "is", null);
  if (seedId) seedQuery = seedQuery.eq("id", seedId);

  const { data: seedRows, error: seedError } = await seedQuery.limit(seedId ? 1 : 12);
  if (seedError || !seedRows?.length) {
    if (seedError) console.warn("[sonic] active seed lookup failed; ranking remains neutral:", seedError.message);
    return candidates;
  }

  const seedTrackIds = seedRows.map((seed: any) => seed.track_id).filter(Boolean);
  if (seedTrackIds.length === 0) return candidates;

  let approvedTrackIds: string[] = [];
  let rejectedTrackIds: string[] = [];
  if (!seedId) {
    const feedbackResult = await db.from("user_tracks")
      .select("track_id,status")
      .eq("user_id", userId)
      .in("status", ["approved", "rejected"])
      .order("voted_at", { ascending: false })
      .limit(24);
    if (feedbackResult.error) {
      console.warn("[sonic] feedback lookup failed; using active seeds only:", feedbackResult.error.message);
    } else {
      approvedTrackIds = (feedbackResult.data || [])
        .filter((row: any) => row.status === "approved")
        .slice(0, 12)
        .map((row: any) => row.track_id);
      rejectedTrackIds = (feedbackResult.data || [])
        .filter((row: any) => row.status === "rejected")
        .slice(0, 12)
        .map((row: any) => row.track_id);
    }
  }

  const candidateTrackIds = candidates.map((candidate) => candidate.id);
  const matchNeighbors = async (referenceTrackIds: string[]) => {
    if (referenceTrackIds.length === 0) return { data: [], error: null };
    return db.rpc("match_user_sonic_neighbors", {
      p_user_id: userId,
      p_seed_track_ids: referenceTrackIds,
      p_candidate_track_ids: candidateTrackIds,
      p_limit: candidates.length,
      p_max_distance: Number(process.env.CLAP_MAX_DISTANCE || 0.65),
    });
  };
  const [positiveResult, negativeResult] = await Promise.all([
    matchNeighbors(Array.from(new Set([...seedTrackIds, ...approvedTrackIds]))),
    matchNeighbors(Array.from(new Set(rejectedTrackIds))),
  ]);
  if (positiveResult.error) {
    console.warn("[sonic] positive neighbor lookup failed; ranking remains neutral:", positiveResult.error.message);
    return candidates;
  }
  if (negativeResult.error) {
    console.warn("[sonic] rejection-neighbor lookup failed; rejection avoidance remains neutral:", negativeResult.error.message);
  }

  const toSimilarityMap = (rows: any[] | null | undefined) => {
    const similarities = new Map<string, number>();
    for (const row of rows || []) {
      const similarity = Number(row.sonic_similarity);
      if (row.track_id && Number.isFinite(similarity)) similarities.set(row.track_id, similarity);
    }
    return similarities;
  };
  const positiveSimilarities = toSimilarityMap(positiveResult.data);
  const negativeSimilarities = negativeResult.error ? new Map<string, number>() : toSimilarityMap(negativeResult.data);
  if (positiveSimilarities.size === 0 && negativeSimilarities.size === 0) return candidates;

  const seedName = seedRows.length === 1 && approvedTrackIds.length === 0
    ? [seedRows[0].artist, seedRows[0].title].filter(Boolean).join(" — ") || "your active seed"
    : approvedTrackIds.length > 0 ? "your active seeds and likes" : "your active seeds";
  const sourceSeedId = seedRows.length === 1 && approvedTrackIds.length === 0 ? seedRows[0].id : null;

  return candidates.map((candidate) => {
    const positiveSimilarity = positiveSimilarities.get(candidate.id);
    const negativeSimilarity = negativeSimilarities.get(candidate.id);
    if (positiveSimilarity == null && negativeSimilarity == null) return candidate;
    const ranked = applySonicAffinityRanking(candidate, positiveSimilarity, negativeSimilarity);
    return {
      ...ranked,
      metadata: {
        ...(ranked.metadata || {}),
        ...(positiveSimilarity == null ? {} : { _sonic_seed_name: seedName }),
        ...(sourceSeedId && positiveSimilarity != null ? { _sonic_seed_id: sourceSeedId } : {}),
      },
    };
  });
}

async function rankedTracks(db: Db, userId: string, limit: number, sonicSeedId?: string): Promise<QueueCandidate[]> {
  const eligibleTrackIds = await pendingUserTrackIds(db, userId);
  if (!eligibleTrackIds.length) return [];

  const candidates: QueueCandidate[] = [];
  for (let start = 0; start < eligibleTrackIds.length; start += 300) {
    const result = await db.from("user_track_scores")
      .select("score,confidence,components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .in("track_id", eligibleTrackIds.slice(start, start + 300));
    const rows = requireOk(result, "personalized track ranking");
    candidates.push(...rows.map((row: any) => {
      const track = Array.isArray(row.track) ? row.track[0] : row.track;
      if (!track) return null;
      return {
        ...track,
        taste_score: Number(row.score || 0),
        metadata: {
          ...(track.metadata || {}),
          _score_components: row.components || {},
          _score_confidence: Number(row.confidence || 0),
        },
      };
    }).filter(Boolean));
  }

  const seriesContextTrackIds = await seriesSeedContextTrackIds(
    db,
    userId,
    candidates.map((track) => track.id),
  );
  const contextualCandidates = await applyUserSonicContext(
    db,
    userId,
    applySeriesSeedContext(candidates, seriesContextTrackIds),
    sonicSeedId,
  );
  contextualCandidates.sort((left, right) =>
    Number(right.taste_score || 0) - Number(left.taste_score || 0)
      || Number((right.metadata as any)?._score_confidence || 0) - Number((left.metadata as any)?._score_confidence || 0)
      || String(left.id).localeCompare(String(right.id)),
  );

  return contextualCandidates.filter((track) => !isObviousPlaceholderCandidate(track)).slice(0, limit);
}

async function enrichQueueContexts(db: Db, candidates: QueueCandidate[]): Promise<QueueCandidate[]> {
  const episodesByTrack = new Map<string, Set<string>>();
  for (const track of candidates) {
    if (track.episode_id) episodesByTrack.set(track.id, new Set([track.episode_id]));
  }
  for (let start = 0; start < candidates.length; start += 300) {
    const result = await db.from("episode_tracks")
      .select("track_id,episode_id")
      .in("track_id", candidates.slice(start, start + 300).map((track) => track.id));
    for (const row of requireOk(result, "canonical queue episode lookup")) {
      const episodes = episodesByTrack.get(row.track_id) || new Set<string>();
      episodes.add(row.episode_id);
      episodesByTrack.set(row.track_id, episodes);
    }
  }

  const episodeIds = Array.from(new Set([...episodesByTrack.values()].flatMap((ids) => [...ids])));
  const contextByEpisode = new Map<string, string>();
  for (let start = 0; start < episodeIds.length; start += 300) {
    // Requires migration 025 (episodes.series_id) before this queue version runs.
    const result = await db.from("episodes")
      .select("id,series_id,source,url,title")
      .in("id", episodeIds.slice(start, start + 300));
    for (const episode of requireOk(result, "queue source context lookup")) {
      const context = episodeContextKey(episode);
      if (context) contextByEpisode.set(episode.id, context);
    }
  }

  return candidates.map((track) => {
    const episode_ids = [...(episodesByTrack.get(track.id) || [])];
    return {
      ...track,
      episode_ids,
      source_contexts: Array.from(new Set(episode_ids.flatMap((id) => {
        const context = contextByEpisode.get(id);
        return context ? [context] : [];
      }))),
    };
  });
}

export function applyRecentSkipNoveltyPressure(
  candidates: QueueCandidate[],
  recentSkipped: QueueCandidate[],
): QueueCandidate[] {
  if (!recentSkipped.length) return candidates;
  return candidates.map((candidate) => {
    const artistKeys = artistContextKeys(candidate);
    const episodeKeys = primaryEpisodeKeys(candidate);
    const sourceKeys = primaryShowKeys(candidate);
    let penalty = 0;
    recentSkipped.forEach((skipped, index) => {
      const decay = Math.exp(-index / 6);
      if (artistKeys.length && overlaps(artistKeys, artistContextKeys(skipped))) penalty += 0.025 * decay;
      if (episodeKeys.length && overlaps(episodeKeys, primaryEpisodeKeys(skipped))) penalty += 0.02 * decay;
      if (sourceKeys.length && overlaps(sourceKeys, primaryShowKeys(skipped))) penalty += 0.015 * decay;
    });
    penalty = Math.min(0.08, penalty);
    if (penalty <= 0) return candidate;
    const components = (candidate.metadata?._score_components as Record<string, unknown> | undefined) || {};
    const roundedPenalty = Math.round(penalty * 1000) / 1000;
    return {
      ...candidate,
      taste_score: Math.round((Number(candidate.taste_score || 0) - roundedPenalty) * 1000) / 1000,
      metadata: {
        ...(candidate.metadata || {}),
        _score_components: {
          ...components,
          novelty_cooldown: -roundedPenalty,
        },
      },
    };
  });
}

async function recentSkippedTracks(db: Db, userId: string): Promise<QueueCandidate[]> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const skippedResult = await db.from("user_tracks")
    .select("track_id,voted_at")
    .eq("user_id", userId)
    .eq("status", "skipped")
    .gte("voted_at", since)
    .order("voted_at", { ascending: false })
    .limit(20);
  const skippedIds = requireOk(skippedResult, "recent skipped-track lookup")
    .map((row: any) => row.track_id)
    .filter(Boolean);
  if (!skippedIds.length) return [];
  const trackResult = await db.from("tracks").select("*").in("id", skippedIds);
  const byId = new Map(requireOk(trackResult, "recent skipped-track context lookup")
    .map((track: QueueCandidate) => [track.id, track]));
  const ordered = skippedIds.map((id: string) => byId.get(id)).filter(Boolean) as QueueCandidate[];
  return enrichQueueContexts(db, ordered);
}

type SoulectionEpisode = {
  id: string;
  release_date?: string | null;
  aired_date?: string | null;
};

type SoulectionEntry = {
  episode_id: string;
  position: number;
  track_id: string | null;
  resolution_state: string;
  track: QueueCandidate | QueueCandidate[] | null;
};

function joinedTrack(value: SoulectionEntry["track"]): QueueCandidate | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function effectiveEpisodeTime(episode: SoulectionEpisode): number {
  return Date.parse(episode.release_date || episode.aired_date || "") || 0;
}

/**
 * Read a tiny ready-or-acquirable Soulection lane without creating taste state.
 * Episodes sort by effective date then id; tracks round-robin by source position.
 */
export async function soulectionExplorationCandidates(
  db: Db,
  userId: string,
): Promise<QueueCandidate[]> {
  const select = "id,release_date,aired_date";
  const [releasedResult, airedOnlyResult] = await Promise.all([
    db.from("episodes")
      .select(select)
      .eq("source", "soulection")
      .order("release_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(SOULECTION_EXPLORATION_EPISODE_LIMIT),
    db.from("episodes")
      .select(select)
      .eq("source", "soulection")
      .is("release_date", null)
      .order("aired_date", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(SOULECTION_EXPLORATION_EPISODE_LIMIT),
  ]);
  const episodeRows = [
    ...requireOk(releasedResult, "Soulection released episode lookup"),
    ...requireOk(airedOnlyResult, "Soulection aired episode lookup"),
  ] as SoulectionEpisode[];
  const episodes = [...new Map(episodeRows.map((episode) => [episode.id, episode])).values()]
    .sort((left, right) => effectiveEpisodeTime(right) - effectiveEpisodeTime(left)
      || left.id.localeCompare(right.id))
    .slice(0, SOULECTION_EXPLORATION_EPISODE_LIMIT);
  const episodeIds = episodes.map((episode) => episode.id);
  if (!episodeIds.length) return [];

  const entriesResult = await db.from("episode_track_entries")
    .select("episode_id,position,track_id,resolution_state,track:tracks!inner(*)")
    .in("episode_id", episodeIds)
    .eq("resolution_state", "canonical")
    .not("track_id", "is", null)
    .order("episode_id", { ascending: true })
    .order("position", { ascending: true });
  const episodeRank = new Map(episodeIds.map((id, index) => [id, index]));
  const entries = (requireOk(entriesResult, "Soulection canonical track lookup") as SoulectionEntry[])
    .filter((entry) => episodeRank.has(entry.episode_id))
    .filter((entry) => {
      const track = joinedTrack(entry.track);
      return Boolean(entry.track_id) && track?.id === entry.track_id
        && (Boolean(track.storage_path)
          || (typeof track.youtube_url === "string" && track.youtube_url.trim().length > 0));
    })
    .sort((left, right) => (episodeRank.get(left.episode_id)! - episodeRank.get(right.episode_id)!)
      || left.position - right.position
      || String(left.track_id).localeCompare(String(right.track_id)));
  const candidateIds = [...new Set(entries.map((entry) => entry.track_id).filter(Boolean))] as string[];
  if (!candidateIds.length) return [];

  const [actionedResult, seededResult] = await Promise.all([
    db.from("user_tracks")
      .select("track_id")
      .eq("user_id", userId)
      .in("track_id", candidateIds),
    db.from("seeds")
      .select("track_id")
      .eq("user_id", userId)
      .eq("active", true)
      .in("track_id", candidateIds),
  ]);
  const excluded = new Set([
    ...requireOk(actionedResult, "Soulection user exclusion lookup"),
    ...requireOk(seededResult, "Soulection seed exclusion lookup"),
  ].map((row: any) => row.track_id));
  const buckets = new Map(episodeIds.map((id) => [id, [] as SoulectionEntry[]]));
  for (const entry of entries) buckets.get(entry.episode_id)!.push(entry);
  const cursors = new Map(episodeIds.map((id) => [id, 0]));
  const seen = new Set<string>();
  const output: QueueCandidate[] = [];

  while (output.length < SOULECTION_EXPLORATION_TRACK_LIMIT) {
    let added = false;
    for (const episodeId of episodeIds) {
      const bucket = buckets.get(episodeId)!;
      let cursor = cursors.get(episodeId)!;
      let entry: SoulectionEntry | undefined;
      while (cursor < bucket.length) {
        const next = bucket[cursor++];
        if (next.track_id && !excluded.has(next.track_id) && !seen.has(next.track_id)) {
          entry = next;
          break;
        }
      }
      cursors.set(episodeId, cursor);
      if (!entry) continue;
      const track = joinedTrack(entry.track)!;
      seen.add(track.id);
      output.push({
        ...track,
        episode_id: entry.episode_id,
        metadata: { ...(track.metadata || {}), _series_exploration: true },
      });
      added = true;
      if (output.length === SOULECTION_EXPLORATION_TRACK_LIMIT) break;
    }
    if (!added) break;
  }
  return output;
}

/** Put exploration at the warm-window tail without shrinking the deeper queue. */
export function mergeSoulectionPreparationSlice(
  ordinary: QueueCandidate[],
  exploration: QueueCandidate[],
  target = QUEUE_TARGET,
  warmTarget = WARM_TARGET,
): QueueCandidate[] {
  const boundedTarget = Math.max(0, Math.floor(target));
  const boundedWarmTarget = Math.min(boundedTarget, Math.max(0, Math.floor(warmTarget)));
  const seen = new Set<string>();
  const boundedExploration = exploration.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  }).slice(0, Math.min(SOULECTION_EXPLORATION_TRACK_LIMIT, boundedWarmTarget));
  const explorationIds = new Set(boundedExploration.map((track) => track.id));
  const ordinaryWithoutExploration = ordinary.filter((track) => !explorationIds.has(track.id));
  const protectedLength = Math.max(0, boundedWarmTarget - boundedExploration.length);
  return [
    ...ordinaryWithoutExploration.slice(0, protectedLength),
    ...boundedExploration,
    ...ordinaryWithoutExploration.slice(protectedLength),
  ].slice(0, boundedTarget);
}

export async function listQueueUsers(db: Db = getSupabase()): Promise<string[]> {
  const [opinionsResult, seedsResult] = await Promise.all([
    db.from("user_tracks").select("user_id").not("user_id", "is", null),
    db.from("seeds").select("user_id").not("user_id", "is", null).eq("active", true),
  ]);
  const opinions = requireOk(opinionsResult, "queue user_tracks scan");
  const seeds = requireOk(seedsResult, "queue seeds scan");
  return Array.from(new Set([...opinions, ...seeds].map((row: any) => row.user_id).filter(Boolean)));
}

export async function materializeUserQueue(
  userId: string,
  db: Db = getSupabase(),
  target = QUEUE_TARGET,
  freshInsertions = 0,
  generationContext: {
    reason?: "ranking_refresh" | "seed_refresh";
    seedId?: string | null;
    seedRefreshRequiredAt?: string | null;
  } = {},
): Promise<number> {
  const queueTarget = Math.max(0, Math.floor(target));
  // Over-fetch before both quality filtering and diversification so a dominant
  // episode cannot narrow the warm candidate set before balancing happens.
  const explorationPromise = queueTarget
    ? soulectionExplorationCandidates(db, userId).catch((error) => {
        console.error(
          `[predictive-queue] Soulection exploration failed open for user ${userId}:`,
          error,
        );
        return [];
      })
    : Promise.resolve([]);
  const [ranked, exploration, eligibleTrackIds] = await Promise.all([
    rankedTracks(db, userId, queueTarget * 4, generationContext.seedId || undefined),
    explorationPromise,
    pendingUserTrackIds(db, userId),
  ]);
  const downloadable = ranked.filter(
    (track) => Boolean(track.storage_path) || Number(track.dl_attempts || 0) < MAX_DL_ATTEMPTS,
  );
  const [enrichedRanked, recentSkipped] = await Promise.all([
    enrichQueueContexts(db, downloadable),
    recentSkippedTracks(db, userId),
  ]);
  const noveltyRanked = applyRecentSkipNoveltyPressure(enrichedRanked, recentSkipped)
    .sort((left, right) => Number(right.taste_score || 0) - Number(left.taste_score || 0)
      || String(left.id).localeCompare(String(right.id)));
  const newlyRanked = diversifyQueueCandidates(noveltyRanked, queueTarget);
  const existingCandidates = await activeQueueCandidates(db, userId, new Set(eligibleTrackIds));
  const preferredFreshTrackIds = freshInsertions > 0
    ? await seedCandidateTrackIds(db, userId, generationContext.seedId)
    : undefined;
  const rankedForMerge = preferredFreshTrackIds
    ? [
        ...noveltyRanked.filter((track) => preferredFreshTrackIds.has(track.id)),
        ...newlyRanked,
      ]
    : newlyRanked;
  const ordinary = mergeStableQueueCandidates(
    existingCandidates,
    rankedForMerge,
    queueTarget,
    freshInsertions,
    5,
    preferredFreshTrackIds,
  );
  const unpacedTracks = mergeSoulectionPreparationSlice(ordinary, exploration, queueTarget, WARM_TARGET);
  // Stable queues, tangent insertion, and curated exploration all converge here.
  // Nothing can bypass the final near-term digging cadence.
  const tracks = paceQueueCandidates(unpacedTracks, queueTarget);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUEUE_TTL_DAYS * 86_400_000).toISOString();

  const existingResult = tracks.length
    ? await db.from("audio_preparation_queue")
        .select("track_id,state")
        .eq("user_id", userId)
        .in("track_id", tracks.map((track) => track.id))
    : { data: [], error: null };
  const existing = requireOk(existingResult, "existing preparation lookup");
  const stateByTrack = new Map(existing.map((row: any) => [row.track_id, row.state]));

  const rows = tracks.map((track, index) => {
    const previous = stateByTrack.get(track.id);
    const state = track.storage_path ? "ready" : previous === "preparing" ? "preparing" : "ranked";
    const scoringComponents = (track.metadata?._score_components as Record<string, unknown> | undefined) || {};
    const components = {
      ...scoringComponents,
      queue_original_rank: Number(track.metadata?._queue_original_rank || index + 1),
      queue_diversity_rank_delta: Number(track.metadata?._queue_diversity_rank_delta || 0),
    };
    return {
      user_id: userId,
      track_id: track.id,
      state,
      rank: index + 1,
      score: Number(track.taste_score || 0),
      score_components: components,
      scoring_version: QUEUE_VERSION,
      ranked_at: now.toISOString(),
      ready_at: track.storage_path ? now.toISOString() : null,
      expires_at: expiresAt,
      updated_at: now.toISOString(),
      last_error: null,
    };
  });

  if (rows.length) {
    const result = await db.from("audio_preparation_queue")
      .upsert(rows, { onConflict: "user_id,track_id" });
    if (result.error) throw new Error(`queue materialization: ${result.error.message}`);
  }

  // Retire every stale entry, including ready audio. Ready rows outside the
  // current ranking must not keep the predictive cache alive forever.
  const currentIds = new Set(rows.map((row) => row.track_id));
  const oldResult = await db.from("audio_preparation_queue")
    .select("track_id")
    .eq("user_id", userId)
    .in("state", ["ranked", "preparing", "ready"]);
  const oldRows = requireOk(oldResult, "stale queue lookup");
  const staleIds = oldRows.map((row: any) => row.track_id).filter((id: string) => !currentIds.has(id));
  if (staleIds.length) {
    const staleResult = await db.from("audio_preparation_queue")
      .update({ state: "consumed", consumed_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("user_id", userId)
      .in("track_id", staleIds);
    if (staleResult.error) throw new Error(`stale queue retirement: ${staleResult.error.message}`);
  }

  const tangent = preferredFreshTrackIds
    ? buildFypTangentDelta(existingCandidates, tracks, preferredFreshTrackIds, freshInsertions)
    : { trackIds: [], addedTrackIds: [], movedTrackIds: [], removedTrackIds: [], startRank: null };

  const shouldPublishTangent = freshInsertions > 0
    && generationContext.reason === "seed_refresh"
    && Boolean(generationContext.seedId)
    && Boolean(generationContext.seedRefreshRequiredAt)
    && tangent.trackIds.length > 0;
  const generationResult = shouldPublishTangent
    ? await db.rpc("publish_fyp_tangent", {
        p_user_id: userId,
        p_seed_id: generationContext.seedId,
        p_refresh_required_at: generationContext.seedRefreshRequiredAt,
        p_track_ids: tangent.trackIds,
        p_added_track_ids: tangent.addedTrackIds,
        p_moved_track_ids: tangent.movedTrackIds,
        p_removed_track_ids: tangent.removedTrackIds,
        p_start_rank: tangent.startRank,
      })
    : await db.rpc("publish_fyp_generation", {
        p_user_id: userId,
        p_reason: generationContext.reason || (freshInsertions > 0 ? "seed_refresh" : "ranking_refresh"),
        p_seed_id: generationContext.seedId || null,
      });
  if (generationResult.error) {
    throw new Error(`FYP generation publish: ${generationResult.error.message}`);
  }
  return rows.length;
}

export async function materializeAllQueues(db: Db = getSupabase()): Promise<{ users: number; tracks: number }> {
  const users = await listQueueUsers(db);
  let tracks = 0;
  for (const userId of users) tracks += await materializeUserQueue(userId, db);
  return { users: users.length, tracks };
}

const REASON_PRIORITY: Record<PreparationTrack["preparation_reason"], number> = {
  explicit_request: 0,
  predictive_queue: 1,
  permanent: 2,
  super_liked: 3,
  approved: 4,
  active_seed: 5,
};

export function orderPreparationTracks(tracks: PreparationTrack[]): PreparationTrack[] {
  return [...tracks].sort((a, b) =>
    REASON_PRIORITY[a.preparation_reason] - REASON_PRIORITY[b.preparation_reason]
    || a.preparation_rank - b.preparation_rank
    || String(a.id).localeCompare(String(b.id))
  );
}

export interface WarmQueueRow {
  user_id: string;
  track_id: string;
  state: "ranked" | "preparing" | "ready";
  rank: number;
}

/** Keep predictive preparation strictly inside each user's upcoming window. */
export function warmQueueRowsNeedingPreparation(
  rows: WarmQueueRow[],
  warmTarget = WARM_TARGET,
): WarmQueueRow[] {
  return rows.filter((row) => row.rank <= warmTarget && row.state !== "ready");
}

export async function selectPreparationBatch(
  db: Db = getSupabase(),
  limit = WARM_TARGET,
  force = false,
): Promise<PreparationTrack[]> {
  const now = new Date().toISOString();
  const [queueResult, opinionsResult, seedsResult, requestsResult] = await Promise.all([
    db.from("audio_preparation_queue")
      .select("user_id,track_id,state,rank")
      .in("state", ["ranked", "preparing", "ready"])
      .gt("expires_at", now)
      .lte("rank", WARM_TARGET)
      .order("rank", { ascending: true }),
    db.from("user_tracks")
      .select("user_id,track_id,status,super_liked,permanent,local_download_intent")
      .or("status.eq.approved,super_liked.eq.true,permanent.eq.true,local_download_intent.eq.true"),
    db.from("seeds").select("user_id,track_id").eq("active", true).not("track_id", "is", null),
    db.from("download_requests").select("track_id").in("status", ["pending", "downloading"]),
  ]);
  const queueRows = requireOk(queueResult, "preparation queue scan");
  const opinions = requireOk(opinionsResult, "retained user_tracks scan");
  const seeds = requireOk(seedsResult, "active seeds scan");
  const requests = requireOk(requestsResult, "pending download_requests scan");

  const queueEligible = warmQueueRowsNeedingPreparation(queueRows as WarmQueueRow[]);

  type PreparationIntent = Pick<PreparationTrack, "preparation_reason" | "preparation_rank" | "queue_user_ids">;
  const intent = new Map<string, PreparationIntent>();
  const setIntent = (trackId: string, reason: PreparationTrack["preparation_reason"], rank: number, userId?: string) => {
    const previous = intent.get(trackId);
    const users = new Set(previous?.queue_user_ids || []);
    if (userId) users.add(userId);
    if (!previous || REASON_PRIORITY[reason] < REASON_PRIORITY[previous.preparation_reason]) {
      intent.set(trackId, { preparation_reason: reason, preparation_rank: rank, queue_user_ids: Array.from(users) });
    } else {
      previous.queue_user_ids = Array.from(users);
      previous.preparation_rank = Math.min(previous.preparation_rank, rank);
    }
  };
  for (const row of queueEligible) setIntent(row.track_id, "predictive_queue", row.rank, row.user_id);
  for (const row of seeds) setIntent(row.track_id, "active_seed", 0, row.user_id);
  for (const row of opinions) {
    const reason = row.permanent || row.local_download_intent ? "permanent"
      : row.super_liked ? "super_liked" : "approved";
    setIntent(row.track_id, reason, 0, row.user_id);
  }
  for (const row of requests) setIntent(row.track_id, "explicit_request", 0);

  const ids = Array.from(intent.keys());
  if (!ids.length) return [];
  const tracksResult = await db.from("tracks").select("*")
    .in("id", ids)
    .is("storage_path", null)
    .not("youtube_url", "is", null)
    .neq("youtube_url", "");
  const tracks = requireOk(tracksResult, "preparation track lookup");
  const eligible = tracks
    .filter(isPreparationTrack)
    .filter((track) => force || Number(track.dl_attempts || 0) < MAX_DL_ATTEMPTS);
  return orderPreparationTracks(eligible.map((track) => ({ ...track, ...intent.get(track.id)! }))).slice(0, limit);
}

export function filterClaimedPreparationTracks(
  tracks: PreparationTrack[],
  claimedTrackIds: Iterable<string>,
): PreparationTrack[] {
  const claimed = new Set(claimedTrackIds);
  return tracks.filter((track) => claimed.has(track.id));
}

export async function claimPreparationTracks(
  tracks: PreparationTrack[],
  ownerToken: string,
  db: Db = getSupabase(),
  leaseSeconds = 900,
): Promise<PreparationTrack[]> {
  if (!tracks.length) return [];
  const result = await db.rpc("claim_audio_preparation_tracks", {
    p_track_ids: tracks.map((track) => track.id),
    p_owner_token: ownerToken,
    p_lease_seconds: leaseSeconds,
  });
  const rows = requireOk(result, "audio preparation claim");
  return filterClaimedPreparationTracks(tracks, rows.map((row: any) => row.track_id));
}

export async function releasePreparationTracks(
  tracks: Pick<PreparationTrack, "id">[],
  ownerToken: string,
  db: Db = getSupabase(),
): Promise<void> {
  if (!tracks.length) return;
  const result = await db.rpc("release_audio_preparation_tracks", {
    p_track_ids: tracks.map((track) => track.id),
    p_owner_token: ownerToken,
  });
  if (result.error) throw new Error(`audio preparation release: ${result.error.message}`);
}

export interface AudioEvictionResult {
  clearedPaths: number;
  removedPaths: number;
  leakedPaths: number;
}

/**
 * The RPC rechecks all protection references and clears track rows atomically.
 * Storage is deliberately removed second: a storage failure leaks an unreachable
 * object instead of leaving a playable row pointing at a missing object.
 */
export async function evictRetiredQueueAudio(db: Db = getSupabase()): Promise<AudioEvictionResult> {
  const result = await db.rpc("evict_retired_queue_audio", { p_warm_target: WARM_TARGET });
  const rows = requireOk(result, "retired queue audio eviction");
  const paths = Array.from(new Set(rows.map((row: any) => row.storage_path).filter(Boolean))) as string[];
  let removedPaths = 0;
  let leakedPaths = 0;
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100);
    const removal = await db.storage.from("tracks").remove(batch);
    if (removal.error) leakedPaths += batch.length;
    else removedPaths += batch.length;
  }
  return { clearedPaths: paths.length, removedPaths, leakedPaths };
}

export async function markPreparationState(
  track: PreparationTrack,
  state: "preparing" | "ready" | "failed",
  error: string | null = null,
  db: Db = getSupabase(),
): Promise<void> {
  if (!track.queue_user_ids.length) return;
  const now = new Date().toISOString();
  const timestamps = state === "preparing" ? { preparing_at: now }
    : state === "ready" ? { ready_at: now }
    : { failed_at: now };
  const result = await db.from("audio_preparation_queue")
    .update({ state, ...timestamps, last_error: error, updated_at: now })
    .eq("track_id", track.id)
    .in("user_id", track.queue_user_ids);
  if (result.error) throw new Error(`mark preparation ${state}: ${result.error.message}`);
  if (state === "ready") {
    const userIds = Array.from(new Set(track.queue_user_ids));
    const publications = await Promise.all(userIds.map((userId) => db.rpc("publish_fyp_generation", {
      p_user_id: userId,
      p_reason: "ranking_refresh",
      p_seed_id: null,
    })));
    publications.forEach((publication: any, index) => {
      if (publication.error) {
        // Readiness is already durable. A later queue reconciliation republishes
        // the generation, so notification failure must not mark playable audio failed.
        console.error(
          `[predictive-queue] ready generation publish failed for user ${userIds[index]}: ${publication.error.message}`,
        );
      }
    });
  }
}
