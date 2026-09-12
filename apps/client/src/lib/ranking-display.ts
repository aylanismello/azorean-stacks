const SIGNAL_WEIGHTS: Record<string, number> = {
  artist: 0.18,
  genre: 0.08,
  seed: 0.24,
  curator: 0.12,
  source_context: 0.18,
  episode_density: 0.12,
  co_occurrence: 0.08,
  sonic_similarity: 0.1,
};

export function formatRankingScore(score: number): string {
  const sign = score > 0 ? "+" : "";
  return `ranking ${sign}${score.toFixed(3)}`;
}

/** Convert raw signal strengths into the contributions actually added to rank. */
export function rankingContributions(
  components: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!components) return undefined;

  return Object.fromEntries(Object.entries(components).map(([key, value]) => {
    const contribution = value * (SIGNAL_WEIGHTS[key] ?? 1);
    return [key, Math.round(contribution * 1000) / 1000];
  }));
}
