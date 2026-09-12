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

export interface DiscoveryMutation {
  id: string;
  action: DiscoveryAction;
  headline: string;
  detail: string;
  tone: "neutral" | "positive" | "strong" | "negative" | "branch";
  source: DiscoveryTrackRef | null;
  outgoing: DiscoveryTrackRef | null;
  incoming: DiscoveryTrackRef | null;
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
): DiscoveryMutation {
  return {
    id: `${sequence}:${action}:${source?.id || "queue"}`,
    action,
    ...ACTION_COPY[action],
    source,
    outgoing: action === "skip" || action === "reject" ? source : null,
    incoming: null,
    incomingIds: [],
    createdAt,
  };
}

export function queueTrackChanges<T extends DiscoveryTrackRef>(
  previous: T[],
  next: T[],
  protectedTrackId?: string | null,
): { outgoing: T[]; incoming: T[] } {
  const previousIds = new Set(previous.map((track) => track.id));
  const nextIds = new Set(next.map((track) => track.id));
  return {
    outgoing: previous.filter((track) =>
      track.id !== protectedTrackId && !nextIds.has(track.id)
    ),
    incoming: next.filter((track) => !previousIds.has(track.id)),
  };
}

function shortTrack(track: DiscoveryTrackRef): string {
  return `${track.artist} — ${track.title}`;
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
  if (!changes.outgoing.length && !changes.incoming.length) return pending;

  const action: DiscoveryAction = options.tangentSeedName ? "tangent" : pending?.action || "refresh";
  const event = beginDiscoveryMutation(action, pending?.source || null, sequence, options.createdAt);
  const outgoing = changes.outgoing[0] || pending?.outgoing || null;
  const incoming = changes.incoming[0] || null;
  let detail = event.detail;

  if (outgoing && incoming) {
    detail = `${shortTrack(outgoing)} out · ${shortTrack(incoming)} in`;
  } else if (incoming) {
    detail = `${shortTrack(incoming)} grew into the upcoming queue.`;
  } else if (outgoing) {
    detail = `${shortTrack(outgoing)} left the upcoming queue.`;
  }
  if (options.tangentSeedName) detail += ` Branched from ${options.tangentSeedName}.`;

  return {
    ...event,
    headline: pending?.headline || event.headline,
    detail,
    tone: pending?.tone || event.tone,
    outgoing,
    incoming,
    incomingIds: changes.incoming.map((track) => track.id),
  };
}
