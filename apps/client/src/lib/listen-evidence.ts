export interface QualifiedListenEvidence {
  status: "listened";
  listen_pct: number;
  listen_duration_ms: number;
}

const MAX_POSTGRES_INTEGER = 2_147_483_647;

/** Build the single PATCH payload emitted once playback reaches 80%. */
export function buildQualifiedListenEvidence(
  progressSeconds: number,
  durationSeconds: number,
): QualifiedListenEvidence | null {
  if (!Number.isFinite(progressSeconds) || !Number.isFinite(durationSeconds)) return null;
  if (progressSeconds <= 0 || durationSeconds <= 0 || progressSeconds / durationSeconds < 0.8) return null;

  return {
    status: "listened",
    listen_pct: Math.min(100, Math.round((progressSeconds / durationSeconds) * 100)),
    listen_duration_ms: Math.min(MAX_POSTGRES_INTEGER, Math.round(progressSeconds * 1000)),
  };
}

/** Validate evidence accepted by the listened API branch and database RPC. */
export function parseQualifiedListenEvidence(
  body: Record<string, unknown>,
): Omit<QualifiedListenEvidence, "status"> | null {
  const listenPct = body.listen_pct;
  const listenDurationMs = body.listen_duration_ms;
  if (!Number.isInteger(listenPct) || (listenPct as number) < 80 || (listenPct as number) > 100) return null;
  if (!Number.isInteger(listenDurationMs) || (listenDurationMs as number) < 0 || (listenDurationMs as number) > MAX_POSTGRES_INTEGER) return null;
  return {
    listen_pct: listenPct as number,
    listen_duration_ms: listenDurationMs as number,
  };
}
