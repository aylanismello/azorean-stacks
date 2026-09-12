import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RANKING_MODEL,
  MAX_RANKING_WEIGHT,
  MIN_EMPIRICAL_APPLY_SAMPLES,
  MIN_RANKING_WEIGHT,
  PRODUCTION_WEIGHT_TOTAL,
  RANKING_FEATURES,
  RANKING_FEATURE_SCHEMA_VERSION,
  buildChronologicalObservations,
  compareModels,
  fitRankingModel,
  hasMinimumEvidence,
  normalizeFeatures,
  normalizeWeights,
  rankingMetrics,
  rankingScore,
  type RankingObservation,
} from "./ranking-model";

const featureVector = (value: number) => Object.fromEntries(
  RANKING_FEATURES.map((feature) => [feature, value]),
) as Record<(typeof RANKING_FEATURES)[number], number>;

function observation(index: number, outcome: "approved" | "rejected" | "skipped", value: number): RankingObservation {
  return {
    exposureId: `exposure-${index}`,
    trackId: `track-${index}`,
    exposedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    outcomeAt: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
    outcome,
    features: featureVector(value),
    baselineScore: 0,
  };
}

describe("production scorer compatibility", () => {
  test("mirrors the production scorer's signed feature weights", () => {
    expect(DEFAULT_RANKING_MODEL).toEqual({
      version: "production_ranking_v1",
      intercept: 0,
      weights: {
        artist: 0.18,
        genre: 0.08,
        seed: 0.24,
        curator: 0.12,
        source_context: 0.18,
        episode_density: 0.12,
        co_occurrence: 0.08,
        sonic_similarity: 0.1,
      },
    });
    expect(rankingScore(DEFAULT_RANKING_MODEL, featureVector(1))).toBeCloseTo(PRODUCTION_WEIGHT_TOTAL, 12);
  });

  test("preserves signed evidence and treats missing/non-finite evidence as neutral", () => {
    expect(normalizeFeatures({ artist: 9, genre: -2, seed: Number.NaN, unknown: 1 })).toEqual({
      ...featureVector(0),
      artist: 1,
      genre: -1,
    });
  });

  test("projects fitted weights onto the bounded production-weight simplex", () => {
    const weights = normalizeWeights({ artist: 100, genre: -10, seed: Number.NaN });
    expect(Object.values(weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(PRODUCTION_WEIGHT_TOTAL, 12);
    for (const weight of Object.values(weights)) {
      expect(weight).toBeGreaterThanOrEqual(MIN_RANKING_WEIGHT);
      expect(weight).toBeLessThanOrEqual(MAX_RANKING_WEIGHT);
    }
  });
});

describe("chronological immutable observations", () => {
  test("joins an outcome only to its exact strictly earlier immutable exposure", () => {
    const observations = buildChronologicalObservations([
      { id: "future", trackId: "track", exposedAt: "2026-01-04T00:00:00Z", scoreComponents: { artist: 1 } },
      { id: "selected", trackId: "track", exposedAt: "2026-01-02T00:00:00Z", scoreComponents: { artist: -0.8 }, predictedScore: -0.3 },
      { id: "other", trackId: "track", exposedAt: "2026-01-01T00:00:00Z", scoreComponents: { artist: 0.8 } },
    ], [{ exposureId: "selected", trackId: "track", status: "approved", outcomeAt: "2026-01-03T00:00:00Z" }]);

    expect(observations).toHaveLength(1);
    expect(observations[0].exposureId).toBe("selected");
    expect(observations[0].features.artist).toBe(-0.8);
    expect(observations[0].baselineScore).toBe(-0.3);
  });

  test("fails closed on future, mismatched, duplicate, and incompatible pairs", () => {
    const exposures = [
      { id: "future", trackId: "track", exposedAt: "2026-01-02T00:00:00Z", scoreComponents: {} },
      { id: "mismatch", trackId: "track-a", exposedAt: "2026-01-01T00:00:00Z", scoreComponents: {} },
      { id: "duplicate", trackId: "track", exposedAt: "2026-01-01T00:00:00Z", scoreComponents: {} },
      { id: "old-schema", trackId: "track", exposedAt: "2026-01-01T00:00:00Z", scoreComponents: {}, featureSchemaVersion: "old" },
    ];
    const decisions = [
      { exposureId: "future", trackId: "track", status: "approved" as const, outcomeAt: "2026-01-01T00:00:00Z" },
      { exposureId: "mismatch", trackId: "track-b", status: "approved" as const, outcomeAt: "2026-01-02T00:00:00Z" },
      { exposureId: "duplicate", trackId: "track", status: "approved" as const, outcomeAt: "2026-01-02T00:00:00Z" },
      { exposureId: "duplicate", trackId: "track", status: "rejected" as const, outcomeAt: "2026-01-03T00:00:00Z" },
      { exposureId: "old-schema", trackId: "track", status: "approved" as const, outcomeAt: "2026-01-02T00:00:00Z" },
    ];
    expect(buildChronologicalObservations(exposures, decisions).map((row) => row.exposureId)).toEqual(["duplicate"]);
  });
});

describe("honest empirical evaluation", () => {
  test("computes AUC, Brier score, and class score means", () => {
    const metrics = rankingMetrics([1, 1, 0, 0], [0.9, 0.7, 0.4, 0.2]);
    expect(metrics.auc).toBe(1);
    expect(metrics.brier).toBeCloseTo(0.075, 12);
    expect(metrics.meanPositiveScore).toBeCloseTo(0.8, 12);
    expect(metrics.meanNegativeScore).toBeCloseTo(0.3, 12);
  });

  test("reports null AUC for a one-class evaluation instead of inventing one", () => {
    expect(rankingMetrics([1, 1], [0.6, 0.7]).auc).toBeNull();
  });

  test("fits only on the chronological prefix, never on holdout outcomes", () => {
    const training = Array.from({ length: 80 }, (_, index) => observation(
      index,
      index % 2 === 0 ? "approved" : "rejected",
      index % 2 === 0 ? 0.9 : -0.9,
    ));
    const holdoutA = Array.from({ length: 40 }, (_, offset) => observation(80 + offset, "approved", offset / 40));
    const holdoutB = holdoutA.map((row) => ({ ...row, outcome: "rejected" as const }));
    const options = { holdoutFraction: 1 / 3, minHoldout: 40, iterations: 100 };

    const fitA = fitRankingModel([...training, ...holdoutA], DEFAULT_RANKING_MODEL, options);
    const fitB = fitRankingModel([...training, ...holdoutB], DEFAULT_RANKING_MODEL, options);

    expect(fitA.trainSamples).toBe(80);
    expect(fitA.evaluationSamples).toBe(40);
    expect(fitA.model).toEqual(fitB.model);
    expect(fitA.comparison.after.brier).not.toBe(fitB.comparison.after.brier);
  });

  test("holds frozen non-model production score adjustments fixed in comparison", () => {
    const rows = [
      { ...observation(1, "approved", 1), baselineScore: 1.2 },
      { ...observation(2, "rejected", -1), baselineScore: -1.2 },
    ];
    const unchanged = compareModels(rows, DEFAULT_RANKING_MODEL, DEFAULT_RANKING_MODEL);
    expect(unchanged.brierDelta).toBeCloseTo(0, 12);
    expect(unchanged.before).toEqual(unchanged.after);
  });

  test("cannot lower or satisfy the production gate with duplicated or one-class evidence", () => {
    const balanced = Array.from({ length: MIN_EMPIRICAL_APPLY_SAMPLES }, (_, index) => observation(
      index,
      index % 2 === 0 ? "approved" : "rejected",
      index % 2 === 0 ? 1 : -1,
    ));
    expect(hasMinimumEvidence(balanced.slice(0, -1))).toBe(false);
    expect(hasMinimumEvidence(balanced.slice(0, -1), 1)).toBe(false);
    expect(hasMinimumEvidence(balanced)).toBe(true);
    expect(hasMinimumEvidence(balanced.map((row) => ({ ...row, outcome: "approved" })))).toBe(false);
    expect(hasMinimumEvidence(balanced.map((row) => ({ ...row, exposureId: "same" })))).toBe(false);
  });

  test("uses the declared feature schema for prospective evidence", () => {
    expect(RANKING_FEATURE_SCHEMA_VERSION).toBe("production_ranking_features_v1");
  });
});
