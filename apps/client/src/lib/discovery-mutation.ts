export type DiscoveryAction =
  | "skip"
  | "like"
  | "super_like"
  | "reject"
  | "seed"
  | "unseed"
  | "tangent"
  | "refresh";

export interface DiscoveryTrackRef {
  id: string;
  artist: string;
  title: string;
}

export interface DiscoveryQueueChange {
  position: number;
  outgoing: DiscoveryTrackRef | null;
  incoming: DiscoveryTrackRef | null;
  moved: DiscoveryTrackRef | null;
  fromPosition: number | null;
}

export interface DiscoveryMutation {
  id: string;
  action: DiscoveryAction;
  headline: string;
  detail: string;
  tone: "neutral" | "positive" | "strong" | "negative" | "branch";
  source: DiscoveryTrackRef | null;
  causalSeedId: string | null;
  outgoing: DiscoveryTrackRef | null;
  incoming: DiscoveryTrackRef | null;
  outgoingTracks: DiscoveryTrackRef[];
  incomingTracks: DiscoveryTrackRef[];
  queueChanges: DiscoveryQueueChange[];
  incomingIds: string[];
  createdAt: number;
}

const ACTION_COPY: Record<DiscoveryAction, Pick<DiscoveryMutation, "headline" | "detail" | "tone">> = {
  skip: {
    headline: "Keep digging",
    detail: "Retiring this track and widening the search — not treating it as dislike.",
    tone: "neutral",
  },
  like: {
    headline: "Leaning this way",
    detail: "Nearby sounds gain a little pull; this artist still gets breathing room.",
    tone: "positive",
  },
  super_like: {
    headline: "Strong signal",
    detail: "This pocket gains more pull without turning the queue into artist radio.",
    tone: "strong",
  },
  reject: {
    headline: "Moving away",
    detail: "This sonic pocket recedes from what comes next.",
    tone: "negative",
  },
  seed: {
    headline: "New branch planted",
    detail: "Growing outward from this exact track.",
    tone: "branch",
  },
  unseed: {
    headline: "Branch released",
    detail: "Future digging no longer follows this seed.",
    tone: "neutral",
  },
  tangent: {
    headline: "A tangent landed",
    detail: "A seed-derived branch changed the upcoming queue.",
    tone: "branch",
  },
  refresh: {
    headline: "The dig shifted",
    detail: "The upcoming queue changed with your latest signals.",
    tone: "neutral",
  },
};

export function beginDiscoveryMutation(
  action: DiscoveryAction,
  source: DiscoveryTrackRef | null,
  sequence: number,
  createdAt = Date.now(),
  causalSeedId: string | null = null,
): DiscoveryMutation {
  return {
    id: `${sequence}:${action}:${source?.id || "queue"}`,
    action,
    ...ACTION_COPY[action],
    source,
    causalSeedId,
    outgoing: action === "skip" || action === "reject" ? source : null,
    incoming: null,
    outgoingTracks: action === "skip" || action === "reject" ? (source ? [source] : []) : [],
    incomingTracks: [],
    queueChanges: [],
    incomingIds: [],
    createdAt,
  };
}

