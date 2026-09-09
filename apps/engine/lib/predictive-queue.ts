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

async function fallbackRankedTracks(db: Db, userId: string, limit: number): Promise<QueueCandidate[]> {
  const candidateResult = await db.from("tracks")
    .select("*")
    .eq("status", "pending")
    .order("taste_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(Math.max(limit * 3, limit));
  const candidates = requireOk(candidateResult, "fallback track ranking");
  if (!candidates.length) return [];

  const opinionsResult = await db.from("user_tracks")
    .select("track_id,status")
    .eq("user_id", userId)
    .in("track_id", candidates.map((track: any) => track.id));
  const opinions = requireOk(opinionsResult, "fallback user opinion lookup");
  const excluded = new Set(
    opinions.filter((row: any) => row.status !== "pending").map((row: any) => row.track_id),
  );
  return candidates.filter((track: any) => !excluded.has(track.id)).slice(0, limit);
}

async function rankedTracks(db: Db, userId: string, limit: number): Promise<QueueCandidate[]> {
  // Prefer truly per-user scores, including metadata-only candidates that have
  // not been downloaded yet. This is what makes predictive preparation useful.
  const personalized = await db.from("user_track_scores")
    .select("score,confidence,components,track:tracks!inner(*)")
    .eq("user_id", userId)
    .eq("track.status", "pending")
    .order("score", { ascending: false })
    .order("confidence", { ascending: false })
    .limit(Math.max(limit * 3, limit));

  if (!personalized.error && Array.isArray(personalized.data)) {
    const candidates = personalized.data
      .map((row: any) => {
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
      })
      .filter(Boolean) as QueueCandidate[];
    if (candidates.length) {
      const opinionsResult = await db.from("user_tracks")
        .select("track_id,status")
        .eq("user_id", userId)
        .in("track_id", candidates.map((track) => track.id));
      const opinions = requireOk(opinionsResult, "personalized queue opinion lookup");
      const excluded = new Set(opinions.filter((row: any) => row.status !== "pending").map((row: any) => row.track_id));
      return candidates.filter((track) => !excluded.has(track.id)).slice(0, limit);
    }
  } else if (!/could not find the table|does not exist|schema cache/i.test(personalized.error?.message || "")) {
    throw new Error(`personalized track ranking: ${personalized.error?.message}`);
  }

  // Migration-free fallback for staged rollout. This RPC generally returns
  // playable tracks only, so use it for continuity but supplement metadata-only
  // candidates from persisted legacy scores below.
  const rpc = await db.rpc("get_fyp_tracks", {
    p_user_id: userId,
    p_limit: limit,
    p_offset: 0,
    p_seed_id: null,
    p_genre: null,
    p_seed_artist: null,
    p_hide_low: false,
  });
  const rpcRows = !rpc.error && Array.isArray(rpc.data) ? rpc.data as QueueCandidate[] : [];
  const fallback = await fallbackRankedTracks(db, userId, limit);
  const merged = new Map<string, QueueCandidate>();
  for (const track of [...rpcRows, ...fallback]) if (!merged.has(track.id)) merged.set(track.id, track);
  if (merged.size) return Array.from(merged.values()).slice(0, limit);

  // Local schemas do not always contain the production RPC. Ranking remains available
  // from persisted taste_score rather than making queue maintenance fail closed.
  console.warn(`[queue] get_fyp_tracks unavailable for ${userId}; using taste_score fallback: ${rpc.error?.message || "invalid response"}`);
  return fallback;
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
  const tracks = await rankedTracks(db, userId, target);
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

  // Expire stale ranked entries from previous materializations without deleting history.
  const currentIds = new Set(rows.map((row) => row.track_id));
  const oldResult = await db.from("audio_preparation_queue")
    .select("track_id")
    .eq("user_id", userId)
    .in("state", ["ranked", "preparing"]);
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
  permanent: 1,
  super_liked: 2,
  approved: 3,
  active_seed: 4,
  predictive_queue: 5,
};

export function orderPreparationTracks(tracks: PreparationTrack[]): PreparationTrack[] {
  return [...tracks].sort((a, b) =>
    REASON_PRIORITY[a.preparation_reason] - REASON_PRIORITY[b.preparation_reason]
    || a.preparation_rank - b.preparation_rank
    || String(a.id).localeCompare(String(b.id))
  );
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

  const readyByUser = new Map<string, number>();
  for (const row of queueRows) {
    if (row.state === "ready") readyByUser.set(row.user_id, (readyByUser.get(row.user_id) || 0) + 1);
  }
  const queueEligible = queueRows.filter((row: any) => {
    if (row.state === "ready") return false;
    const ready = readyByUser.get(row.user_id) || 0;
    return ready < WARM_TARGET || ready < SAFETY_FLOOR;
  });

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
