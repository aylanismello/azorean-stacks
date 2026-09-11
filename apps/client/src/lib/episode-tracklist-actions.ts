export type EpisodeTracklistAction =
  | "like"
  | "star"
  | "reject"
  | "skip"
  | "reseed"
  | "bad_source";

export interface EpisodeTracklistActionTrack {
  id: string;
  artist: string;
  title: string;
}

export interface EpisodeTracklistActionResult {
  voteStatus?: "approved" | "rejected" | "skipped" | "bad_source";
  superLiked?: boolean;
  seedId?: string | null;
}

export interface EpisodeTracklistRowIdentity {
  id: string;
  status?: string | null;
  appearance_id?: string | null;
  appearanceId?: string | null;
  catalogTrackId?: string | null;
  track?: { id: string } | null;
}

/** Never treat an unresolved episode appearance ID as a catalog track ID. */
export function canonicalEpisodeTracklistRowId(
  row: EpisodeTracklistRowIdentity,
  queuedCanonicalId?: string | null,
): string | null {
  if (row.track === null || row.status === "unresolved") return null;
  if (row.track?.id) return row.track.id;
  if (row.catalogTrackId) return row.catalogTrackId;
  if (queuedCanonicalId) return queuedCanonicalId;
  if (row.appearanceId || row.appearance_id) return null;
  return row.id || null;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

async function responseError(response: Pick<Response, "status" | "json">, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { error?: string };
    if (body.error) return new Error(body.error);
  } catch {
    // The status fallback remains useful for non-JSON failures.
  }
  return new Error(`${fallback} (${response.status})`);
}

/**
 * Persist a tracklist action without invoking any playback or queue operation.
 * Callers apply the returned annotation to their local and player-owned state.
 */
export async function performEpisodeTracklistAction(
  action: EpisodeTracklistAction,
  canonicalTrackId: string,
  track: EpisodeTracklistActionTrack,
  fetcher: Fetcher = fetch,
): Promise<EpisodeTracklistActionResult> {
  if (action === "reseed") {
    const response = await fetcher("/api/seeds/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_id: canonicalTrackId,
        artist: track.artist,
        title: track.title,
        action: "ensure",
      }),
    });
    if (!response.ok) throw await responseError(response, "Re-seed failed");
    const body = await response.json() as { seed_id?: string | null };
    return { seedId: body.seed_id ?? null };
  }

  const voteStatus = action === "like" || action === "star"
    ? "approved"
    : action === "reject"
      ? "rejected"
      : action === "skip"
        ? "skipped"
        : "bad_source";
  const payload = action === "star" ? { super_liked: true } : { status: voteStatus };
  const response = await fetcher(`/api/tracks/${canonicalTrackId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await responseError(response, `${action === "star" ? "Star" : "Vote"} failed`);

  return {
    voteStatus,
    // Every non-star vote clears super_liked in the API. Mirror that locally so
    // an ordinary Like cannot leave stale starred UI/player state behind.
    superLiked: action === "star",
  };
}
