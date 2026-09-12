export const RANKING_FEATURE_KEYS = [
  "artist",
  "genre",
  "seed",
  "curator",
  "source_context",
  "episode_density",
  "co_occurrence",
  "sonic_similarity",
] as const;

export type RankingFeatureKey = typeof RANKING_FEATURE_KEYS[number];
export type RankingFeatureSnapshot = Record<RankingFeatureKey, number>;

export interface RankingExposureTrack {
  id: string;
  _display_rank?: number | null;
  _series_exploration?: boolean | null;
  _ranked_score?: number | null;
  _score_components?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(minimum, Math.min(maximum, parsed));
}

export function rankingFeatureSnapshot(track: RankingExposureTrack): RankingFeatureSnapshot {
  const metadata = track.metadata || {};
  const components = track._score_components
    || (metadata._score_components as Record<string, unknown> | undefined)
    || {};
  return Object.fromEntries(
    RANKING_FEATURE_KEYS.map((key) => [key, boundedNumber(components[key], -1, 1)]),
  ) as RankingFeatureSnapshot;
}

export function buildRankingExposureRows(
  userId: string,
  generation: number,
  tracks: RankingExposureTrack[],
) {
  const requestId = `fyp:${Math.max(0, Math.floor(generation))}`;
  return tracks.map((track, index) => ({
    user_id: userId,
    request_id: requestId,
    track_id: track.id,
    rank: Number.isInteger(track._display_rank) && Number(track._display_rank) > 0
      ? Number(track._display_rank)
      : index + 1,
    predicted_score: boundedNumber(track._ranked_score, -4, 4),
    model_version: track._series_exploration ? "series_exploration_v1" : "production_ranking_v1",
    feature_schema_version: "production_ranking_features_v1",
    score_components: rankingFeatureSnapshot(track),
  }));
}
