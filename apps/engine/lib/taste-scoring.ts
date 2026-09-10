export interface YieldAccumulator {
  positive: number;
  negative: number;
  samples: number;
  effectiveSamples: number;
}

export interface YieldEstimate {
  rate: number;
  signal: number;
  confidence: number;
  samples: number;
}

export interface EpisodeSeedLink {
  episode_id: string;
  seed_id: string;
  match_type?: string | null;
}

export interface SeedRecord {
  id: string;
  track_id?: string | null;
}

export interface TrackLineageInput {
  id: string;
  episode_id?: string | null;
  seed_track_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TrackEpisodeLink {
  track_id: string;
  episode_id: string;
}

export type ExplicitDecisionStatus = "approved" | "rejected" | "skipped" | "listened";

/** Deterministic explicit-label strength, with listening used only to qualify skips. */
export function explicitOutcomeWeight(
  status: ExplicitDecisionStatus,
  superLiked = false,
  listenPct?: number | null,
): number {
  if (superLiked) return 3;
  if (status === "approved") return 1;
  if (status === "rejected") return -1;
  if (status === "listened") {
    if (listenPct === null || listenPct === undefined || !Number.isFinite(listenPct) || listenPct < 80) return 0;
    return 0.15;
  }
  if (listenPct === null || listenPct === undefined || !Number.isFinite(listenPct)) return -0.3;
  const boundedListenPct = Math.max(0, Math.min(100, listenPct));
  // Known depth nudges a skip by at most 0.1 around the missing-depth default.
  return Math.round((-0.4 + boundedListenPct * 0.002) * 1000) / 1000;
}

export function indexTrackEpisodes(
  tracks: TrackLineageInput[],
  links: TrackEpisodeLink[]
): Map<string, Set<string>> {
  const episodesByTrack = new Map<string, Set<string>>();
  for (const link of links) {
    const episodes = episodesByTrack.get(link.track_id) || new Set<string>();
    episodes.add(link.episode_id);
    episodesByTrack.set(link.track_id, episodes);
  }
  // episode_tracks is canonical; keep the legacy pointer as an additional
  // appearance while older rows are still being migrated.
  for (const track of tracks) {
    if (!track.episode_id) continue;
    const episodes = episodesByTrack.get(track.id) || new Set<string>();
    episodes.add(track.episode_id);
    episodesByTrack.set(track.id, episodes);
  }
  return episodesByTrack;
}

export function emptyYield(): YieldAccumulator {
  return { positive: 0, negative: 0, samples: 0, effectiveSamples: 0 };
}

export function addYield(
  accumulator: YieldAccumulator,
  outcome: number,
  recencyWeight = 1
): void {
  if (outcome === 0) return;
  const weightedOutcome = Math.abs(outcome) * Math.max(0, recencyWeight);
  if (outcome > 0) accumulator.positive += weightedOutcome;
  else if (outcome < 0) accumulator.negative += weightedOutcome;
  accumulator.samples += 1;
  accumulator.effectiveSamples += Math.max(0, recencyWeight);
}

export function recencyWeight(
  timestamp: string | null | undefined,
  nowMs = Date.now(),
  halfLifeDays = 180
): number {
  if (!timestamp) return 1;
  const timestampMs = new Date(timestamp).getTime();
  if (!Number.isFinite(timestampMs)) return 1;
  const ageDays = Math.max(0, (nowMs - timestampMs) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Empirical-Bayes estimate, expressed as a -1..1 taste signal. */
export function estimateYield(
  accumulator: YieldAccumulator,
  priorRate: number,
  priorStrength = 4,
  minimumSupport = 3
): YieldEstimate | null {
  if (accumulator.effectiveSamples < minimumSupport) return null;
  const evidence = accumulator.positive + accumulator.negative;
  const boundedPrior = Math.min(1, Math.max(0, priorRate));
  const rate = evidence + priorStrength > 0
    ? (accumulator.positive + priorStrength * boundedPrior) / (evidence + priorStrength)
    : boundedPrior;
  return {
    rate,
    signal: Math.max(-1, Math.min(1, rate * 2 - 1)),
    confidence: accumulator.effectiveSamples / (accumulator.effectiveSamples + priorStrength),
    samples: Math.max(1, Math.round(accumulator.effectiveSamples)),
  };
}

export function resolveUserId(
  explicitUserId: string | null,
  detectedUserIds: Array<string | null | undefined>
): string {
  if (explicitUserId) return explicitUserId;
  const unique = Array.from(new Set(detectedUserIds.filter((id): id is string => !!id))).sort();
  if (unique.length === 1) return unique[0];
  if (unique.length === 0) {
    throw new Error("No user found in user_tracks; pass --user-id <uuid> after the user has voted.");
  }
  throw new Error(
    `Multiple users found (${unique.length}); pass --user-id <uuid> to prevent cross-user taste leakage.`
  );
}

function strongerMatchType(a: string | undefined, b: string | undefined): string {
  const strength: Record<string, number> = { unknown: 0, artist: 1, full: 2 };
  const left = a || "unknown";
  const right = b || "unknown";
  return (strength[right] ?? 0) > (strength[left] ?? 0) ? right : left;
}

/**
 * Build track → seed lineage from canonical episode_seeds plus direct legacy links.
 * Only seeds supplied in `seeds` are admitted, which enforces caller-side user scope.
 */
export function buildTrackSeedLineage(
  tracks: TrackLineageInput[],
  trackEpisodeLinks: TrackEpisodeLink[],
  episodeSeedLinks: EpisodeSeedLink[],
  seeds: SeedRecord[]
): Map<string, Map<string, string>> {
  const allowedSeedIds = new Set(seeds.map((seed) => seed.id));
  const seedIdsByTrackId = new Map<string, string[]>();
  for (const seed of seeds) {
    if (!seed.track_id) continue;
    const existing = seedIdsByTrackId.get(seed.track_id) || [];
    existing.push(seed.id);
    seedIdsByTrackId.set(seed.track_id, existing);
  }

  const episodesByTrack = indexTrackEpisodes(tracks, trackEpisodeLinks);

  const seedsByEpisode = new Map<string, EpisodeSeedLink[]>();
  for (const link of episodeSeedLinks) {
    if (!allowedSeedIds.has(link.seed_id)) continue;
    const existing = seedsByEpisode.get(link.episode_id) || [];
    existing.push(link);
    seedsByEpisode.set(link.episode_id, existing);
  }

  const result = new Map<string, Map<string, string>>();
  for (const track of tracks) {
    const lineage = new Map<string, string>();
    for (const episodeId of episodesByTrack.get(track.id) || []) {
      for (const link of seedsByEpisode.get(episodeId) || []) {
        lineage.set(link.seed_id, strongerMatchType(lineage.get(link.seed_id), link.match_type || "unknown"));
      }
    }

    const metadataSeedId = typeof track.metadata?.seed_id === "string" ? track.metadata.seed_id : null;
    if (metadataSeedId && allowedSeedIds.has(metadataSeedId)) {
      lineage.set(metadataSeedId, strongerMatchType(lineage.get(metadataSeedId), "unknown"));
    }
    if (track.seed_track_id) {
      for (const seedId of seedIdsByTrackId.get(track.seed_track_id) || []) {
        lineage.set(seedId, strongerMatchType(lineage.get(seedId), "full"));
      }
    }
    result.set(track.id, lineage);
  }
  return result;
}

/** Stable show/source key: NTS show slug, otherwise normalized source + title. */
export function episodeContextKey(episode: {
  series_id?: string | null;
  source?: string | null;
  url?: string | null;
  title?: string | null;
}): string | null {
  if (episode.series_id) return `series:${episode.series_id.toLowerCase()}`;
  const source = (episode.source || "").toLowerCase().trim();
  const url = episode.url || "";
  const ntsMatch = url.match(/\/shows\/([^/]+)(?:\/|$)/i);
  if (ntsMatch) return `nts:${ntsMatch[1].toLowerCase()}`;
  const title = (episode.title || "").toLowerCase().trim().replace(/\s+/g, " ");
  return source && title ? `${source}:${title}` : null;
}
