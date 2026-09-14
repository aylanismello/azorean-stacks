export interface ImplicitSkipTrack {
  id: string;
  catalogTrackId?: string | null;
  vote_status?: string | null;
  status?: string | null;
  super_liked?: boolean;
  is_seed?: boolean;
  is_re_seed?: boolean;
  neutralSkipOnManualAdvance?: boolean;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const IMPLICIT_SKIP_EVENT = "stacks:implicit-skip";

export interface ImplicitSkipEventDetail {
  id: string;
  artist: string;
  title: string;
}

export interface ImplicitSkipResult {
  trackId: string;
  status: string;
  applied: boolean;
}

export type AdvanceReason = "manual" | "ended";

export function explicitDecisionOwnsAdvance(
  pendingCount: number,
  revisionAtStart: number,
  currentRevision: number,
): boolean {
  return pendingCount > 0 || currentRevision !== revisionAtStart;
}

/** A delayed manual-next request may only navigate if playback was not reselected. */
export function advanceRequestOwnsNavigation(
  selectionRevisionAtStart: number,
  currentSelectionRevision: number,
): boolean {
  return currentSelectionRevision === selectionRevisionAtStart;
}

/** Return a canonical ID only for an untouched discovery track. */
export function implicitSkipTrackId(
  track: ImplicitSkipTrack | null | undefined,
  reason: AdvanceReason = "manual",
): string | null {
  if (reason !== "manual") return null;
  if (!track?.neutralSkipOnManualAdvance) return null;
  if (track.super_liked || track.is_seed || track.is_re_seed) return null;
  const statuses = [track.vote_status, track.status].filter(Boolean);
  if (!statuses.includes("pending") || statuses.some((status) => status !== "pending")) return null;
  return track.catalogTrackId || track.id || null;
}

/** Persist manual next as the same taste-neutral outcome as explicit Skip. */
export async function persistImplicitSkip(
  track: ImplicitSkipTrack | null | undefined,
  fetcher: Fetcher = fetch,
): Promise<ImplicitSkipResult | null> {
  const trackId = implicitSkipTrackId(track);
  if (!trackId) return null;
  const response = await fetcher(`/api/tracks/${trackId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "skipped", implicit_skip: true }),
  });
  if (!response.ok) throw new Error(`Implicit skip failed (${response.status})`);
  const body = await response.json() as { status?: string; implicit_skip_applied?: boolean };
  return {
    trackId,
    status: body.status || "skipped",
    applied: body.implicit_skip_applied !== false,
  };
}