export function queueTrackChanges<T extends DiscoveryTrackRef>(
  previous: T[],
  next: T[],
  protectedTrackId?: string | null,
): { outgoing: T[]; incoming: T[]; queueChanges: DiscoveryQueueChange[] } {
  const previousIds = new Set(previous.map((track) => track.id));
  const nextIds = new Set(next.map((track) => track.id));
  const outgoing = previous.filter((track) =>
    track.id !== protectedTrackId && !nextIds.has(track.id)
  );
  const incoming = next.filter((track) => !previousIds.has(track.id));
  const outgoingIds = new Set(outgoing.map((track) => track.id));
  const incomingIds = new Set(incoming.map((track) => track.id));
  const queueChanges: DiscoveryQueueChange[] = [];
  const length = Math.max(previous.length, next.length);
  for (let index = 0; index < length; index++) {
    const previousTrack = previous[index];
    const nextTrack = next[index];
    const outgoingTrack = previousTrack && outgoingIds.has(previousTrack.id) ? previousTrack : null;
    const incomingTrack = nextTrack && incomingIds.has(nextTrack.id) ? nextTrack : null;
    if (outgoingTrack || incomingTrack) {
      queueChanges.push({
        position: index + 1,
        outgoing: outgoingTrack,
        incoming: incomingTrack,
        moved: null,
        fromPosition: null,
      });
    }
  }

  // A tangent can reorder existing material without adding or removing anything.
  // Report those exact moves instead of pretending the queue stayed unchanged.
  if (!outgoing.length && !incoming.length) {
    const previousPositions = new Map(previous.map((track, index) => [track.id, index + 1]));
    next.forEach((track, index) => {
      const fromPosition = previousPositions.get(track.id);
      const position = index + 1;
      if (fromPosition && fromPosition !== position && track.id !== protectedTrackId) {
        queueChanges.push({
          position,
          outgoing: null,
          incoming: null,
          moved: track,
          fromPosition,
        });
      }
    });
  }
  return { outgoing, incoming, queueChanges };
}

function shortTrack(track: DiscoveryTrackRef): string {
  return `${track.artist} — ${track.title}`;
}

export function shouldShowCompletedMutation(
  pendingCount: number,
  revealsTangent: boolean,
  activeMutationId: string | null,
): boolean {
  return pendingCount > 0 || revealsTangent || !activeMutationId;
}

export function correlatedPendingMutation(
  pending: DiscoveryMutation[],
  generation?: { reason: "ranking_refresh" | "seed_refresh"; seed_id: string | null },
): DiscoveryMutation | null {
  if (generation?.reason !== "seed_refresh" || !generation.seed_id) return null;
  return [...pending].reverse().find((event) =>
    event.action === "seed" && event.causalSeedId === generation.seed_id
  ) || null;
}

export function remainingPendingMutations(
  pending: DiscoveryMutation[],
  correlated: DiscoveryMutation | null,
): DiscoveryMutation[] {
  return pending.filter((event) =>
    event.action === "seed" && event.id !== correlated?.id
  );
}

export function completeDiscoveryMutation<T extends DiscoveryTrackRef>(
  pending: DiscoveryMutation | null,
  previous: T[],
  next: T[],
  sequence: number,
  options: {
    protectedTrackId?: string | null;
    tangentSeedName?: string | null;
    createdAt?: number;
  } = {},
): DiscoveryMutation | null {
  const changes = queueTrackChanges(previous, next, options.protectedTrackId);
  if (!changes.queueChanges.length) return null;

  const action: DiscoveryAction = options.tangentSeedName ? "tangent" : pending?.action || "refresh";
  const event = beginDiscoveryMutation(
    action,
    pending?.source || null,
    sequence,
    options.createdAt,
    pending?.causalSeedId || null,
  );
  const firstPairedChange = changes.queueChanges.find((change) => change.outgoing && change.incoming);
  const firstChange = firstPairedChange || changes.queueChanges[0];
  const outgoing = firstChange?.outgoing || null;
  const incoming = firstChange?.incoming || null;
  const moved = firstChange?.moved || null;
  let detail = event.detail;

  if (outgoing && incoming) {
    detail = `${shortTrack(outgoing)} out · ${shortTrack(incoming)} in`;
  } else if (incoming) {
    detail = `${shortTrack(incoming)} grew into the upcoming queue.`;
  } else if (outgoing) {
    detail = `${shortTrack(outgoing)} left the upcoming queue.`;
  } else if (moved && firstChange?.fromPosition) {
    detail = `${shortTrack(moved)} moved #${firstChange.fromPosition} → #${firstChange.position}.`;
  }
  if (options.tangentSeedName) detail += ` Branched from ${options.tangentSeedName}.`;

  return {
    ...event,
    headline: pending?.headline || (moved ? "The dig reordered" : event.headline),
    detail,
    tone: pending?.tone || event.tone,
    outgoing,
    incoming,
    outgoingTracks: changes.outgoing,
    incomingTracks: changes.incoming,
    queueChanges: changes.queueChanges,
    incomingIds: changes.incoming.map((track) => track.id),
  };
}
