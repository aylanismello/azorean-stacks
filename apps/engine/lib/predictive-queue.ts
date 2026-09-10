import { getSupabase } from "./supabase";

export const QUEUE_TARGET = Number(process.env.AUDIO_QUEUE_TARGET || 50);
export const WARM_TARGET = Number(process.env.AUDIO_WARM_TARGET || 20);
export const SAFETY_FLOOR = Number(process.env.AUDIO_SAFETY_FLOOR || 10);
export const QUEUE_VERSION = process.env.AUDIO_QUEUE_VERSION || "taste_score_v1";
const QUEUE_TTL_DAYS = Number(process.env.AUDIO_QUEUE_TTL_DAYS || 7);
const MAX_DL_ATTEMPTS = 3;

type Db = ReturnType<typeof getSupabase>;

export interface QueueCandidate {
  id: string;
  taste_score?: number | null;
  storage_path?: string | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: any;
}

export interface PreparationTrack extends QueueCandidate {
  preparation_reason: "explicit_request" | "permanent" | "super_liked" | "approved" | "active_seed" | "predictive_queue";
  preparation_rank: number;
  queue_user_ids: string[];
}

function requireOk(result: any, label: string): any[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return Array.isArray(result.data) ? result.data : [];
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
  return trackIds;
}

async function rankedTracks(db: Db, userId: string, limit: number): Promise<QueueCandidate[]> {
  const eligibleTrackIds = await pendingUserTrackIds(db, userId);
  if (!eligibleTrackIds.length) return [];

  const candidates: QueueCandidate[] = [];
  for (let start = 0; start < eligibleTrackIds.length; start += 300) {
    const result = await db.from("user_track_scores")
      .select("score,confidence,components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .in("track_id", eligibleTrackIds.slice(start, start + 300))
      .eq("track.status", "pending");
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

  candidates.sort((left, right) =>
    Number(right.taste_score || 0) - Number(left.taste_score || 0)
      || Number((right.metadata as any)?._score_confidence || 0) - Number((left.metadata as any)?._score_confidence || 0),
  );

  return candidates.slice(0, limit);
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
): Promise<number> {
  // Over-fetch before excluding exhausted downloads so failed tracks do not
  // occupy warm-cache slots forever. Explicit retries reset dl_attempts first.
  const ranked = await rankedTracks(db, userId, target * 3);
  const tracks = ranked
    .filter((track) => Boolean(track.storage_path) || Number(track.dl_attempts || 0) < MAX_DL_ATTEMPTS)
    .slice(0, target);
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
    const components = (track.metadata?._score_components as Record<string, unknown> | undefined) || {};
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
  const eligible = tracks.filter((track: any) => force || Number(track.dl_attempts || 0) < MAX_DL_ATTEMPTS);
  return orderPreparationTracks(eligible.map((track: any) => ({ ...track, ...intent.get(track.id)! }))).slice(0, limit);
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
}
