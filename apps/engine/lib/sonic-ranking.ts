export const MAX_SONIC_CONTRIBUTION = 0.1;
export const DEFAULT_SONIC_NEUTRAL_SIMILARITY = 0.5;

export interface SonicRankable {
  taste_score?: number | null;
  sonic_similarity?: number | null;
  metadata?: Record<string, any> | null;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

/** Maps cosine similarity around a neutral baseline into a strictly bounded score adjustment. */
export function sonicSimilarityContribution(
  similarity: number | null | undefined,
  maximum = MAX_SONIC_CONTRIBUTION,
  neutralSimilarity = DEFAULT_SONIC_NEUTRAL_SIMILARITY,
): number {
  if (similarity == null || !Number.isFinite(similarity)) return 0;
  const safeMaximum = clamp(Math.abs(maximum), 0, MAX_SONIC_CONTRIBUTION);
  const baseline = clamp(neutralSimilarity, -1, 1);
  const value = clamp(similarity, -1, 1);
  const availableRange = value >= baseline ? 1 - baseline : baseline + 1;
  if (availableRange <= 0) return 0;
  return clamp(((value - baseline) / availableRange) * safeMaximum, -safeMaximum, safeMaximum);
}

/**
 * Combines positive seed/like proximity with rejection avoidance. Being far
 * from a rejected region is neutral rather than a reward.
 */
export function sonicAffinityContribution(
  positiveSimilarity: number | null | undefined,
  negativeSimilarity: number | null | undefined,
): number {
  const toward = sonicSimilarityContribution(positiveSimilarity);
  const away = Math.max(0, sonicSimilarityContribution(negativeSimilarity));
  return clamp(toward - away, -MAX_SONIC_CONTRIBUTION, MAX_SONIC_CONTRIBUTION);
}

export function applySonicAffinityRanking<T extends SonicRankable>(
  candidate: T,
  positiveSimilarity: number | null | undefined,
  negativeSimilarity?: number | null,
): T {
  const contribution = sonicAffinityContribution(positiveSimilarity, negativeSimilarity);
  if (contribution === 0) return candidate;
  const metadata = candidate.metadata || {};
  return {
    ...candidate,
    taste_score: Number(candidate.taste_score || 0) + contribution,
    metadata: {
      ...metadata,
      _score_components: {
        ...(metadata._score_components || {}),
        // Store the normalized signed feature; the scorer applies the 0.10 weight.
        sonic_similarity: contribution / MAX_SONIC_CONTRIBUTION,
      },
      _sonic_similarity: positiveSimilarity,
      ...(negativeSimilarity == null ? {} : { _sonic_negative_similarity: negativeSimilarity }),
    },
  };
}

/** Adds explainable sonic context without mutating the candidate; missing embeddings are neutral. */
export function applySonicRanking<T extends SonicRankable>(candidate: T): T {
  return applySonicAffinityRanking(candidate, candidate.sonic_similarity, null);
}

export function rankWithSonicContext<T extends SonicRankable>(candidates: T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate: applySonicRanking(candidate), index }))
    .sort((left, right) =>
      Number(right.candidate.taste_score || 0) - Number(left.candidate.taste_score || 0)
      || left.index - right.index,
    )
    .map(({ candidate }) => candidate);
}
