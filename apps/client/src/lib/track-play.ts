export const PLAY_CHUNK_MS = 30_000;
export const MAX_SESSION_LISTENED_MS = 86_400_000;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PlayChunkBody {
  session_id: string;
  listened_ms: number;
}

export interface PlayChunkResult {
  session_listened_ms: number;
  qualified: boolean;
  play_count: number;
  total_listen_duration_ms: number;
  status: string;
}

interface RpcResult {
  data: PlayChunkResult[] | PlayChunkResult | null;
  error: { message: string } | null;
}

export interface TrackPlayDependencies {
  getUserId(request: Request): Promise<string | null>;
  recordChunk(args: {
    p_user_id: string;
    p_track_id: string;
    p_session_id: string;
    p_listened_ms: number;
  }): Promise<RpcResult>;
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export function parsePlayChunkBody(value: unknown): PlayChunkBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (!isCanonicalUuid(body.session_id)) return null;
  if (
    !Number.isSafeInteger(body.listened_ms)
    || (body.listened_ms as number) < PLAY_CHUNK_MS
    || (body.listened_ms as number) > MAX_SESSION_LISTENED_MS
    || (body.listened_ms as number) % PLAY_CHUNK_MS !== 0
  ) {
    return null;
  }
  return {
    session_id: body.session_id,
    listened_ms: body.listened_ms as number,
  };
}

/**
 * Build the authenticated play-chunk endpoint. `listened_ms` is cumulative for
 * one playback session, so retries and out-of-order reports remain idempotent.
 */
export function createTrackPlayHandler(dependencies: TrackPlayDependencies) {
  return async function trackPlay(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    const userId = await dependencies.getUserId(request);
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { id: trackId } = await context.params;
    if (!isCanonicalUuid(trackId)) {
      return Response.json({ error: "Track id must be a canonical UUID" }, { status: 400 });
    }

    const body = parsePlayChunkBody(await request.json().catch(() => null));
    if (!body) {
      return Response.json({
        error: `session_id must be a canonical UUID and listened_ms must be a positive ${PLAY_CHUNK_MS}ms chunk total`,
      }, { status: 400 });
    }

    const { data, error } = await dependencies.recordChunk({
      p_user_id: userId,
      p_track_id: trackId,
      p_session_id: body.session_id,
      p_listened_ms: body.listened_ms,
    });
    if (error) return Response.json({ error: error.message }, { status: 500 });

    const result = Array.isArray(data) ? data[0] : data;
    if (!result) {
      return Response.json({ error: "Play chunk was not persisted" }, { status: 500 });
    }
    return Response.json(result);
  };
}
